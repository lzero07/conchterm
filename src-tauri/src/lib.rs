mod drag_out;
mod ssh;

use ssh::{SessionMap, SshSession};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    drag_out::cleanup_temp_files();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionMap(Mutex::new(
            HashMap::<String, Arc<SshSession>>::new(),
        )))
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
            ssh::sftp_list,
            ssh::sftp_mkdir,
            ssh::sftp_remove,
            ssh::sftp_rename,
            ssh::sftp_upload,
            ssh::sftp_download,
            ssh::sftp_exists,
            drag_out::prepare_file_drag,
            drag_out::start_file_drag
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
