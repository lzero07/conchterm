//! LLM 直连客户端：OpenAI 兼容与 Anthropic 两种协议的流式对话（原 Python sidecar 的替代）。
//!
//! - 统一入口 `stream_chat`：按协议构造请求，SSE 流式产出 `LlmEvent`
//! - OpenAI 兼容协议覆盖官方及 DeepSeek/Ollama/OpenRouter 等服务
//! - 工具调用不走这里（见 agent_bridge 的 agent 循环）：此处只管纯文本回合

use std::time::Duration;

use serde_json::{json, Value};

/// 一次 LLM 请求的完整配置（协议 + 端点 + 凭据）
#[derive(Debug, Clone)]
pub struct LlmConfig {
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}

/// 流式回合中产出的事件（与原 Python 侧 delta/usage 语义一致）
#[derive(Debug, Clone, Default)]
pub struct LlmUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
}

/// 一次非流式/回合结束的模型响应
#[derive(Debug, Clone)]
pub struct LlmResponse {
    pub content: String,
    pub tool_calls: Vec<LlmToolCall>,
    pub usage: Option<LlmUsage>,
}

#[derive(Debug, Clone)]
pub struct LlmToolCall {
    pub id: String,
    pub name: String,
    pub args: Value,
}

#[derive(Clone)]
pub struct LlmClient {
    http: reqwest::Client,
}

impl LlmClient {
    pub fn new() -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| format!("初始化 HTTP 客户端失败: {e}"))?;
        Ok(Self { http })
    }

    /// 流式聊天：对每个文本增量回调 `on_delta`，返回聚合后的完整响应。
    /// `tools` 非空时启用工具调用（Agent 模式），模型返回 tool_calls 而非继续输出文本。
    pub async fn chat(
        &self,
        cfg: &LlmConfig,
        messages: &[Value],
        tools: Option<&Value>,
        mut on_delta: impl FnMut(&str),
    ) -> Result<LlmResponse, String> {
        if cfg.protocol == "anthropic" {
            self.chat_anthropic(cfg, messages, tools, &mut on_delta)
                .await
        } else {
            self.chat_openai(cfg, messages, tools, &mut on_delta).await
        }
    }

    /// 拉取 Provider 可用模型列表（OpenAI /models 或 Anthropic /v1/models）
    pub async fn list_models(&self, cfg: &LlmConfig) -> Result<Vec<String>, String> {
        if cfg.protocol == "anthropic" {
            let url = join_url(&cfg.base_url, "/v1/models");
            let resp = self
                .http
                .get(&url)
                .header("x-api-key", &cfg.api_key)
                .header("anthropic-version", "2023-06-01")
                .send()
                .await
                .map_err(|e| format!("请求失败: {e}"))?;
            let models = check_status(resp)
                .await?
                .json::<Value>()
                .await
                .map_err(|e| format!("解析响应失败: {e}"))?;
            Ok(models["data"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| m["id"].as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default())
        } else {
            let url = join_url(&cfg.base_url, "/models");
            let resp = self
                .http
                .get(&url)
                .bearer_auth(&cfg.api_key)
                .send()
                .await
                .map_err(|e| format!("请求失败: {e}"))?;
            let models = check_status(resp)
                .await?
                .json::<Value>()
                .await
                .map_err(|e| format!("解析响应失败: {e}"))?;
            Ok(models["data"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| m["id"].as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default())
        }
    }

    // ---------- OpenAI 兼容协议 ----------

    async fn chat_openai(
        &self,
        cfg: &LlmConfig,
        messages: &[Value],
        tools: Option<&Value>,
        on_delta: &mut impl FnMut(&str),
    ) -> Result<LlmResponse, String> {
        let url = join_url(&cfg.base_url, "/chat/completions");
        let mut body = json!({
            "model": cfg.model,
            "messages": messages,
            "stream": true,
            // 请求在最后一个流式 chunk 中返回 usage（监控中心统计 token 用量）
            "stream_options": { "include_usage": true },
        });
        if let Some(tools) = tools {
            body["tools"] = tools.clone();
        }

        let resp = self
            .http
            .post(&url)
            .bearer_auth(&cfg.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("请求失败: {e}"))?;
        let resp = check_status(resp).await?;

        let mut text = String::new();
        let mut usage = None;
        // tool_calls 流式分片：index -> (id, name, 参数 JSON 片段)
        let mut tool_calls: Vec<(String, String, String)> = Vec::new();
        let mut tool_index_max: i64 = -1;

        let mut sse = SseStream::new(resp);
        while let Some(event) = sse.next_event().await? {
            let chunk = match serde_json::from_str::<Value>(&event) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if chunk["choices"].is_null() {
                // 部分兼容服务把 usage 放在无 choices 的末尾 chunk
                if !chunk["usage"].is_null() {
                    usage = parse_usage_openai(&chunk["usage"]);
                }
                continue;
            }
            if let Some(u) = chunk["usage"].as_object() {
                if !u.is_empty() {
                    usage = parse_usage_openai(&chunk["usage"]);
                }
            }
            let Some(choice) = chunk["choices"].as_array().and_then(|c| c.first()) else {
                continue;
            };
            let delta = &choice["delta"];
            if let Some(part) = delta["content"].as_str() {
                if !part.is_empty() {
                    text.push_str(part);
                    on_delta(part);
                }
            }
            if let Some(fragments) = delta["tool_calls"].as_array() {
                for frag in fragments {
                    let index = frag["index"].as_i64().unwrap_or(0);
                    if index > tool_index_max {
                        tool_index_max = index;
                        tool_calls.push((String::new(), String::new(), String::new()));
                    }
                    let slot = &mut tool_calls[index as usize];
                    if let Some(id) = frag["id"].as_str() {
                        if !id.is_empty() {
                            slot.0 = id.to_string();
                        }
                    }
                    if let Some(name) = frag["function"]["name"].as_str() {
                        if !name.is_empty() {
                            slot.1.push_str(name);
                        }
                    }
                    if let Some(args) = frag["function"]["arguments"].as_str() {
                        slot.2.push_str(args);
                    }
                }
            }
        }

        let calls = tool_calls
            .into_iter()
            .filter(|(_, name, _)| !name.is_empty())
            .map(|(id, name, args)| LlmToolCall {
                id,
                name,
                args: serde_json::from_str(&args).unwrap_or(json!({})),
            })
            .collect();

        Ok(LlmResponse {
            content: text,
            tool_calls: calls,
            usage,
        })
    }

    // ---------- Anthropic 协议 ----------

    async fn chat_anthropic(
        &self,
        cfg: &LlmConfig,
        messages: &[Value],
        tools: Option<&Value>,
        on_delta: &mut impl FnMut(&str),
    ) -> Result<LlmResponse, String> {
        let url = join_url(&cfg.base_url, "/v1/messages");
        // Anthropic 的 system 是顶层参数，不在 messages 里
        let system: Vec<&str> = messages
            .iter()
            .filter(|m| m["role"] == "system")
            .filter_map(|m| m["content"].as_str())
            .collect();
        let turns: Vec<&Value> = messages.iter().filter(|m| m["role"] != "system").collect();

        let mut body = json!({
            "model": cfg.model,
            "max_tokens": 4096,
            "messages": turns,
            "stream": true,
        });
        if !system.is_empty() {
            body["system"] = json!(system.join("\n\n"));
        }
        if let Some(tools) = tools {
            body["tools"] = tools.clone();
        }

        let resp = self
            .http
            .post(&url)
            .header("x-api-key", &cfg.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("请求失败: {e}"))?;
        let resp = check_status(resp).await?;

        let mut text = String::new();
        let mut usage = LlmUsage::default();
        let mut has_usage = false;
        let mut tool_calls: Vec<LlmToolCall> = Vec::new();
        // content_block_delta 的 input_json_delta 按 index 归位到对应 block
        let mut block_index_to_call: Vec<Option<usize>> = Vec::new();

        let mut sse = SseStream::new(resp);
        while let Some(event) = sse.next_event().await? {
            let chunk = match serde_json::from_str::<Value>(&event) {
                Ok(v) => v,
                Err(_) => continue,
            };
            match chunk["type"].as_str().unwrap_or("") {
                "content_block_start" => {
                    let index = chunk["index"].as_u64().unwrap_or(0) as usize;
                    while block_index_to_call.len() <= index {
                        block_index_to_call.push(None);
                    }
                    let block = &chunk["content_block"];
                    if block["type"] == "tool_use" {
                        tool_calls.push(LlmToolCall {
                            id: block["id"].as_str().unwrap_or("").to_string(),
                            name: block["name"].as_str().unwrap_or("").to_string(),
                            args: json!({}),
                        });
                        block_index_to_call[index] = Some(tool_calls.len() - 1);
                    }
                }
                "content_block_delta" => {
                    let delta = &chunk["delta"];
                    if let Some(part) = delta["text"].as_str() {
                        if !part.is_empty() {
                            text.push_str(part);
                            on_delta(part);
                        }
                    }
                    if let Some(args) = delta["partial_json"].as_str() {
                        let index = chunk["index"].as_u64().unwrap_or(0) as usize;
                        if let Some(Some(slot)) = block_index_to_call.get(index) {
                            // 累积到 args 的临时字符串，结束后统一解析
                            let call = &mut tool_calls[*slot];
                            let raw = call.args.as_str().unwrap_or("").to_string() + args;
                            call.args = Value::String(raw);
                        }
                    }
                }
                "message_delta" => {
                    // 输出 token 用量在结束帧；输入用量在 message_start，两者合并
                    if let Some(u) = chunk["usage"]["output_tokens"].as_i64() {
                        usage.output_tokens = u;
                        has_usage = true;
                    }
                }
                "message_start" => {
                    if let Some(u) = chunk["message"]["usage"]["input_tokens"].as_i64() {
                        usage.input_tokens = u;
                        has_usage = true;
                    }
                }
                _ => {}
            }
        }

        // partial_json 累积字符串 -> 真正的参数对象
        for call in &mut tool_calls {
            if let Some(raw) = call.args.as_str() {
                call.args = serde_json::from_str(raw).unwrap_or(json!({}));
            }
        }
        if has_usage {
            usage.total_tokens = usage.input_tokens + usage.output_tokens;
        }

        Ok(LlmResponse {
            content: text,
            tool_calls,
            usage: if has_usage { Some(usage) } else { None },
        })
    }
}

// ---------- SSE 解析 ----------

/// 极简 SSE 分帧器：逐行扫描，空行界定事件，提取 data: 行，处理半包与 [DONE]
struct SseStream {
    resp: reqwest::Response,
    framer: SseFramer,
}

impl SseStream {
    fn new(resp: reqwest::Response) -> Self {
        Self {
            resp,
            framer: SseFramer::default(),
        }
    }

    /// 返回下一个 data 负载；流结束（含 [DONE]）返回 None
    async fn next_event(&mut self) -> Result<Option<String>, String> {
        loop {
            if let Some(data) = self.framer.take_event() {
                if data == "[DONE]" {
                    return Ok(None);
                }
                if !data.is_empty() {
                    return Ok(Some(data));
                }
                continue;
            }
            match self.resp.chunk().await {
                Ok(Some(chunk)) => {
                    let text = String::from_utf8_lossy(&chunk);
                    self.framer.push_str(&text);
                }
                Ok(None) => {
                    // 流结束：残余半行与已累积 data 一并结算
                    self.framer.flush();
                    return match self.framer.take_event() {
                        Some(data) if data != "[DONE]" && !data.is_empty() => Ok(Some(data)),
                        _ => Ok(None),
                    };
                }
                Err(e) => return Err(format!("读取流失败: {e}")),
            }
        }
    }
}

/// 纯状态机：喂入任意切块的 SSE 文本，产出完整事件的 data 负载
/// （与网络解耦，便于单测半包/多行 data/keep-alive 等边界）
#[derive(Default)]
struct SseFramer {
    /// 已接收未换行的尾部（半行）
    pending_line: String,
    /// 当前事件累积的 data 行
    data_lines: Vec<String>,
    /// 空行到达时结算出的完整事件队列，等消费者取走
    ready_events: std::collections::VecDeque<String>,
}

impl SseFramer {
    /// 喂入一段文本（任意切块边界都安全）
    fn push_str(&mut self, text: &str) {
        for ch in text.chars() {
            if ch == '\n' {
                let line = std::mem::take(&mut self.pending_line);
                self.handle_line(&line);
            } else {
                self.pending_line.push(ch);
            }
        }
    }

    /// 流结束时调用：把残余半行按完整行结算
    fn flush(&mut self) {
        let line = std::mem::take(&mut self.pending_line);
        self.handle_line(&line);
        // 无空行收尾的尾部事件也交付
        if !self.data_lines.is_empty() {
            self.ready_events
                .push_back(std::mem::take(&mut self.data_lines).join("\n"));
        }
    }

    /// 取走一个已完整接收的事件；没有则 None
    fn take_event(&mut self) -> Option<String> {
        self.ready_events.pop_front()
    }

    /// 一行完成：空行 = 事件边界（结算当前事件）；data: 行累积进当前事件
    fn handle_line(&mut self, line: &str) {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            if !self.data_lines.is_empty() {
                self.ready_events
                    .push_back(std::mem::take(&mut self.data_lines).join("\n"));
            }
            return;
        }
        if let Some(data) = line.strip_prefix("data:") {
            self.data_lines
                .push(data.strip_prefix(' ').unwrap_or(data).to_string());
        }
        // 注释行（: keep-alive）与非 data 字段忽略
    }
}

// ---------- 工具函数 ----------

/// 拼接 base_url 与路径：容忍带/不带尾斜杠、base 已含路径（如 /v1）的情况
fn join_url(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    format!("{base}{path}")
}

fn parse_usage_openai(usage: &Value) -> Option<LlmUsage> {
    let u = usage.as_object()?;
    if u.is_empty() {
        return None;
    }
    let input = usage["prompt_tokens"].as_i64().unwrap_or(0);
    let output = usage["completion_tokens"].as_i64().unwrap_or(0);
    let total = usage["total_tokens"].as_i64().unwrap_or(input + output);
    Some(LlmUsage {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
    })
}

/// 把非 2xx 响应转成带 body 摘要的可读消息（供应商报错原因通常在 body 里）
async fn check_status(resp: reqwest::Response) -> Result<reqwest::Response, String> {
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "接口返回错误（{status}）: {}",
            truncate(&body, 500)
        ));
    }
    Ok(resp)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}

// ---------- 单元测试 ----------

#[cfg(test)]
mod tests {
    use super::*;

    /// 收集完整输入的全部事件（模拟流正常关闭）
    fn collect(input: &str) -> Vec<String> {
        let mut framer = SseFramer::default();
        framer.push_str(input);
        framer.flush();
        let mut out = Vec::new();
        while let Some(event) = framer.take_event() {
            out.push(event);
        }
        out.retain(|e| e != "[DONE]");
        out
    }

    #[test]
    fn sse_basic_events() {
        let input = "data: {\"a\":1}\n\ndata: {\"b\":2}\n\n";
        assert_eq!(collect(input), vec![r#"{"a":1}"#, r#"{"b":2}"#]);
    }

    #[test]
    fn sse_crlf_line_endings() {
        let input = "data: {\"a\":1}\r\n\r\ndata: {\"b\":2}\r\n\r\n";
        assert_eq!(collect(input), vec![r#"{"a":1}"#, r#"{"b":2}"#]);
    }

    #[test]
    fn sse_half_packet_splits() {
        // 任意字节边界切块：按字符逐段喂入
        let input = "data: {\"text\":\"你好\"}\n\ndata: [DONE]\n\n";
        let chars: Vec<String> = input.chars().map(String::from).collect();
        let mut framer = SseFramer::default();
        for piece in chars {
            framer.push_str(&piece);
        }
        framer.flush();
        let mut out = Vec::new();
        while let Some(event) = framer.take_event() {
            out.push(event);
        }
        out.retain(|e| e != "[DONE]");
        assert_eq!(out, vec![r#"{"text":"你好"}"#]);
    }

    #[test]
    fn sse_ignores_comments_and_fields() {
        let input = ": keep-alive\n\nevent: message\ndata: x\nid: 1\n\n";
        assert_eq!(collect(input), vec!["x"]);
    }

    #[test]
    fn sse_multi_data_lines_joined() {
        let input = "data: first\ndata: second\n\n";
        assert_eq!(collect(input), vec!["first\nsecond"]);
    }

    #[test]
    fn sse_trailing_event_without_final_newline() {
        let input = "data: {\"a\":1}\n\ndata: {\"b\":2}";
        // 最后一个事件没有空行收尾，流结束时也要产出
        assert_eq!(collect(input), vec![r#"{"a":1}"#, r#"{"b":2}"#]);
    }

    #[test]
    fn sse_done_marker_stops() {
        let input = "data: {\"a\":1}\n\ndata: [DONE]\n\n";
        assert_eq!(collect(input), vec![r#"{"a":1}"#]);
    }

    #[test]
    fn join_url_variants() {
        assert_eq!(
            join_url("https://api.openai.com/v1", "/chat/completions"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            join_url("https://api.openai.com/v1/", "/chat/completions"),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn openai_usage_parse() {
        let v =
            serde_json::json!({"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15});
        let u = parse_usage_openai(&v).unwrap();
        assert_eq!(
            (u.input_tokens, u.output_tokens, u.total_tokens),
            (10, 5, 15)
        );
        // 缺 total_tokens 时按 input+output 补
        let v = serde_json::json!({"prompt_tokens": 7, "completion_tokens": 3});
        let u = parse_usage_openai(&v).unwrap();
        assert_eq!(u.total_tokens, 10);
        assert!(parse_usage_openai(&serde_json::json!({})).is_none());
    }
}
