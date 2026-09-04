mod agent_bridge;
mod agent_db;
mod drag_out;
mod llm;
mod ssh;
mod tray;
mod usage_db;

use ssh::{SessionMap, SshSession};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    drag_out::cleanup_temp_files();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            tray::init(app)?;
            app.manage(usage_db::init(app)?);
            app.manage(agent_db::init(app)?);
            Ok(())
        })
        .manage(SessionMap(Mutex::new(
            HashMap::<String, Arc<SshSession>>::new(),
        )))
        .manage(agent_bridge::AgentState::new().expect("初始化 LLM 客户端失败"))
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
            ssh::ssh_exec,
            ssh::sftp_list,
            ssh::sftp_mkdir,
            ssh::sftp_remove,
            ssh::sftp_rename,
            ssh::sftp_upload,
            ssh::sftp_download,
            ssh::sftp_exists,
            ssh::sysstat_start,
            ssh::sysstat_stop,
            drag_out::prepare_file_drag,
            drag_out::start_file_drag,
            tray::set_tray_visible,
            agent_bridge::agent_chat,
            agent_bridge::agent_list_models,
            agent_bridge::agent_tool_result,
            agent_bridge::agent_cancel,
            agent_bridge::agent_set_key,
            agent_bridge::agent_delete_key,
            agent_bridge::agent_has_key,
            usage_db::usage_query,
            usage_db::usage_filter_options,
            usage_db::usage_delete_provider,
            agent_db::agent_sessions_list,
            agent_db::agent_session_save,
            agent_db::agent_sessions_delete,
            agent_db::agent_entries_load,
            agent_db::agent_entries_replace,
            agent_db::agent_providers_list,
            agent_db::agent_providers_save,
            agent_db::agent_kv_get,
            agent_db::agent_kv_set,
            agent_db::agent_memories_list,
            agent_db::agent_memory_add,
            agent_db::agent_memory_update,
            agent_db::agent_memory_delete,
            agent_db::agent_memories_clear,
            agent_db::agent_legacy_import
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
