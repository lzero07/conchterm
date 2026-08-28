//! SSH 会话管理：连接、认证、PTY、数据流
//!
//! 架构说明：
//! - 每个终端标签页对应一个 Session（一个 russh Client + 一个 shell channel）
//! - SFTP 使用独立 TCP 连接：部分服务器（MaxSessions 1）拒绝同一连接上多开 session 通道
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
    /// SFTP 独立连接（懒加载）
    sftp: Mutex<Option<Arc<SftpClient>>>,
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

#[tauri::command]
pub async fn ssh_connect(
    params: ConnectParams,
    gen: u32,
    on_output: Channel<Vec<u8>>,
    sessions: State<'_, SessionMap>,
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
        sftp: Mutex::new(None),
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

async fn get_or_init_sftp(session: &SshSession, refresh: bool) -> Result<Arc<SftpClient>, String> {
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
    let path_ref = &path;
    sftp_op(&session, "删除", |sftp| async move {
        if is_dir {
            sftp.inner.lock().await.remove_dir(path_ref).await
        } else {
            sftp.inner.lock().await.remove_file(path_ref).await
        }
    })
    .await
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
