//! SSH 会话管理：连接、认证、PTY、数据流
//!
//! 架构说明：
//! - 每个终端标签页对应一个 Session（一个 russh Client + 一个 shell channel）
//! - SFTP 使用独立 TCP 连接：部分服务器（MaxSessions 1）拒绝同一连接上多开 session 通道
//! - 输出数据通过 Tauri ipc::Channel 以二进制推送给前端（xterm.js 直接 write Uint8Array）
//! - 键盘输入由前端 invoke("ssh_write") 发过来，写入 channel stdin

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use russh::client::{self, Handler};
use russh::keys::PrivateKeyWithHashAlg;
use russh::ChannelWriteHalf;
use russh::Disconnect;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex;

/// 前端传来的连接配置
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectParams {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// 密码认证用
    #[serde(default)]
    pub password: Option<String>,
    /// 私钥 PEM 内容（可选，与密码二选一或做二次认证）
    #[serde(default)]
    private_key: Option<String>,
    #[serde(default)]
    passphrase: Option<String>,
}

#[derive(Serialize)]
pub struct ConnectResult {
    pub ok: bool,
    pub message: String,
}

/// 远端文件元数据（SFTP 面板用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: i64,
    pub mode: u32,
    pub owner: String,
    pub group: String,
}

/// SSH 客户端事件处理器（主机密钥校验在这里回调）
struct ClientHandler;

impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // MVP: 信任所有主机密钥。TODO: known_hosts 校验 + 首次连接确认弹窗
        Ok(true)
    }
}

fn ssh_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(std::time::Duration::from_secs(30)),
        ..Default::default()
    })
}

/// 密码 / 私钥认证（终端与 SFTP 连接共用）
async fn authenticate(
    handle: &mut client::Handle<ClientHandler>,
    params: &ConnectParams,
) -> Result<(), String> {
    let authed = if let Some(p) = &params.password {
        handle
            .authenticate_password(params.username.clone(), p.clone())
            .await
            .map_err(|e| format!("认证失败: {e}"))?
    } else if let Some(key_pem) = &params.private_key {
        let key = russh::keys::decode_secret_key(key_pem, params.passphrase.as_deref())
            .map_err(|e| format!("解析私钥失败: {e}"))?;
        handle
            .authenticate_publickey(
                &params.username,
                PrivateKeyWithHashAlg::new(Arc::new(key), None),
            )
            .await
            .map_err(|e| format!("公钥认证失败: {e}"))?
    } else {
        return Err("必须提供密码或私钥".into());
    };
    if !authed.success() {
        return Err("用户名或密码错误".into());
    }
    Ok(())
}

/// 一个已建立的 SSH 会话（对应一个终端 Tab）
pub struct SshSession {
    handle: Mutex<client::Handle<ClientHandler>>,
    params: ConnectParams,
    /// 连接代数：StrictMode 双挂载时用于仲裁保留哪一代会话
    gen: u32,
    /// 终端通道的写半部：键盘输入、窗口 resize 都走这里
    channel_writer: ChannelWriteHalf<russh::client::Msg>,
    /// 终端通道已关闭（远端退出/连接断开）：置位后拒绝 Agent 在此会话上执行命令
    terminated: Arc<AtomicBool>,
    /// SFTP 独立连接（懒加载）
    sftp: Mutex<Option<Arc<SftpClient>>>,
    /// Agent 命令的工作目录（每次 exec 都是新通道，靠前缀 cd 延续目录状态）
    agent_cwd: Mutex<Option<String>>,
    /// 系统状态监控连接代数：0=未启动；用于停止旧监控任务
    sysstat_gen: AtomicU32,
}

impl SshSession {
    pub async fn close_sftp(&self) {
        if let Some(client) = self.sftp.lock().await.take() {
            let handle = client.handle.lock().await;
            let _ = handle
                .disconnect(Disconnect::ByApplication, "session closed", "")
                .await;
        }
    }
}

/// 全局会话表：session_id -> 会话实例
pub struct SessionMap(pub Mutex<HashMap<String, Arc<SshSession>>>);

/// 远端断开时通知前端的句柄：仅当会话表仍指向本连接
/// （未被新连接顶替、未被用户主动断开）时才发事件，避免误报
struct SessionCloseNotify {
    app: tauri::AppHandle,
    session: Arc<SshSession>,
}

impl SessionCloseNotify {
    async fn emit(&self) {
        use tauri::{Emitter, Manager};
        let sessions = self.app.state::<SessionMap>();
        let is_current = sessions
            .0
            .lock()
            .await
            .get(&self.session.params.id)
            .map(|s| Arc::ptr_eq(s, &self.session))
            .unwrap_or(false);
        if is_current {
            let _ = self.app.emit(
                "session-closed",
                serde_json::json!({ "sessionId": self.session.params.id }),
            );
        }
    }
}

#[tauri::command]
pub async fn ssh_connect(
    params: ConnectParams,
    gen: u32,
    on_output: Channel<Vec<u8>>,
    sessions: State<'_, SessionMap>,
    app: tauri::AppHandle,
) -> Result<ConnectResult, String> {
    let handler = ClientHandler;

    let mut handle = client::connect(ssh_config(), (params.host.as_str(), params.port), handler)
        .await
        .map_err(|e| format!("连接失败: {e}"))?;

    // ---- 认证 ----
    if let Err(e) = authenticate(&mut handle, &params).await {
        return Ok(ConnectResult {
            ok: false,
            message: e,
        });
    }

    // ---- 开启 PTY + shell ----
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("打开通道失败: {e}"))?;

    let want_reply = true;
    channel
        .request_pty(want_reply, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .map_err(|e| format!("请求 PTY 失败: {e}"))?;

    channel
        .request_shell(want_reply)
        .await
        .map_err(|e| format!("启动 shell 失败: {e}"))?;

    // 拆分读写半部：读半部给后台输出任务，写半部存会话供输入/resize 用
    let (mut read_half, channel_writer) = channel.split();

    // 终端通道关闭时打标记，供 ssh_exec 判断会话是否仍然存活
    let terminated = Arc::new(AtomicBool::new(false));
    let terminated_flag = terminated.clone();

    // 同一标签页重连时（如 React StrictMode 双挂载）替换旧会话，
    // 按代数仲裁：仅保留最新一代连接，慢完成的旧连接自行退出，
    // 避免其顶掉活跃的新会话导致终端无输出、无法输入
    {
        let mut map = sessions.0.lock().await;
        match map.remove(&params.id) {
            Some(old) if old.gen > gen => {
                map.insert(params.id, old);
                drop(map);
                let _ = handle
                    .disconnect(Disconnect::ByApplication, "superseded", "")
                    .await;
                return Ok(ConnectResult {
                    ok: true,
                    message: "superseded".into(),
                });
            }
            Some(old) => {
                drop(map);
                old.close_sftp().await;
                let old_handle = old.handle.lock().await;
                let _ = old_handle
                    .disconnect(Disconnect::ByApplication, "reconnect", "")
                    .await;
            }
            None => {}
        }
    }

    let session = Arc::new(SshSession {
        handle: Mutex::new(handle),
        params: params.clone(),
        gen,
        channel_writer,
        terminated,
        sftp: Mutex::new(None),
        agent_cwd: Mutex::new(None),
        sysstat_gen: AtomicU32::new(0),
    });

    // 后台任务：把远端输出持续推给前端
    // 通道退出时标记会话已终止；若会话表仍指向本连接（非顶替/非用户断开），
    // 说明是远端断开，通知前端把该会话从「可用」里移除
    let notify = SessionCloseNotify {
        app,
        session: session.clone(),
    };
    tokio::spawn(async move {
        loop {
            match read_half.wait().await {
                Some(russh::ChannelMsg::Data { ref data })
                    if on_output.send(data.to_vec()).is_err() =>
                {
                    break; // 前端已关闭
                }
                Some(russh::ChannelMsg::ExtendedData { ref data, ext: 1 }) => {
                    // stderr 也并入终端显示
                    let _ = on_output.send(data.to_vec());
                }
                Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                    let msg = format!("\r\n[进程退出，状态码 {}]\r\n", exit_status);
                    let _ = on_output.send(msg.into_bytes());
                }
                Some(russh::ChannelMsg::Eof) => {
                    let _ = on_output.send("\r\n[连接已关闭]\r\n".as_bytes().to_vec());
                    break;
                }
                Some(russh::ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
        terminated_flag.store(true, Ordering::Relaxed);
        notify.emit().await;
    });

    sessions.0.lock().await.insert(params.id, session);

    Ok(ConnectResult {
        ok: true,
        message: "connected".into(),
    })
}

/// 向终端写入键盘输入 / resize 控制序列以外的原始字节
#[tauri::command]
pub async fn ssh_write(
    session_id: String,
    data: Vec<u8>,
    sessions: State<'_, SessionMap>,
) -> Result<(), String> {
    let session = sessions
        .0
        .lock()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "会话不存在".to_string())?;
    match session.channel_writer.data_bytes(data).await {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("写入失败: {e:?}")),
    }
}

/// 终端尺寸变化时同步到远端
#[tauri::command]
pub async fn ssh_resize(
    session_id: String,
    cols: u32,
    rows: u32,
    sessions: State<'_, SessionMap>,
) -> Result<(), String> {
    let session = sessions
        .0
        .lock()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "会话不存在".to_string())?;
    match session.channel_writer.window_change(cols, rows, 0, 0).await {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("调整窗口失败: {e:?}")),
    }
}

/// 断开并移除会话
#[tauri::command]
pub async fn ssh_disconnect(
    session_id: String,
    sessions: State<'_, SessionMap>,
) -> Result<(), String> {
    if let Some(s) = sessions.0.lock().await.remove(&session_id) {
        // 先停监控任务再断连接，避免监控流触发重复的 session-closed
        stop_sysstat(&s).await;
        s.close_sftp().await;
        let handle = s.handle.lock().await;
        let _ = handle
            .disconnect(Disconnect::ByApplication, "user closed", "")
            .await;
    }
    Ok(())
}

// ==================== Agent 命令执行 ====================

const EXEC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const EXEC_OUTPUT_LIMIT: usize = 16 * 1024;

/// Agent 模式执行命令：独立 exec 通道执行并收集输出。
/// 仅在仍存活的会话上执行；部分服务器 MaxSessions=1 拒绝同一连接多开
/// session 通道时，与 SFTP 一样退回独立 TCP 连接执行。
/// 已断开/已退出的会话直接拒绝，避免「终端连接失败、Agent 却还能执行」的不一致。
#[tauri::command]
pub async fn ssh_exec(
    session_id: String,
    command: String,
    sessions: State<'_, SessionMap>,
) -> Result<String, String> {
    let session = sessions
        .0
        .lock()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "会话不存在或已断开".to_string())?;

    if session.terminated.load(Ordering::Relaxed) {
        return Err("终端会话已断开，无法执行命令；请在侧栏重新连接后再试".to_string());
    }

    // exec 通道每次都是全新 shell（从 home 开始），cd 等目录状态无法延续：
    // 记住上次工作目录，前缀 cd 恢复，结尾打标记行回收本次的 $PWD
    let cwd = session.agent_cwd.lock().await.clone();
    let (wrapped, marker) = wrap_with_cwd(&command, cwd.as_deref());

    let output = match exec_on_handle(&session.handle, wrapped.clone()).await {
        Ok(output) => output,
        Err(reuse_err) => match connect_exec(&session.params, wrapped).await {
            Ok(output) => output,
            Err(_) => return Err(reuse_err),
        },
    };

    // 从输出尾部回收工作目录：cd 生效后续命令自动在正确目录执行
    let (text, next_cwd) = strip_cwd_marker(&output, &marker);
    if let Some(dir) = next_cwd {
        *session.agent_cwd.lock().await = Some(dir);
    }
    Ok(text)
}

/// 包装命令：恢复上次工作目录 + 结尾输出带标记的 $PWD。
/// cd 失败（目录已删等）时忽略、保持原目录继续执行用户命令。
fn wrap_with_cwd(command: &str, cwd: Option<&str>) -> (String, String) {
    let marker = format!("__CONCH_PWD_{}__", NEXT_EXEC_MARKER.fetch_add(1, Ordering::Relaxed));
    let prefix = match cwd {
        Some(dir) => format!("cd {:?} 2>/dev/null; ", dir),
        None => String::new(),
    };
    // 标记行独占一行输出：只认「行首到行尾整行匹配」，避免误伤命令自身输出
    let wrapped = format!(
        "{prefix}{{ {command} ; }}\nprintf '\\n{marker}%s\\n' \"$PWD\"",
    );
    (wrapped, marker)
}

/// 剥掉标记行，返回 (干净输出, 解析到的新工作目录)
fn strip_cwd_marker(output: &str, marker: &str) -> (String, Option<String>) {
    // 输出可能被截断（EXEC_OUTPUT_LIMIT），从尾部往前找完整标记行
    if let Some(pos) = output.rfind(marker) {
        let before = &output[..pos];
        let after = &output[pos + marker.len()..];
        let pwd = after.trim();
        // 标记必须独占一行（前面是换行或输出开头），pwd 是单行有效路径
        let at_line_start = before.is_empty() || before.ends_with('\n');
        if at_line_start && !pwd.is_empty() && !pwd.contains('\n') {
            let mut clean = before.trim_end_matches('\n').to_string();
            if !clean.is_empty() {
                clean.push('\n');
            }
            return (clean, Some(pwd.to_string()));
        }
    }
    (output.to_string(), None)
}

static NEXT_EXEC_MARKER: AtomicU64 = AtomicU64::new(1);

/// 在现有连接上开 exec 通道执行
async fn exec_on_handle(
    handle: &Mutex<client::Handle<ClientHandler>>,
    command: String,
) -> Result<String, String> {
    let channel = {
        let guard = handle.lock().await;
        guard
            .channel_open_session()
            .await
            .map_err(|e| format!("打开执行通道失败: {e}"))?
    };
    run_exec_channel(channel, command).await
}

/// MaxSessions 受限时的独立 TCP 连接方案（与 connect_sftp 同思路）
async fn connect_exec(params: &ConnectParams, command: String) -> Result<String, String> {
    let mut handle = client::connect(
        ssh_config(),
        (params.host.as_str(), params.port),
        ClientHandler,
    )
    .await
    .map_err(|e| format!("连接失败: {e}"))?;
    authenticate(&mut handle, params).await?;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("打开执行通道失败: {e}"))?;
    run_exec_channel(channel, command).await
}

/// 执行命令并收集 stdout/stderr，直到通道关闭；带超时与输出截断
async fn run_exec_channel(
    mut channel: russh::Channel<russh::client::Msg>,
    command: String,
) -> Result<String, String> {
    channel
        .exec(true, command)
        .await
        .map_err(|e| format!("执行命令失败: {e}"))?;

    let collect = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut exit_code: Option<u32> = None;
        loop {
            match channel.wait().await {
                Some(russh::ChannelMsg::Data { ref data }) => out.extend_from_slice(data),
                Some(russh::ChannelMsg::ExtendedData { ref data, ext: 1 }) => {
                    err.extend_from_slice(data)
                }
                Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                    exit_code = Some(exit_status)
                }
                Some(russh::ChannelMsg::Eof) => {}
                Some(russh::ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
        (out, err, exit_code)
    };

    let (out, err, exit_code) = tokio::time::timeout(EXEC_TIMEOUT, collect)
        .await
        .map_err(|_| "命令执行超时（30 秒），已放弃".to_string())?;

    let mut text = String::from_utf8_lossy(&out).into_owned();
    let stderr_text = String::from_utf8_lossy(&err).into_owned();
    if !stderr_text.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&stderr_text);
    }
    if let Some(code) = exit_code {
        text.push_str(&format!("\n[exit code: {code}]"));
    }
    if text.len() > EXEC_OUTPUT_LIMIT {
        let mut cut = EXEC_OUTPUT_LIMIT;
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n[输出已截断]");
    }
    Ok(text)
}

// ==================== SFTP ====================

/// 封装 russh-sftp 的 SftpSession
#[derive(Default)]
struct IdNames {
    users: HashMap<u32, String>,
    groups: HashMap<u32, String>,
}

pub struct SftpClient {
    pub inner: Mutex<russh_sftp::client::SftpSession>,
    handle: Mutex<client::Handle<ClientHandler>>,
    /// uid/gid -> 名称 映射（首次列目录时从 /etc/passwd、/etc/group 加载）
    id_names: Mutex<Option<Arc<IdNames>>>,
}

pub(crate) async fn get_or_init_sftp(
    session: &SshSession,
    refresh: bool,
) -> Result<Arc<SftpClient>, String> {
    if !refresh {
        if let Some(existing) = session.sftp.lock().await.as_ref() {
            return Ok(existing.clone());
        }
    }

    // 丢弃旧连接（可能已被服务器断开或策略限制）
    if let Some(old) = session.sftp.lock().await.take() {
        let handle = old.handle.lock().await;
        let _ = handle
            .disconnect(Disconnect::ByApplication, "reconnect", "")
            .await;
    }

    let client = Arc::new(connect_sftp(&session.params).await?);
    *session.sftp.lock().await = Some(client.clone());
    Ok(client)
}

/// SFTP 走独立 TCP 连接：与终端互不占用 session 通道配额
async fn connect_sftp(params: &ConnectParams) -> Result<SftpClient, String> {
    let mut handle = client::connect(
        ssh_config(),
        (params.host.as_str(), params.port),
        ClientHandler,
    )
    .await
    .map_err(|e| format!("SFTP 连接失败: {e}"))?;
    authenticate(&mut handle, params).await?;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("打开 SFTP 通道失败: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("请求 SFTP 子系统失败: {e}"))?;
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("初始化 SFTP 失败: {e}"))?;
    Ok(SftpClient {
        inner: Mutex::new(sftp),
        handle: Mutex::new(handle),
        id_names: Mutex::new(None),
    })
}

/// 通过 SFTP 读取 passwd/group，把数字 id 解析成用户名/组名。
/// 读取失败（非 Linux 服务器等）返回空映射，回退显示数字。
async fn load_id_names(sftp: &russh_sftp::client::SftpSession) -> IdNames {
    let mut map = IdNames::default();
    if let Ok(bytes) = sftp.read("/etc/passwd").await {
        for line in String::from_utf8_lossy(&bytes).lines() {
            let parts: Vec<&str> = line.split(':').collect();
            if parts.len() >= 4 {
                if let Ok(uid) = parts[2].parse::<u32>() {
                    map.users.insert(uid, parts[0].to_string());
                }
                if let Ok(gid) = parts[3].parse::<u32>() {
                    map.groups
                        .entry(gid)
                        .or_insert_with(|| parts[0].to_string());
                }
            }
        }
    }
    if let Ok(bytes) = sftp.read("/etc/group").await {
        for line in String::from_utf8_lossy(&bytes).lines() {
            let parts: Vec<&str> = line.split(':').collect();
            if parts.len() >= 3 {
                if let Ok(gid) = parts[2].parse::<u32>() {
                    map.groups.insert(gid, parts[0].to_string());
                }
            }
        }
    }
    map
}

async fn get_id_names(client: &SftpClient) -> Option<Arc<IdNames>> {
    let mut slot = client.id_names.lock().await;
    if slot.is_none() {
        let names = load_id_names(&*client.inner.lock().await).await;
        *slot = Some(Arc::new(names));
    }
    slot.as_ref().cloned()
}

/// 执行一次 SFTP 操作；失败视为连接失效，自动重建连接重试一次
async fn sftp_op<T, E, Fut, F>(session: &SshSession, label: &str, op: F) -> Result<T, String>
where
    F: Fn(Arc<SftpClient>) -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    let client = get_or_init_sftp(session, false).await?;
    if let Ok(result) = op(client.clone()).await {
        return Ok(result);
    }
    let client = get_or_init_sftp(session, true).await?;
    op(client).await.map_err(|e| format!("{label}失败: {e}"))
}

#[tauri::command]
pub async fn sftp_list(
    session_id: String,
    path: String,
    sessions: State<'_, SessionMap>,
) -> Result<Vec<RemoteFile>, String> {
    let session = sessions
        .0
        .lock()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "会话不存在".to_string())?;
    let path_ref = &path;
    let entries = sftp_op(&session, "读取目录", |sftp| async move {
        sftp.inner.lock().await.read_dir(path_ref).await
    })
    .await?;
    let sftp = get_or_init_sftp(&session, false).await?;
    let names = get_id_names(&sftp).await;
    let mut files = Vec::new();
    for entry in entries {
        let file_name = entry.file_name();
        if file_name == "." || file_name == ".." {
            continue;
        }
        let metadata = entry.metadata();
        let owner = metadata
            .user
            .clone()
            .or_else(|| {
                metadata
                    .uid
                    .and_then(|id| names.as_ref().and_then(|n| n.users.get(&id).cloned()))
            })
            .unwrap_or_else(|| {
                metadata
                    .uid
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "-".to_string())
            });
        let group = metadata
            .group
            .clone()
            .or_else(|| {
                metadata
                    .gid
                    .and_then(|id| names.as_ref().and_then(|n| n.groups.get(&id).cloned()))
            })
            .unwrap_or_else(|| {
                metadata
                    .gid
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "-".to_string())
            });
        files.push(RemoteFile {
            name: file_name,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            modified_ms: metadata
                .modified()
                .map(|t| {
                    t.duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64 * 1000)
                        .unwrap_or(0)
                })
                .unwrap_or(0),
            mode: metadata.permissions.unwrap_or(0),
            owner,
            group,
        });
    }
    files.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(files)
}

#[tauri::command]
pub async fn sftp_mkdir(
    session_id: String,
    path: String,
    sessions: State<'_, SessionMap>,
) -> Result<(), String> {
    let session = sessions
        .0
        .lock()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "会话不存在".to_string())?;
    let path_ref = &path;
    sftp_op(&session, "创建目录", |sftp| async move {
        sftp.inner.lock().await.create_dir(path_ref).await
    })
    .await
}

#[tauri::command]
pub async fn sftp_remove(
    session_id: String,
    path: String,
    is_dir: bool,
    sessions: State<'_, SessionMap>,
) -> Result<(), String> {
    let session = sessions
        .0
        .lock()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "会话不存在".to_string())?;
    let p1 = path.clone();
    let p2 = path.clone();
    sftp_op(&session, "删除", move |sftp| {
        let path = p1.clone();
        let retry_path = p2.clone();
        async move {
            let inner = sftp.inner.lock().await;
            if is_dir {
                // 递归删除：目录可能非空（SFTP 的 remove_dir 只能删空目录）
                remove_recursive(&inner, &path).await
            } else {
                inner.remove_file(&retry_path).await
            }
        }
    })
    .await
}

/// 递归删除远端目录及其全部内容
async fn remove_recursive(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<(), russh_sftp::client::error::Error> {
    let entries = sftp.read_dir(path).await?;
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let child = format!("{}/{}", path.trim_end_matches('/'), name);
        if entry.metadata().is_dir() {
            Box::pin(remove_recursive(sftp, &child)).await?;
        } else {
            sftp.remove_file(&child).await?;
        }
    }
    sftp.remove_dir(path).await
}

#[tauri::command]
pub async fn sftp_rename(
    session_id: String,
    old_path: String,
    new_path: String,
    sessions: State<'_, SessionMap>,
) -> Result<(), String> {
    let session = sessions
        .0
        .lock()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "会话不存在".to_string())?;
    let old_ref = &old_path;
    let new_ref = &new_path;
    sftp_op(&session, "重命名", |sftp| async move {
        sftp.inner.lock().await.rename(old_ref, new_ref).await
    })
    .await
}

#[tauri::command]
pub async fn sftp_upload(
    session_id: String,
    local_path: String,
    remote_path: String,
    sessions: State<'_, SessionMap>,
) -> Result<(), String> {
    let session = sessions
        .0
        .lock()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "会话不存在".to_string())?;
    let sftp = get_or_init_sftp(&session, false).await?;

    let inner = sftp.inner.lock().await;
    upload_recursive(&inner, Path::new(&local_path), &remote_path).await
}

/// 递归上传：目录会连同内部结构一起创建并逐个传输文件
async fn upload_recursive(
    sftp: &russh_sftp::client::SftpSession,
    local: &Path,
    remote: &str,
) -> Result<(), String> {
    if local.is_dir() {
        // 已存在等情况忽略，子项写入失败时会有更明确的错误
        let _ = sftp.create_dir(remote).await;
        let mut entries = tokio::fs::read_dir(local)
            .await
            .map_err(|e| format!("读取本地目录失败: {e}"))?;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| format!("读取本地目录失败: {e}"))?
        {
            let child_remote = format!(
                "{}/{}",
                remote.trim_end_matches('/'),
                entry.file_name().to_string_lossy()
            );
            Box::pin(upload_recursive(sftp, &entry.path(), &child_remote)).await?;
        }
        return Ok(());
    }

    let mut local_file = tokio::fs::File::open(local)
        .await
        .map_err(|e| format!("打开本地文件失败: {e}"))?;
    let mut remote_file = sftp
        .create(remote)
        .await
        .map_err(|e| format!("创建远端文件失败: {e}"))?;

    tokio::io::copy(&mut local_file, &mut remote_file)
        .await
        .map_err(|e| format!("上传失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_download(
    session_id: String,
    remote_path: String,
    local_path: String,
    sessions: State<'_, SessionMap>,
) -> Result<(), String> {
    let session = sessions
        .0
        .lock()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "会话不存在".to_string())?;
    let sftp = get_or_init_sftp(&session, false).await?;

    let mut remote = {
        let inner = sftp.inner.lock().await;
        inner
            .open(&remote_path)
            .await
            .map_err(|e| format!("打开远端文件失败: {e}"))?
    };
    let mut local = tokio::fs::File::create(&local_path)
        .await
        .map_err(|e| format!("创建本地文件失败: {e}"))?;

    tokio::io::copy(&mut remote, &mut local)
        .await
        .map_err(|e| format!("下载失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_exists(
    session_id: String,
    remote_path: String,
    sessions: State<'_, SessionMap>,
) -> Result<bool, String> {
    let session = sessions
        .0
        .lock()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "会话不存在".to_string())?;
    let sftp = get_or_init_sftp(&session, false).await?;
    let exists = {
        let inner = sftp.inner.lock().await;
        inner
            .try_exists(&remote_path)
            .await
            .map_err(|e| format!("检查文件失败: {e}"))?
    };
    Ok(exists)
}

// ==================== 系统状态监控（FinalShell 风格状态栏） ====================

/// 每个采样值由 N 拍差分平滑（滑动窗口），抹平单拍抖动；
/// 窗口按秒数近似：采样间隔 1s，保留最近 SYSSTAT_WINDOW 拍
const SYSSTAT_WINDOW: usize = 3;
const SYSSTAT_SAMPLE_INTERVAL_MS: u64 = 1000;

/// 远端采样循环：POSIX sh，每秒输出一个 BEGIN 分隔的快照块。
/// 不依赖 bash/procps；字段缺失时解析端跳过该指标。
/// 首块附带 who 输出（当前登录用户），解析端只取一次
const SYSSTAT_CMD: &str = r#"who 2>/dev/null | head -1
while true; do
echo "===BEGIN==="
cat /proc/uptime 2>/dev/null
echo "--STAT--"
cat /proc/stat 2>/dev/null
echo "--MEM--"
cat /proc/meminfo 2>/dev/null
echo "--NET--"
cat /proc/net/dev 2>/dev/null
echo "===END==="
sleep 1
done"#;

/// 一次采样的原始计数器（差分前）
#[derive(Default, Clone)]
struct SysstatRaw {
    /// /proc/uptime 第一个字段，秒
    uptime_secs: Option<f64>,
    /// /proc/stat 各列累计 jiffies
    cpu_total: Option<u64>,
    cpu_idle: Option<u64>,
    mem_total_kb: Option<u64>,
    mem_available_kb: Option<u64>,
    /// 全网卡 rx/tx 字节累计
    rx_bytes: Option<u64>,
    tx_bytes: Option<u64>,
    /// 登录用户（who 的第一行首列，快照直出非差分）
    user: Option<String>,
}

/// 滑动窗口内的差分结果，推给前端展示
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysstatSample {
    cpu_percent: f64,
    mem_used_mb: u64,
    mem_total_mb: u64,
    /// 接收速率 字节/秒（窗口均值）
    rx_bps: f64,
    tx_bps: f64,
    uptime_secs: u64,
    user: String,
}

/// 解析一个采样块（含首个块前的 who 导语）。
/// 结构：[who 行] ===BEGIN=== uptime --STAT-- /proc/stat --MEM-- /proc/meminfo --NET-- /proc/net/dev ===END===
fn parse_sysstat_block(block: &str) -> SysstatRaw {
    let mut raw = SysstatRaw::default();
    let mut section = "";
    let mut begun = false;
    for line in block.lines() {
        match line {
            "===BEGIN===" => {
                begun = true;
                section = "";
                continue;
            }
            "--STAT--" => {
                section = "stat";
                continue;
            }
            "--MEM--" => {
                section = "mem";
                continue;
            }
            "--NET--" => {
                section = "net";
                continue;
            }
            "===END===" | "" => continue,
            _ => {}
        }
        if !begun {
            continue; // 导语区：who 输出，用户名在流读取端单独提取
        }
        match section {
            "stat" => {
                if let Some(rest) = line.strip_prefix("cpu ") {
                    // 列序：user nice system idle iowait ...；idle + iowait 视为空闲
                    let mut total = 0u64;
                    let mut idle = 0u64;
                    for (i, f) in rest.split_whitespace().enumerate() {
                        if let Ok(v) = f.parse::<u64>() {
                            total += v;
                            if i == 3 {
                                idle = v;
                            }
                            if i == 4 {
                                idle += v;
                            }
                        }
                    }
                    raw.cpu_total = Some(total);
                    raw.cpu_idle = Some(idle);
                }
            }
            "mem" => {
                if let Some(rest) = line.strip_prefix("MemTotal:") {
                    raw.mem_total_kb = rest.split_whitespace().next().and_then(|v| v.parse().ok());
                } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
                    raw.mem_available_kb =
                        rest.split_whitespace().next().and_then(|v| v.parse().ok());
                }
            }
            "net" => {
                // 数据行形如 "  eth0: 12345 ... 67890 ..."（16 列数字，rx 首列 / tx 第 9 列）
                if let Some((_, nums)) = line.split_once(':') {
                    let vals: Vec<u64> = nums
                        .split_whitespace()
                        .filter_map(|v| v.parse().ok())
                        .collect();
                    if vals.len() >= 9 {
                        raw.rx_bytes = Some(raw.rx_bytes.unwrap_or(0) + vals[0]);
                        raw.tx_bytes = Some(raw.tx_bytes.unwrap_or(0) + vals[8]);
                    }
                }
            }
            _ => {
                // 块首 uptime 行："13245.78 51234.02"
                if raw.uptime_secs.is_none() {
                    if let Some(first) = line.split_whitespace().next() {
                        if let Ok(v) = first.parse::<f64>() {
                            raw.uptime_secs = Some(v);
                        }
                    }
                }
            }
        }
    }
    raw
}

/// 滑动窗口：累计最近 N 拍做一次差分（首尾差 / 时间差）
struct SysstatWindow {
    raws: VecDeque<(SysstatRaw, std::time::Instant)>,
}

impl SysstatWindow {
    fn new() -> Self {
        Self {
            raws: VecDeque::with_capacity(SYSSTAT_WINDOW + 1),
        }
    }

    fn push(&mut self, raw: SysstatRaw) -> Option<SysstatSample> {
        let now = std::time::Instant::now();
        self.raws.push_back((raw, now));
        if self.raws.len() > SYSSTAT_WINDOW {
            self.raws.pop_front();
        }
        let n = self.raws.len();
        if n < 2 {
            return None;
        }
        let (first, t0) = self.raws.front().unwrap();
        let (last, t1) = self.raws.back().unwrap();
        let dt = t1.duration_since(*t0).as_secs_f64();
        if dt <= 0.0 {
            return None;
        }
        let cpu_percent = match (
            first.cpu_total,
            first.cpu_idle,
            last.cpu_total,
            last.cpu_idle,
        ) {
            (Some(t0v), Some(i0v), Some(t1v), Some(i1v)) => {
                let d_total = t1v.saturating_sub(t0v) as f64;
                let d_idle = i1v.saturating_sub(i0v) as f64;
                if d_total > 0.0 {
                    ((d_total - d_idle) / d_total * 100.0).clamp(0.0, 100.0)
                } else {
                    0.0
                }
            }
            _ => 0.0,
        };
        let (rx_bps, tx_bps) = match (first.rx_bytes, first.tx_bytes, last.rx_bytes, last.tx_bytes)
        {
            (Some(r0), Some(x0), Some(r1), Some(x1)) => {
                // 计数器回卷（重启）时忽略该窗口
                (
                    r1.saturating_sub(r0) as f64 / dt,
                    x1.saturating_sub(x0) as f64 / dt,
                )
            }
            _ => (0.0, 0.0),
        };
        let mem_total_kb = last.mem_total_kb.unwrap_or(0);
        let mem_used_kb = last
            .mem_total_kb
            .and_then(|t| last.mem_available_kb.map(|a| t.saturating_sub(a)))
            .unwrap_or(0);
        Some(SysstatSample {
            cpu_percent,
            mem_used_mb: mem_used_kb / 1024,
            mem_total_mb: mem_total_kb / 1024,
            rx_bps,
            tx_bps,
            uptime_secs: last.uptime_secs.map(|v| v as u64).unwrap_or(0),
            user: last.user.clone().unwrap_or_default(),
        })
    }
}

/// 启动监控连接的采样流，事件推给前端
#[tauri::command]
pub async fn sysstat_start(
    session_id: String,
    app: tauri::AppHandle,
    sessions: State<'_, SessionMap>,
) -> Result<(), String> {
    let session = sessions
        .0
        .lock()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "会话不存在".to_string())?;
    if session.terminated.load(Ordering::Relaxed) {
        return Err("会话已断开".to_string());
    }

    let new_gen = session.sysstat_gen.fetch_add(1, Ordering::Relaxed) + 1;
    session.sysstat_gen.store(new_gen, Ordering::Relaxed);

    let params = session.params.clone();
    let session_id_cloned = session_id.clone();
    let app_cloned = app.clone();
    let session_cloned = session.clone();
    tokio::spawn(async move {
        use tauri::Emitter;
        let _ = run_sysstat_stream(&params, &session_id_cloned, &app_cloned, new_gen).await;
        // 仅当本流仍是该会话的最新监控流时才通知前端隐藏状态栏；
        // 被 stop/重启动/会话顶替后 gen 已变，旧流的退出事件会被跳过
        if session_cloned.sysstat_gen.load(Ordering::Relaxed) == new_gen {
            let _ = app_cloned.emit(
                "sysstat-stopped",
                serde_json::json!({ "sessionId": session_id_cloned }),
            );
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn sysstat_stop(
    session_id: String,
    sessions: State<'_, SessionMap>,
) -> Result<(), String> {
    if let Some(s) = sessions.0.lock().await.get(&session_id) {
        stop_sysstat(s).await;
    }
    Ok(())
}

async fn stop_sysstat(session: &SshSession) {
    // 递增代数：监控流发现代数不匹配即自行退出并断开连接
    let old_gen = session.sysstat_gen.fetch_add(1, Ordering::Relaxed) + 1;
    let _ = old_gen;
}

/// 打开独立监控连接，逐块读采样输出，差分后推 `sysstat-update` 事件。
/// my_gen 是本流启动时的监控代数：会话表中的代数与之不符（被 stop/顶替/移除）
/// 时自行退出
async fn run_sysstat_stream(
    params: &ConnectParams,
    session_id: &str,
    app: &tauri::AppHandle,
    my_gen: u32,
) -> Result<(), String> {
    let mut handle = client::connect(
        ssh_config(),
        (params.host.as_str(), params.port),
        ClientHandler,
    )
    .await
    .map_err(|e| format!("监控连接失败: {e}"))?;
    authenticate(&mut handle, params).await?;

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("打开监控通道失败: {e}"))?;

    channel
        .exec(true, SYSSTAT_CMD.to_string())
        .await
        .map_err(|e| format!("启动采样失败: {e}"))?;

    use tauri::Emitter;
    use tokio::io::AsyncReadExt;

    let mut window = SysstatWindow::new();
    let mut remote_user = String::new();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut stream = channel.into_stream();

    loop {
        if get_sysstat_gen(session_id, app).await != my_gen {
            break;
        }
        match tokio::time::timeout(
            std::time::Duration::from_millis(SYSSTAT_SAMPLE_INTERVAL_MS * 15),
            stream.read(&mut chunk),
        )
        .await
        {
            Err(_) => break, // 读超时：远端无响应，退出
            Ok(Err(_)) => break,
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => buf.extend_from_slice(&chunk[..n]),
        }
        // 尝试从缓冲中提取完整块
        while let Some(pos) = find_subsequence(&buf, b"===END===\n") {
            let block_bytes: Vec<u8> = buf.drain(..pos + b"===END===\n".len()).collect();
            let block = String::from_utf8_lossy(&block_bytes);
            let raw = parse_sysstat_block(&block);
            // who 输出位于首个 ===BEGIN=== 之前的导语区，只取一次
            if remote_user.is_empty() {
                let preamble = block.split("===BEGIN===").next().unwrap_or("");
                if let Some(line) = preamble.lines().find(|l| !l.trim().is_empty()) {
                    if let Some(first) = line.split_whitespace().next() {
                        remote_user = first.to_string();
                    }
                }
            }
            if let Some(mut sample) = window.push(raw) {
                if sample.user.is_empty() {
                    sample.user = remote_user.clone();
                }
                let _ = app.emit(
                    "sysstat-update",
                    serde_json::json!({
                        "sessionId": session_id,
                        "sample": sample,
                    }),
                );
            }
        }
    }

    let _ = handle
        .disconnect(Disconnect::ByApplication, "sysstat stop", "")
        .await;
    Ok(())
}

/// 监控流运行期间轮询会话的监控代数；会话被顶替/断开/停止时 gen 已变，流自行退出
async fn get_sysstat_gen(session_id: &str, app: &tauri::AppHandle) -> u32 {
    use tauri::Manager;
    let sessions = app.state::<SessionMap>();
    let gen = { sessions.0.lock().await.get(session_id).cloned() };
    match gen {
        Some(s) => s.sysstat_gen.load(Ordering::Relaxed),
        None => 0,
    }
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- Agent cd 跟踪 ----------

    #[test]
    fn cwd_wrap_first_exec_has_no_prefix() {
        let (wrapped, marker) = wrap_with_cwd("ls", None);
        assert!(!wrapped.starts_with("cd "), "首次执行不应前缀 cd: {wrapped}");
        assert!(wrapped.contains("ls"));
        assert!(wrapped.contains(&marker));
        assert!(wrapped.contains("$PWD"));
    }

    #[test]
    fn cwd_wrap_restores_previous_dir() {
        let (wrapped, marker) = wrap_with_cwd("ls", Some("/var/log"));
        assert!(wrapped.starts_with("cd \"/var/log\" 2>/dev/null; "), "{wrapped}");
        assert!(wrapped.contains(&marker));
    }

    #[test]
    fn cwd_strip_recovers_pwd() {
        let marker = "__CONCH_PWD_1__";
        let output = "file1\nfile2\n[exit code: 0]\n__CONCH_PWD_1__/var/log\n";
        let (clean, cwd) = strip_cwd_marker(output, marker);
        assert_eq!(clean, "file1\nfile2\n[exit code: 0]\n");
        assert_eq!(cwd.as_deref(), Some("/var/log"));
    }

    #[test]
    fn cwd_strip_without_trailing_newline() {
        let marker = "__CONCH_PWD_1__";
        let output = "ok\n__CONCH_PWD_1__/home/user";
        let (clean, cwd) = strip_cwd_marker(output, marker);
        assert_eq!(clean, "ok\n");
        assert_eq!(cwd.as_deref(), Some("/home/user"));
    }

    #[test]
    fn cwd_strip_empty_command_output() {
        let marker = "__CONCH_PWD_1__";
        let output = "[exit code: 0]\n__CONCH_PWD_1__/root\n";
        let (clean, cwd) = strip_cwd_marker(output, marker);
        assert_eq!(clean, "[exit code: 0]\n");
        assert_eq!(cwd.as_deref(), Some("/root"));
    }

    #[test]
    fn cwd_marker_inside_user_output_ignored() {
        // 用户输出里恰含 marker 字样但不在行首：不剥、不更新目录
        let marker = "__CONCH_PWD_1__";
        let output = "echo __CONCH_PWD_1__/etc\n[exit code: 0]\n";
        let (clean, cwd) = strip_cwd_marker(output, marker);
        assert_eq!(clean, output);
        assert!(cwd.is_none());
    }

    #[test]
    fn cwd_marker_truncated_no_pwd_keeps_output() {
        // 截断后只剩 marker 本体、pwd 丢失：不更新目录，输出原样
        let marker = "__CONCH_PWD_1__";
        let output = "data\n__CONCH_PWD_1__";
        let (clean, cwd) = strip_cwd_marker(output, marker);
        assert_eq!(clean, output);
        assert!(cwd.is_none());
    }

    #[test]
    fn parse_full_block() {
        let block = "root@pts/0\n===BEGIN===\n13245.78 51234.02\n--STAT--\ncpu  120 0 300 9000 100 0 0 0 0 0\ncpu0 120 0 300 9000 100 0 0 0 0 0\nintr 123\n--MEM--\nMemTotal:       16384000 kB\nMemFree:         2048000 kB\nMemAvailable:   8388608 kB\n--NET--\nInter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n  eth0: 111111 200 0 0 0 0 0 0 222222 100 0 0 0 0 0 0\n  lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0\n===END===\n";
        let raw = parse_sysstat_block(block);
        assert_eq!(raw.uptime_secs, Some(13245.78));
        // cpu 行：total = 120+0+300+9000+100 = 9520, idle = 9000+100 = 9100
        assert_eq!(raw.cpu_total, Some(9520));
        assert_eq!(raw.cpu_idle, Some(9100));
        assert_eq!(raw.mem_total_kb, Some(16384000));
        assert_eq!(raw.mem_available_kb, Some(8388608));
        // eth0 + lo 两个网卡的累计
        assert_eq!(raw.rx_bytes, Some(112111));
        assert_eq!(raw.tx_bytes, Some(223222));
    }

    #[test]
    fn window_diff_and_counter_rollover() {
        let mut w = SysstatWindow::new();
        let mut r0 = SysstatRaw::default();
        r0.cpu_total = Some(1000);
        r0.cpu_idle = Some(800);
        r0.rx_bytes = Some(5000);
        r0.tx_bytes = Some(3000);
        assert!(w.push(r0.clone()).is_none()); // 单拍无差分

        let mut r1 = r0.clone();
        r1.cpu_total = Some(1100); // +100 jiffies
        r1.cpu_idle = Some(870); // +70 -> busy 30/100 = 30%
        r1.rx_bytes = Some(9000); // +4000 bytes
        r1.tx_bytes = Some(3600);
        let s = w.push(r1.clone()).unwrap();
        assert!((s.cpu_percent - 30.0).abs() < 0.01);
        assert!(s.rx_bps > 0.0 && s.tx_bps > 0.0);

        // 计数器回卷（服务器重启）：rx 变小，速率应为 0 而非负/巨大
        let mut r2 = r1.clone();
        r2.rx_bytes = Some(10);
        r2.cpu_total = Some(1200);
        r2.cpu_idle = Some(1000);
        let s2 = w.push(r2).unwrap();
        assert_eq!(s2.rx_bps, 0.0);
    }
}
