//! 智能体桥接：LLM 直连客户端的会话管理与事件路由（原 Python sidecar 的 Rust 替代）。
//!
//! 架构说明：
//! - 每个请求一个 tokio task，直接调 llm::LlmClient，事件经 Channel 回推前端
//! - 请求带 id，响应按 id 路由回对应前端 Channel
//! - API Key 存系统凭据管理器（keyring），仅在发起 HTTP 请求时使用
//! - Agent 模式的工具确认流：模型请求工具 -> 前端确认 -> agent_tool_result 唤醒循环

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex;

use crate::llm::{LlmClient, LlmConfig, LlmUsage};

const KEYRING_SERVICE: &str = "ConchTerm";

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

// Agent 模式的安全护栏（与原 Python 侧一致）
const DEFAULT_MAX_TOOL_ROUNDS: u32 = 8;
const TOOL_OUTPUT_LIMIT: usize = 8000;
const TOOL_WAIT_TIMEOUT: Duration = Duration::from_secs(120);

/// 前端传来的 Provider 配置（不含 API Key；检测接口例外，见 override_api_key）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderInput {
    pub id: String,
    /// Provider 显示名（用量统计落库用；旧前端可能不带）
    #[serde(default)]
    pub name: Option<String>,
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    /// 仅检测用：Provider 尚未保存时，前端直接带上表单里输入的 Key
    #[serde(default)]
    pub override_api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentChatMessage {
    pub role: String,
    pub content: String,
}

/// 供应商回传的 token 用量（三键；缺省字段按 0 处理）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TokenUsage {
    #[serde(default)]
    pub input_tokens: i64,
    #[serde(default)]
    pub output_tokens: i64,
    #[serde(default)]
    pub total_tokens: i64,
}

impl From<LlmUsage> for TokenUsage {
    fn from(u: LlmUsage) -> Self {
        Self {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            total_tokens: u.total_tokens,
        }
    }
}

/// Rust -> 前端的事件（结构不变，兼容原 Python sidecar 协议）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AgentEvent {
    #[serde(rename = "delta")]
    Delta { id: String, content: String },
    #[serde(rename = "done")]
    Done {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<TokenUsage>,
    },
    #[serde(rename = "error")]
    Error { id: String, message: String },
    #[serde(rename = "tool_call")]
    ToolCall {
        id: String,
        #[serde(rename = "callId")]
        call_id: String,
        tool: String,
        args: Value,
    },
    #[serde(rename = "models")]
    Models { id: String, models: Vec<String> },
}

/// 工具确认结果（前端 -> agent 循环）
struct ToolResult {
    approved: bool,
    output: String,
}

/// 一次在途请求的共享句柄（agent_tool_result / agent_cancel 摸到）
struct ActiveRequest {
    /// 取消标志：agent_cancel 置位后循环在下一个 await 点退出
    cancelled: Arc<AtomicBool>,
    /// call_id -> 等待工具确认的 waiter
    tool_waiters: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<ToolResult>>>>,
}

pub struct AgentState {
    client: LlmClient,
    requests: Arc<Mutex<HashMap<String, Arc<ActiveRequest>>>>,
}

impl AgentState {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            client: LlmClient::new()?,
            requests: Arc::new(Mutex::new(HashMap::new())),
        })
    }
}

// ---------- API Key（系统凭据管理器） ----------

fn keyring_entry(provider_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, provider_id)
        .map_err(|e| format!("无法访问系统凭据管理器: {e}"))
}

#[tauri::command]
pub fn agent_set_key(provider_id: String, api_key: String) -> Result<(), String> {
    keyring_entry(&provider_id)?
        .set_password(api_key.trim())
        .map_err(|e| format!("保存 API Key 失败: {e}"))
}

#[tauri::command]
pub fn agent_delete_key(provider_id: String) -> Result<(), String> {
    match keyring_entry(&provider_id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除 API Key 失败: {e}")),
    }
}

#[tauri::command]
pub fn agent_has_key(provider_id: String) -> Result<bool, String> {
    Ok(keyring_entry(&provider_id)?.get_password().is_ok())
}

fn read_api_key(provider_id: &str) -> Result<String, String> {
    keyring_entry(provider_id)?
        .get_password()
        .map_err(|_| format!("该 Provider 尚未配置 API Key（id: {provider_id}）"))
}

// ---------- 会话任务 ----------

/// 会话任务内部持有的上下文（从 ActiveRequest 拆出来搬到 task 里）
struct TaskCtx {
    request_id: String,
    channel: Channel<AgentEvent>,
    cancelled: Arc<AtomicBool>,
    tool_waiters: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<ToolResult>>>>,
    client: LlmClient,
    cfg: LlmConfig,
    /// done 落库用的归属信息
    context: crate::usage_db::RequestContext,
    db: crate::usage_db::UsageDb,
    /// 请求在 requests 表里的键（结束时移除）
    requests: Arc<Mutex<HashMap<String, Arc<ActiveRequest>>>>,
}

impl TaskCtx {
    /// 发事件给前端
    fn send(&self, event: AgentEvent) {
        let _ = self.channel.send(event);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    /// done：带用量时落库，最后清理在途表
    async fn finish(&self, usage: Option<TokenUsage>) {
        if let Some(u) = &usage {
            if let Err(e) = crate::usage_db::insert_usage(&self.db, &self.context, u) {
                eprintln!("记录 token 用量失败: {e}");
            }
        }
        self.send(AgentEvent::Done {
            id: self.request_id.clone(),
            usage,
        });
        self.requests.lock().await.remove(&self.request_id);
    }

    /// error：通知前端并清理
    async fn fail(&self, message: impl Into<String>) {
        self.send(AgentEvent::Error {
            id: self.request_id.clone(),
            message: message.into(),
        });
        self.requests.lock().await.remove(&self.request_id);
    }
}

// ---------- Agent 工具定义 ----------

/// 暴露给模型的工具 schema（两种协议都是「工具对象数组」，仅对象字段不同）
fn run_command_tool(protocol: &str) -> Value {
    if protocol == "anthropic" {
        // Anthropic: [{name, description, input_schema}]
        json!([{
            "name": "run_command",
            "description": "在用户的 SSH 会话中执行一条 shell 命令并返回输出（执行前需要用户确认）。",
            "input_schema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "要执行的 shell 命令" }
                },
                "required": ["command"]
            }
        }])
    } else {
        // OpenAI: [{type: function, function: {name, description, parameters}}]
        json!([{
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "在用户的 SSH 会话中执行一条 shell 命令并返回输出（执行前需要用户确认）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "要执行的 shell 命令" }
                    },
                    "required": ["command"]
                }
            }
        }])
    }
}

/// 把历史消息（含工具调用记录）转成协议各自的请求消息数组
/// - OpenAI: assistant 带 tool_calls / tool 角色回填
/// - Anthropic: assistant 带 tool_use block / user 带 tool_result block
fn history_to_messages(messages: &[AgentChatMessage], protocol: &str) -> Vec<Value> {
    if protocol != "anthropic" {
        return messages
            .iter()
            .map(|m| json!({ "role": m.role, "content": m.content }))
            .collect();
    }
    messages
        .iter()
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect()
}

// ---------- 聊天 / Agent 循环 ----------

async fn run_task(ctx: Arc<TaskCtx>, messages: Vec<AgentChatMessage>, mode: String, max_rounds: u32) {
    let result = if mode == "agent" {
        run_agent(ctx.clone(), messages, max_rounds).await
    } else {
        run_chat(ctx.clone(), messages).await
    };
    if let Err(message) = result {
        ctx.fail(message).await;
    }
}

/// 纯聊天模式：一次流式调用，delta 直通，done 带用量
async fn run_chat(ctx: Arc<TaskCtx>, messages: Vec<AgentChatMessage>) -> Result<(), String> {
    let msgs = history_to_messages(&messages, &ctx.cfg.protocol);
    let resp = ctx
        .client
        .chat(
            &ctx.cfg,
            &msgs,
            None,
            |part| {
                ctx.send(AgentEvent::Delta {
                    id: ctx.request_id.clone(),
                    content: part.to_string(),
                })
            },
        )
        .await?;
    ctx.finish(resp.usage.map(TokenUsage::from)).await;
    Ok(())
}

/// Agent 模式：工具调用循环，模型决定执行什么，前端确认后执行并回填
async fn run_agent(
    ctx: Arc<TaskCtx>,
    messages: Vec<AgentChatMessage>,
    max_rounds: u32,
) -> Result<(), String> {
    let mut msgs: Vec<Value> = history_to_messages(&messages, &ctx.cfg.protocol);
    let tools = run_command_tool(&ctx.cfg.protocol);
    let mut usage_total: Option<LlmUsage> = None;

    for _round in 0..max_rounds {
        if ctx.is_cancelled() {
            ctx.fail("已取消").await;
            return Ok(());
        }
        let resp = ctx
            .client
            .chat(
                &ctx.cfg,
                &msgs,
                Some(&tools),
                |part| {
                    ctx.send(AgentEvent::Delta {
                        id: ctx.request_id.clone(),
                        content: part.to_string(),
                    })
                },
            )
            .await?;
        usage_total = merge_usage(usage_total, resp.usage.clone());

        if resp.tool_calls.is_empty() {
            ctx.finish(usage_total.map(TokenUsage::from)).await;
            return Ok(());
        }

        // 本回合响应先入历史（协议各自的形态）
        msgs.push(assistant_tool_message(&ctx.cfg.protocol, &resp));

        for call in &resp.tool_calls {
            ctx.send(AgentEvent::ToolCall {
                id: ctx.request_id.clone(),
                call_id: call.id.clone(),
                tool: call.name.clone(),
                args: call.args.clone(),
            });
            let result = match wait_tool_result(&ctx, &call.id).await {
                Ok(r) => r,
                Err(_) => {
                    ctx.fail(format!("工具确认超时（{} 秒无响应）", TOOL_WAIT_TIMEOUT.as_secs())).await;
                    return Ok(());
                }
            };
            if ctx.is_cancelled() {
                ctx.fail("已取消").await;
                return Ok(());
            }
            let content = if result.approved {
                truncate_chars(&result.output, TOOL_OUTPUT_LIMIT)
            } else {
                "用户拒绝执行该命令。请勿再次尝试相同或相似的命令，改为向用户解释或询问下一步意愿。".to_string()
            };
            msgs.push(tool_result_message(&ctx.cfg.protocol, &call.id, &content));
        }
    }

    ctx.fail(format!("已达到最大工具调用轮数（{max_rounds}）")).await;
    Ok(())
}

/// 挂起等待前端回传该次工具调用的结果；超时或请求被清理则 Err
async fn wait_tool_result(ctx: &TaskCtx, call_id: &str) -> Result<ToolResult, ()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    ctx.tool_waiters.lock().await.insert(call_id.to_string(), tx);
    match tokio::time::timeout(TOOL_WAIT_TIMEOUT, rx).await {
        Ok(Ok(result)) => Ok(result),
        _ => {
            ctx.tool_waiters.lock().await.remove(call_id);
            Err(())
        }
    }
}

fn merge_usage(total: Option<LlmUsage>, inc: Option<LlmUsage>) -> Option<LlmUsage> {
    match (total, inc) {
        (None, None) => None,
        (Some(t), None) => Some(t),
        (None, Some(i)) => Some(i),
        (Some(mut t), Some(i)) => {
            t.input_tokens += i.input_tokens;
            t.output_tokens += i.output_tokens;
            t.total_tokens += i.total_tokens;
            Some(t)
        }
    }
}

/// 本回合 assistant 消息（带工具调用）入历史，按协议各自的形态
fn assistant_tool_message(protocol: &str, resp: &crate::llm::LlmResponse) -> Value {
    if protocol == "anthropic" {
        let mut blocks = Vec::new();
        if !resp.content.is_empty() {
            blocks.push(json!({ "type": "text", "text": resp.content }));
        }
        for call in &resp.tool_calls {
            blocks.push(json!({
                "type": "tool_use",
                "id": call.id,
                "name": call.name,
                "input": call.args,
            }));
        }
        json!({ "role": "assistant", "content": blocks })
    } else {
        let calls: Vec<Value> = resp
            .tool_calls
            .iter()
            .map(|c| {
                json!({
                    "id": c.id,
                    "type": "function",
                    "function": { "name": c.name, "arguments": c.args.to_string() }
                })
            })
            .collect();
        json!({
            "role": "assistant",
            "content": if resp.content.is_empty() { Value::Null } else { json!(resp.content) },
            "tool_calls": calls,
        })
    }
}

/// 工具结果消息入历史，按协议各自的形态
fn tool_result_message(protocol: &str, call_id: &str, content: &str) -> Value {
    if protocol == "anthropic" {
        json!({
            "role": "user",
            "content": [{ "type": "tool_result", "tool_use_id": call_id, "content": content }]
        })
    } else {
        json!({ "role": "tool", "tool_call_id": call_id, "content": content })
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}

// ---------- Tauri 命令 ----------

#[tauri::command]
pub async fn agent_chat(
    state: State<'_, AgentState>,
    db: State<'_, crate::usage_db::UsageDb>,
    provider: AgentProviderInput,
    messages: Vec<AgentChatMessage>,
    mode: Option<String>,
    max_rounds: Option<u32>,
    on_delta: Channel<AgentEvent>,
) -> Result<String, String> {
    let api_key = read_api_key(&provider.id)?;
    let resolved_mode = mode.unwrap_or_else(|| "chat".into());
    let rounds = max_rounds.unwrap_or(DEFAULT_MAX_TOOL_ROUNDS).clamp(5, 500);
    let request_id = format!("r{}", NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed));

    let ctx = Arc::new(TaskCtx {
        request_id: request_id.clone(),
        channel: on_delta,
        cancelled: Arc::new(AtomicBool::new(false)),
        tool_waiters: Arc::new(Mutex::new(HashMap::new())),
        client: state.client.clone(),
        cfg: LlmConfig {
            protocol: provider.protocol.clone(),
            base_url: provider.base_url.clone(),
            model: provider.model.clone(),
            api_key,
        },
        context: crate::usage_db::RequestContext {
            provider_id: provider.id.clone(),
            // 用量统计的展示名：名称缺失/为空时回退到 id，避免监控中心出现空来源
            provider_name: provider
                .name
                .clone()
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| provider.id.clone()),
            model: provider.model.clone(),
            protocol: provider.protocol.clone(),
            mode: resolved_mode.clone(),
        },
        db: db.inner().clone(),
        requests: state.requests.clone(),
    });

    state.requests.lock().await.insert(
        request_id.clone(),
        Arc::new(ActiveRequest {
            cancelled: ctx.cancelled.clone(),
            tool_waiters: ctx.tool_waiters.clone(),
        }),
    );

    let task_ctx = ctx.clone();
    tokio::spawn(async move {
        run_task(task_ctx, messages, resolved_mode, rounds).await;
    });

    Ok(request_id)
}

/// 前端把（已确认执行的）工具结果回传，唤醒 agent 循环
#[tauri::command]
pub async fn agent_tool_result(
    state: State<'_, AgentState>,
    request_id: String,
    call_id: String,
    approved: bool,
    output: String,
) -> Result<(), String> {
    let waiter = {
        let map = state.requests.lock().await;
        let Some(req) = map.get(&request_id) else {
            return Err("请求已结束或不存在".into());
        };
        let mut waiters = req.tool_waiters.lock().await;
        waiters.remove(&call_id)
    };
    match waiter {
        Some(tx) => tx
            .send(ToolResult { approved, output })
            .map_err(|_| "智能体循环已结束".to_string()),
        None => Err("该工具调用不存在或已超时".into()),
    }
}

/// 拉取 Provider 可用模型列表（直连 /models 接口）
#[tauri::command]
pub async fn agent_list_models(
    state: State<'_, AgentState>,
    provider: AgentProviderInput,
    on_event: Channel<AgentEvent>,
) -> Result<String, String> {
    // 优先用前端直接带来的 Key（编辑表单里尚未保存的输入值），否则读凭据管理器
    let api_key = match provider.override_api_key {
        Some(key) if !key.trim().is_empty() => key.trim().to_string(),
        _ => read_api_key(&provider.id)?,
    };
    let request_id = format!("m{}", NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed));
    let task_request_id = request_id.clone();

    let cfg = LlmConfig {
        protocol: provider.protocol.clone(),
        base_url: provider.base_url.clone(),
        model: provider.model.clone(),
        api_key,
    };
    let client = state.client.clone();

    tokio::spawn(async move {
        let event = match client.list_models(&cfg).await {
            Ok(models) => AgentEvent::Models {
                id: task_request_id.clone(),
                models,
            },
            Err(message) => AgentEvent::Error {
                id: task_request_id.clone(),
                message,
            },
        };
        let _ = on_event.send(event);
    });

    Ok(request_id)
}

#[tauri::command]
pub async fn agent_cancel(state: State<'_, AgentState>, request_id: String) -> Result<(), String> {
    if let Some(req) = state.requests.lock().await.remove(&request_id) {
        req.cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}
