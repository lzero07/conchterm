//! 拖出到资源管理器（Windows）：
//! 先把远端文件下载到临时目录，再以原生 OLE 拖拽（DoDragDrop）交给系统，
//! 资源管理器/桌面即可像接收本地文件一样接收它。

use std::path::PathBuf;

use crate::ssh::{get_or_init_sftp, SessionMap};

fn temp_drag_dir() -> PathBuf {
    std::env::temp_dir().join("conchterm-drag")
}

/// 应用启动时清理上次拖拽残留的临时文件
pub fn cleanup_temp_files() {
    let _ = std::fs::remove_dir_all(temp_drag_dir());
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use std::path::Path;

    use windows::core::{implement, HSTRING};
    use windows::Win32::Foundation::{
        DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, S_OK,
    };
    use windows::Win32::System::Com::IDataObject;
    use windows::Win32::System::Ole::{
        DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize, DROPEFFECT,
        DROPEFFECT_COPY,
    };
    use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
    use windows::Win32::UI::Shell::{
        BHID_DataObject, IShellItem, SHCreateItemFromParsingName,
    };

    #[implement(IDropSource)]
    struct DropSource {
        /// 拖拽启动时刻：invoke 链路延迟可能导致 DoDragDrop 起跑时
        /// 左键已松开。宽限期内检测到此情况时选择“干净取消”
        ///（DRAGDROP_S_CANCEL）而非强行 Drop / 无限等待，
        /// 避免给系统留下畸形的拖拽状态
        start: std::time::Instant,
    }

    const STARTUP_GRACE_MS: u64 = 500;

    impl IDropSource_Impl for DropSource_Impl {
        fn QueryContinueDrag(
            &self,
            escape_pressed: windows::core::BOOL,
            key_state: MODIFIERKEYS_FLAGS,
        ) -> windows::core::HRESULT {
            use windows::Win32::UI::Input::KeyboardAndMouse::{
                GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON,
            };

            if escape_pressed.as_bool()
                || unsafe { GetAsyncKeyState(VK_ESCAPE.0 as i32) } as u16 & 0x8000 != 0
            {
                return DRAGDROP_S_CANCEL;
            }
            // 任一鼠标键被额外按下（右键/中键）：取消，避免悬空状态
            if key_state.0 & (0x2 | 0x10) != 0 {
                return DRAGDROP_S_CANCEL;
            }
            let elapsed = self.start.elapsed().as_millis() as u64;
            // 用 GetAsyncKeyState 兜底检测左键：DoDragDrop 传来的 key_state
            // 在跨线程消息场景下可能不更新
            let lbutton_down =
                key_state.0 & 0x1 != 0
                    || unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } as u16 & 0x8000 != 0;
            if !lbutton_down {
                if elapsed < STARTUP_GRACE_MS {
                    // 起跑时左键已松开（invoke 延迟）：干净取消，不留畸形状态
                    return DRAGDROP_S_CANCEL;
                }
                return DRAGDROP_S_DROP;
            }
            S_OK
        }

        fn GiveFeedback(&self, _effect: DROPEFFECT) -> windows::core::HRESULT {
            DRAGDROP_S_USEDEFAULTCURSORS
        }
    }

    /// 阻塞式拖拽循环：直到用户放下或取消才返回
    pub fn run_drag_loop(file_path: &Path) -> Result<(), String> {
        unsafe {
            // DoDragDrop 要求 OLE 层初始化（CoInitializeEx 不够，
            // 否则 DoDragDrop 报 0x800401F0 CO_E_NOTINITIALIZED）
            if let Err(e) = OleInitialize(None) {
                return Err(format!("初始化 OLE 失败: {e}"));
            }
            let result = run_drag_inner(file_path);
            OleUninitialize();
            result
        }
    }

    fn run_drag_inner(file_path: &Path) -> Result<(), String> {
        unsafe {
            let wide = HSTRING::from(file_path.as_os_str().to_string_lossy().as_ref());
            // IShellItem 本身不支持 IDataObject 接口，必须通过 BindToHandler 获取
            let item: IShellItem = SHCreateItemFromParsingName(&wide, None)
                .map_err(|e| format!("定位临时文件失败: {e}"))?;
            let data_object: IDataObject = item
                .BindToHandler::<_, IDataObject>(None, &BHID_DataObject)
                .map_err(|e| format!("创建拖拽数据对象失败: {e}"))?;
            let drop_source: IDropSource = DropSource {
                start: std::time::Instant::now(),
            }
            .into();
            let mut effect = DROPEFFECT::default();
            eprintln!("[drag-out] DoDragDrop 开始: {}", file_path.display());
            let hr = DoDragDrop(&data_object, &drop_source, DROPEFFECT_COPY, &mut effect);
            eprintln!(
                "[drag-out] DoDragDrop 返回: 0x{:X}, effect={}",
                hr.0, effect.0
            );
            // 显式丢弃引用让 COM 在 OLE 反初始化前完成释放，
            // 避免 IDataObject 悬空导致系统拖拽通道被占用
            drop(data_object);
            drop(drop_source);
            drop(item);
            if hr.is_err() {
                return Err(format!(
                    "拖拽循环失败(0x{:X}): {}",
                    hr.0,
                    windows::core::Error::from(hr)
                ));
            }
            Ok(())
        }
    }
}

/// 递归下载远端目录/文件到 local_dir 下（目录会整体镜像为 local_dir/name/）
async fn download_remote_entry(
    sftp: &russh_sftp::client::SftpSession,
    remote_path: &str,
    local_dir: &std::path::Path,
) -> Result<(), String> {
    let meta = sftp
        .metadata(remote_path)
        .await
        .map_err(|e| format!("读取远端元数据失败: {e}"))?;
    if meta.is_dir() {
        let name = remote_path
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or(remote_path);
        let local_sub = local_dir.join(name);
        std::fs::create_dir_all(&local_sub).map_err(|e| format!("创建目录失败: {e}"))?;
        let entries = sftp
            .read_dir(remote_path)
            .await
            .map_err(|e| format!("读取远端目录失败: {e}"))?;
        for entry in entries {
            let fname = entry.file_name();
            if fname == "." || fname == ".." {
                continue;
            }
            let child_remote = format!("{remote_path}/{fname}");
            Box::pin(download_remote_entry(sftp, &child_remote, &local_sub)).await?;
        }
        Ok(())
    } else {
        let mut remote = sftp
            .open(remote_path)
            .await
            .map_err(|e| format!("打开远端文件失败: {e}"))?;
        let local_path = local_dir.join(
            remote_path
                .rsplit('/')
                .next()
                .unwrap_or("download.tmp"),
        );
        let mut local = tokio::fs::File::create(&local_path)
            .await
            .map_err(|e| format!("创建临时文件失败: {e}"))?;
        tokio::io::copy(&mut remote, &mut local)
            .await
            .map_err(|e| format!("下载失败: {e}"))?;
        Ok(())
    }
}

/// 预下载：把远端文件/文件夹取到临时目录，返回本地路径（文件夹则为其根目录）。
/// 前端在鼠标按下时立即调用（不等拖拽阈值），使真正拖拽开始时内容已就绪。
///
/// 临时区结构与拖出对象一一对应，不带时间戳包装层：
/// - 拖出文件 a.txt → conchterm-drag/a.txt
/// - 拖出文件夹 dir → conchterm-drag/dir/...
/// 同名冲突时在名字与扩展名之间插入 ~N（a~1.txt），既保源名又防覆盖。
#[tauri::command]
pub async fn prepare_file_drag(
    session_id: String,
    remote_path: String,
    file_name: String,
    sessions: tauri::State<'_, SessionMap>,
) -> Result<String, String> {
    let session = sessions
        .0
        .lock()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "会话不存在".to_string())?;
    let sftp = get_or_init_sftp(&session, false).await?;

    let root = temp_drag_dir();
    std::fs::create_dir_all(&root).map_err(|e| format!("创建临时目录失败: {e}"))?;

    // 保持源文件名；与已有残留重名时插入 ~N 序号
    let safe = sanitize_name(&file_name);
    let mut target = root.join(&safe);
    let mut n = 1u32;
    while target.exists() {
        let alt = match safe.rfind('.') {
            // 有扩展名：插在名字与点之间（隐藏文件如 .bashrc 视为无扩展名整体加尾缀）
            Some(idx) if idx > 0 => format!("{}~{}.{}", &safe[..idx], n, &safe[idx + 1..]),
            _ => format!("{}~{}", safe, n),
        };
        target = root.join(alt);
        n += 1;
    }

    // target 是文件本体或文件夹根，下载进其父目录
    let parent = target
        .parent()
        .ok_or_else(|| "临时路径异常".to_string())?
        .to_path_buf();
    {
        let inner = sftp.inner.lock().await;
        download_remote_entry(&inner, &remote_path, &parent).await?;
    }
    // download_remote_entry 以远端路径最后一段命名；若因 ~N 避让或 sanitize
    // 改写导致与 target 不同名，把下载产物改名到 target
    let downloaded_name = remote_path
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(&file_name);
    let downloaded = parent.join(sanitize_name(downloaded_name));
    if downloaded != target && downloaded.exists() {
        if target.is_dir() {
            std::fs::remove_dir(&target).ok(); // ~N 避让时预创建的空目录让位
        }
        std::fs::rename(&downloaded, &target).map_err(|e| format!("整理临时文件失败: {e}"))?;
    }
    Ok(target.to_string_lossy().into_owned())
}

/// Windows 文件名非法字符替换
fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

/// 发起原生拖拽。要求 prepare_file_drag 已完成（文件已在本地），
/// 这样 DoDragDrop 启动时用户左键仍处于按下状态，时序合法。
///
/// 实现要点：DoDragDrop 必须在有消息泵的 GUI 线程上运行（与 Electron/Qt
/// 同理）。后台线程起跑时鼠标消息无法正确路由给拖拽循环，会在系统层面
/// 留下坏掉的拖拽状态（Explorer 拖拽全局失效）。因此派发到 Tauri 主线程；
/// 模态循环自身会泵消息，主线程短暂“阻塞”不影响 UI 响应。
#[tauri::command]
pub async fn start_file_drag(
    app: tauri::AppHandle,
    local_path: String,
) -> Result<(), String> {
    let path = PathBuf::from(&local_path);
    if !path.exists() {
        return Err("拖拽文件尚未就绪".into());
    }

    #[cfg(target_os = "windows")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(windows_impl::run_drag_loop(&path));
        })
        .map_err(|e| format!("派发拖拽到主线程失败: {e}"))?;
        // 主线程进入模态拖拽循环（自行泵消息），这里异步等待其完成
        match rx.recv() {
            Ok(result) => result.map_err(|e| format!("拖拽失败: {e}")),
            Err(_) => Err("拖拽线程异常退出".into()),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("当前平台暂不支持拖出到资源管理器".into())
    }
}
