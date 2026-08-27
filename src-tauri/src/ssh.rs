//! SSH 会话管理：连接、认证、PTY、数据流
//!
//! 架构说明：
//! - 每个终端标签页对应一个 Session（一个 russh Client + 一个 channel）
//! - 输出数据通过 Tauri ipc::Channel 以二进制推送给前端（xterm.js 直接 write Uint8Array）
//! - 键盘输入由前端 invoke("ssh_write") 发过来，写入 channel stdin

use std::collections::HashMap;
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
pub struct RemoteFile {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: i64,
    pub mode: u32,
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

/// 一个已建立的 SSH 会话（对应一个终端 Tab）
pub struct SshSession {
    handle: Mutex<client::Handle<ClientHandler>>,
    /// 终端通道的写半部：键盘输入、窗口 resize 都走这里
    channel_writer: ChannelWriteHalf<russh::client::Msg>,
    /// SFTP 通道懒加载缓存
    sftp: Mutex<Option<Arc<SftpClient>>>,
}

impl SshSession {
    pub async fn close_sftp(&self) {
        *self.sftp.lock().await = None;
    }
}

/// 全局会话表：session_id -> 会话实例
pub struct SessionMap(pub Mutex<HashMap<String, Arc<SshSession>>>);

#[tauri::command]
pub async fn ssh_connect(
    params: ConnectParams,
    on_output: Channel<Vec<u8>>,
    sessions: State<'_, SessionMap>,
) -> Result<ConnectResult, String> {
    let config = client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(std::time::Duration::from_secs(30)),
        ..Default::default()
    };

    let handler = ClientHandler;

    let mut handle = client::connect(
        Arc::new(config),
        (params.host.as_str(), params.port),
        handler,
    )
    .await
    .map_err(|e| format!("连接失败: {e}"))?;

    // ---- 认证 ----
    let authed = if let Some(p) = &params.password {
        let name = params.username.clone();
        handle
            .authenticate_password(name, p.clone())
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
        return Ok(ConnectResult { ok: false, message: "用户名或密码错误".into() });
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

    // 后台任务：把远端输出持续推给前端
    tokio::spawn(async move {
        loop {
            match read_half.wait().await {
                Some(russh::ChannelMsg::Data { ref data }) => {
                    if on_output.send(data.to_vec()).is_err() {
                        break; // 前端已关闭
                    }
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
    });

    let session = Arc::new(SshSession {
        handle: Mutex::new(handle),
        channel_writer,
        sftp: Mutex::new(None),
    });

    sessions.0.lock().await.insert(params.id, session);

    Ok(ConnectResult { ok: true, message: "connected".into() })
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
    match session
        .channel_writer
        .data_bytes(data)
        .await
    {
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
    match session
        .channel_writer
        .window_change(cols, rows, 0, 0)
        .await
    {
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
        s.close_sftp().await;
        let handle = s.handle.lock().await;
        let _ = handle
            .disconnect(Disconnect::ByApplication, "user closed", "")
            .await;
    }
    Ok(())
}

// ==================== SFTP ====================

/// 封装 russh-sftp 的 SftpSession
pub struct SftpClient {
    pub inner: Mutex<russh_sftp::client::SftpSession>,
}

impl SftpClient {
    pub fn new(inner: russh_sftp::client::SftpSession) -> Self {
        Self { inner: Mutex::new(inner) }
    }
}

async fn get_or_init_sftp(
    session: &SshSession,
) -> Result<Arc<SftpClient>, String> {
    let mut slot = session.sftp.lock().await;
    if let Some(existing) = slot.as_ref() {
        return Ok(existing.clone());
    }
    let handle = session.handle.lock().await;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("打开 SFTP 通道失败: {e}"))?;
    drop(handle);
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("初始化 SFTP 失败: {e}"))?;
    let client = Arc::new(SftpClient::new(sftp));
    *slot = Some(client.clone());
    Ok(client)
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
    let sftp = get_or_init_sftp(&session).await?;
    let entries = {
        let inner = sftp.inner.lock().await;
        inner.read_dir(&path).await
    }
    .map_err(|e| format!("读取目录失败: {e}"))?;
    let mut files = Vec::new();
    for entry in entries {
        let file_name = entry.file_name();
        if file_name == "." || file_name == ".." {
            continue;
        }
        let metadata = entry.metadata();
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
        });
    }
    files.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
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
    let sftp = get_or_init_sftp(&session).await?;
    let result = {
        let inner = sftp.inner.lock().await;
        inner.create_dir(&path).await
    };
    result.map_err(|e| format!("创建目录失败: {e}"))
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
    let sftp = get_or_init_sftp(&session).await?;
    let result = {
        let inner = sftp.inner.lock().await;
        if is_dir {
            inner.remove_dir(&path).await
        } else {
            inner.remove_file(&path).await
        }
    };
    result.map_err(|e| format!("删除失败: {e}"))
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
    let sftp = get_or_init_sftp(&session).await?;
    let result = {
        let inner = sftp.inner.lock().await;
        inner.rename(&old_path, &new_path).await
    };
    result.map_err(|e| format!("重命名失败: {e}"))
}
