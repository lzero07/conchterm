//! 智能体 sidecar 桥接：管理 Python 子进程并转发 JSON Lines 流
//!
//! 架构说明：
//! - Rust 侧负责 spawn `agent/main.py`（长驻进程），通过 stdin/stdout 通信
//! - 协议见 agent/main.py 头注释；请求带 id，响应按 id 路由回对应前端 Channel
//! - API Key 存系统凭据管理器（keyring），仅在发送请求时注入 Python

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::ipc::Channel;
use tauri::State;

const KEYRING_SERVICE: &str = "ConchTerm";
const READY_TIMEOUT: Duration = Duration::from_secs(30);

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

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

/// Python 回传的 token 用量（usage_metadata 三键；缺省字段按 0 处理）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TokenUsage {
    #[serde(default)]
    pub input_tokens: i64,
    #[serde(default)]
    pub output_tokens: i64,
    #[serde(default)]
    pub total_tokens: i64,
}

/// Python -> 前端的事件（与 agent/main.py 的 JSON 协议一一对应）
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
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "tool_call")]
    ToolCall {
        id: String,
        #[serde(rename = "callId")]
        call_id: String,
        tool: String,
        args: serde_json::Value,
    },
    #[serde(rename = "models")]
    Models { id: String, models: Vec<String> },
}

impl AgentEvent {
    fn request_id(&self) -> Option<&str> {
        match self {
            AgentEvent::Delta { id, .. }
            | AgentEvent::Done { id, .. }
            | AgentEvent::Error { id, .. }
            | AgentEvent::ToolCall { id, .. }
            | AgentEvent::Models { id, .. } => Some(id),
            AgentEvent::Ready => None,
        }
    }
}

struct AgentProcess {
    child: Child,
    stdin: ChildStdin,
    /// 每次冷启动递增；用于退出清理时区分新旧进程
    generation: u64,
}

#[derive(Default)]
pub struct AgentState {
    process: Arc<Mutex<Option<AgentProcess>>>,
    pending: Arc<Mutex<HashMap<String, Channel<AgentEvent>>>>,
    /// 请求 id -> 归属信息（Provider/模型），done 落库时消费
    contexts: Arc<Mutex<HashMap<String, crate::usage_db::RequestContext>>>,
    spawn_lock: Arc<Mutex<()>>,
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

// ---------- Python sidecar 进程管理 ----------

/// 打包资源根目录（setup 阶段写入；各平台 resource 落点不同，见 agent_script）
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 记录 Tauri resource 目录，供生产态定位随包分发的 agent 脚本
pub fn set_resource_dir(dir: PathBuf) {
    let _ = RESOURCE_DIR.set(dir);
}

fn agent_script() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("CONCH_AGENT_SCRIPT") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(path);
        }
    }
    // 开发态：源码目录下的 agent/main.py
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../agent/main.py");
    if dev.exists() {
        return Some(dev);
    }
    // 生产态：bundle.resources 落点（macOS=Contents/Resources，Linux=/usr/lib/<app>）
    if let Some(dir) = RESOURCE_DIR.get() {
        let bundled = dir.join("agent/main.py");
        if bundled.exists() {
            return Some(bundled);
        }
    }
    // 生产态兜底：exe 同级目录（Windows NSIS/MSI 把 resources 放在 exe 旁）
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let bundled = exe_dir.join("agent/main.py");
    bundled.exists().then_some(bundled)
}

fn python_candidates() -> Vec<(String, Vec<String>)> {
    if let Ok(python) = std::env::var("CONCH_PYTHON") {
        return vec![(python, vec!["-X".into(), "utf8".into()])];
    }
    let utf8 = || vec!["-X".to_string(), "utf8".to_string()];
    vec![
        ("python".into(), utf8()),
        ("python3".into(), utf8()),
        ("py".into(), vec!["-3".into(), "-X".into(), "utf8".into()]),
    ]
}

/// 确保长驻 Python 进程存活；必要时按候选解释器逐个尝试冷启动
fn ensure_process(
    process: &Arc<Mutex<Option<AgentProcess>>>,
    pending: &Arc<Mutex<HashMap<String, Channel<AgentEvent>>>>,
    contexts: &Arc<Mutex<HashMap<String, crate::usage_db::RequestContext>>>,
    db: &crate::usage_db::UsageDb,
    spawn_lock: &Arc<Mutex<()>>,
) -> Result<(), String> {
    {
        let mut guard = process.lock().unwrap();
        if let Some(p) = guard.as_mut() {
            if matches!(p.child.try_wait(), Ok(None)) {
                return Ok(());
            }
        }
    }

    let _spawn_guard = spawn_lock.lock().unwrap();

    // 双重检查：等锁期间可能已被其他请求拉起
    {
        let mut guard = process.lock().unwrap();
        if let Some(p) = guard.as_mut() {
            if matches!(p.child.try_wait(), Ok(None)) {
                return Ok(());
            }
        }
    }

    let script = agent_script().ok_or_else(|| {
        "未找到智能体脚本 agent/main.py（可用环境变量 CONCH_AGENT_SCRIPT 指定路径）".to_string()
    })?;

    let mut last_error =
        "未找到可用的 Python，请安装 Python 3.9+ 或用 CONCH_PYTHON 指定解释器".to_string();

    for (exe, base_args) in python_candidates() {
        let mut args = base_args;
        args.push(script.to_string_lossy().into_owned());

        let mut child = match Command::new(&exe)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(_) => continue,
        };

        let stdout = child.stdout.take().expect("stdout 已设置为管道");
        let stderr = child.stderr.take().expect("stderr 已设置为管道");
        let stdin = child.stdin.take().expect("stdin 已设置为管道");

        // 后台排空 stderr，避免管道写满阻塞 Python
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut stderr = stderr;
            loop {
                match stderr.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => eprint!("{}", String::from_utf8_lossy(&buf[..n])),
                }
            }
        });

        let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
        let (ready_tx, ready_rx) = mpsc::channel::<bool>();
        spawn_reader(
            stdout,
            process.clone(),
            pending.clone(),
            contexts.clone(),
            db.clone(),
            generation,
            ready_tx,
        );

        match ready_rx.recv_timeout(READY_TIMEOUT) {
            Ok(true) => {
                let mut guard = process.lock().unwrap();
                guard.replace(AgentProcess {
                    child,
                    stdin,
                    generation,
                });
                return Ok(());
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                last_error = format!(
                    "无法启动智能体进程（{exe} 已退出，请确认已安装依赖: pip install -r agent/requirements.txt）"
                );
            }
        }
    }

    Err(last_error)
}

/// stdout 读取线程：解析事件并按 id 路由到对应前端的 Channel
fn spawn_reader(
    stdout: ChildStdout,
    process: Arc<Mutex<Option<AgentProcess>>>,
    pending: Arc<Mutex<HashMap<String, Channel<AgentEvent>>>>,
    contexts: Arc<Mutex<HashMap<String, crate::usage_db::RequestContext>>>,
    db: crate::usage_db::UsageDb,
    generation: u64,
    ready_tx: mpsc::Sender<bool>,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let mut ready = false;

        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(event) = serde_json::from_str::<AgentEvent>(trimmed) else {
                continue; // 忽略无法解析的输出行
            };
            if matches!(event, AgentEvent::Ready) {
                if !ready {
                    ready = true;
                    let _ = ready_tx.send(true);
                }
                continue;
            }
            let Some(id) = event.request_id().map(str::to_string) else {
                continue;
            };
            // 回合结束且带用量：消费请求归属信息，落一条用量记录
            if let AgentEvent::Done {
                id: done_id,
                usage: Some(usage),
            } = &event
            {
                let ctx = contexts.lock().unwrap().remove(done_id);
                if let Some(ctx) = ctx {
                    if let Err(e) = crate::usage_db::insert_usage(&db, &ctx, usage) {
                        eprintln!("记录 token 用量失败: {e}");
                    }
                }
            }
            let finished = matches!(
                event,
                AgentEvent::Done { .. } | AgentEvent::Error { .. } | AgentEvent::Models { .. }
            );
            let channel = pending.lock().unwrap().get(&id).cloned();
            if let Some(channel) = channel {
                let _ = channel.send(event);
            }
            if finished {
                pending.lock().unwrap().remove(&id);
                contexts.lock().unwrap().remove(&id);
            }
        }

        if !ready {
            let _ = ready_tx.send(false);
        }

        // 进程退出：只清理自己这一代，避免误删新生进程
        {
            let mut guard = process.lock().unwrap();
            if guard.as_ref().is_some_and(|p| p.generation == generation) {
                guard.take();
            }
        }

        let mut map = pending.lock().unwrap();
        for (_, channel) in map.drain() {
            let _ = channel.send(AgentEvent::Error {
                id: String::new(),
                message: "智能体进程已退出，请重试".into(),
            });
        }
        contexts.lock().unwrap().clear();
    });
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

    // 冷启动（拉起进程）可能耗时数秒，放到阻塞线程池执行
    let process = state.process.clone();
    let pending = state.pending.clone();
    let contexts = state.contexts.clone();
    let db_clone = db.inner().clone();
    let spawn_lock = state.spawn_lock.clone();
    let ensure = tokio::task::spawn_blocking(move || {
        ensure_process(&process, &pending, &contexts, &db_clone, &spawn_lock)
    })
    .await
    .map_err(|e| format!("智能体任务执行失败: {e}"))?;
    ensure?;

    let resolved_mode = mode.unwrap_or_else(|| "chat".into());
    let request_id = format!("r{}", NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed));
    let request = json!({
        "type": "chat",
        "id": request_id,
        "mode": resolved_mode,
        "max_rounds": max_rounds,
        "provider": {
            "protocol": provider.protocol,
            "base_url": provider.base_url,
            "model": provider.model,
            "api_key": api_key,
        },
        "messages": messages,
    });
    let line = format!("{request}\n");

    // 先注册回调与归属信息再写请求，避免早期 delta / done 丢失
    state
        .pending
        .lock()
        .unwrap()
        .insert(request_id.clone(), on_delta);
    state.contexts.lock().unwrap().insert(
        request_id.clone(),
        crate::usage_db::RequestContext {
            provider_id: provider.id.clone(),
            // 用量统计的展示名：名称缺失/为空时回退到 id，避免监控中心出现空来源
            provider_name: provider
                .name
                .clone()
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| provider.id.clone()),
            model: provider.model.clone(),
            protocol: provider.protocol.clone(),
            mode: resolved_mode,
        },
    );

    let write_result = {
        let mut guard = state.process.lock().unwrap();
        match guard.as_mut() {
            Some(p) => {
                if !matches!(p.child.try_wait(), Ok(None)) {
                    state.pending.lock().unwrap().remove(&request_id);
                    state.contexts.lock().unwrap().remove(&request_id);
                    return Err("智能体进程未运行，请重试".into());
                }
                p.stdin
                    .write_all(line.as_bytes())
                    .and_then(|_| p.stdin.flush())
            }
            None => {
                state.pending.lock().unwrap().remove(&request_id);
                state.contexts.lock().unwrap().remove(&request_id);
                Err(std::io::Error::other("进程未运行"))
            }
        }
    };
    if let Err(e) = write_result {
        state.pending.lock().unwrap().remove(&request_id);
        state.contexts.lock().unwrap().remove(&request_id);
        return Err(format!("发送聊天请求失败: {e}"));
    }

    Ok(request_id)
}

/// 前端把（已确认执行的）工具结果回传给 Python，唤醒 agent 循环
#[tauri::command]
pub fn agent_tool_result(
    state: State<'_, AgentState>,
    request_id: String,
    call_id: String,
    approved: bool,
    output: String,
) -> Result<(), String> {
    let _ = request_id; // 路由由 callId 承担；保留参数用于将来按请求校验
    let line = format!(
        "{}\n",
        json!({
            "type": "tool_result",
            "callId": call_id,
            "approved": approved,
            "output": output,
        })
    );
    let mut guard = state.process.lock().unwrap();
    match guard.as_mut() {
        Some(p) => p
            .stdin
            .write_all(line.as_bytes())
            .and_then(|_| p.stdin.flush())
            .map_err(|e| format!("发送工具结果失败: {e}")),
        None => Err("智能体进程未运行".into()),
    }
}

/// 拉取 Provider 可用模型列表：请求转发给 Python sidecar（/models 接口）
#[tauri::command]
pub async fn agent_list_models(
    state: State<'_, AgentState>,
    db: State<'_, crate::usage_db::UsageDb>,
    provider: AgentProviderInput,
    on_event: Channel<AgentEvent>,
) -> Result<String, String> {
    // 优先用前端直接带来的 Key（编辑表单里尚未保存的输入值），否则读凭据管理器
    let api_key = match provider.override_api_key {
        Some(key) if !key.trim().is_empty() => key.trim().to_string(),
        _ => read_api_key(&provider.id)?,
    };

    // 冷启动保护：sidecar 未运行时先拉起
    let process = state.process.clone();
    let pending = state.pending.clone();
    let contexts = state.contexts.clone();
    let db_clone = db.inner().clone();
    let spawn_lock = state.spawn_lock.clone();
    let ensure = tokio::task::spawn_blocking(move || {
        ensure_process(&process, &pending, &contexts, &db_clone, &spawn_lock)
    })
    .await
    .map_err(|e| format!("智能体任务执行失败: {e}"))?;
    ensure?;

    let request_id = format!("m{}", NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed));
    let request = json!({
        "type": "list_models",
        "id": request_id,
        "provider": {
            "protocol": provider.protocol,
            "base_url": provider.base_url,
            "model": provider.model,
            "api_key": api_key,
        },
    });
    let line = format!(
        "{request}
"
    );

    state
        .pending
        .lock()
        .unwrap()
        .insert(request_id.clone(), on_event);

    let write_result = {
        let mut guard = state.process.lock().unwrap();
        match guard.as_mut() {
            Some(p) => p
                .stdin
                .write_all(line.as_bytes())
                .and_then(|_| p.stdin.flush()),
            None => Err(std::io::Error::other("进程未运行")),
        }
    };
    if let Err(e) = write_result {
        state.pending.lock().unwrap().remove(&request_id);
        return Err(format!("发送模型列表请求失败: {e}"));
    }

    Ok(request_id)
}

#[tauri::command]
pub fn agent_cancel(state: State<'_, AgentState>, request_id: String) -> Result<(), String> {
    state.pending.lock().unwrap().remove(&request_id);
    state.contexts.lock().unwrap().remove(&request_id);
    Ok(())
}
