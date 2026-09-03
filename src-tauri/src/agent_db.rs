//! AI 助手业务数据存储：SQLite（app 数据目录 agent.db）
//!
//! 承载会话索引、每会话消息条目、Provider 配置与长期记忆，
//! 替代前端 localStorage（usage.db 只管 Token 用量统计，互不相干）。
//! 前端首次调用任意命令前会先走 agent_legacy_import 迁移旧数据。

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

#[derive(Clone)]
pub struct AgentDb(pub Arc<Mutex<Connection>>);

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 打开（必要时创建）数据库并建表
pub fn init(app: &tauri::App) -> Result<AgentDb, Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let conn = Connection::open(dir.join("agent.db"))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS meta (
           key   TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
         CREATE TABLE IF NOT EXISTS sessions (
           id         TEXT PRIMARY KEY,
           title      TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
         CREATE TABLE IF NOT EXISTS session_entries (
           session_id TEXT NOT NULL,
           seq        INTEGER NOT NULL,
           id         TEXT NOT NULL,
           kind       TEXT NOT NULL,
           data       TEXT NOT NULL,
           PRIMARY KEY (session_id, seq)
         );
         CREATE TABLE IF NOT EXISTS providers (
           id            TEXT PRIMARY KEY,
           name          TEXT NOT NULL DEFAULT '',
           protocol      TEXT NOT NULL,
           base_url      TEXT NOT NULL,
           default_model TEXT NOT NULL DEFAULT '',
           models_json   TEXT NOT NULL DEFAULT '[]',
           active_model  TEXT NOT NULL DEFAULT '',
           has_key       INTEGER NOT NULL DEFAULT 0,
           created_at    INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS app_kv (
           key   TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS memories (
           id         INTEGER PRIMARY KEY AUTOINCREMENT,
           content    TEXT NOT NULL,
           source     TEXT NOT NULL DEFAULT 'manual',
           session_id TEXT,
           pinned     INTEGER NOT NULL DEFAULT 0,
           enabled    INTEGER NOT NULL DEFAULT 1,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_memories_rank
           ON memories(pinned DESC, updated_at DESC);",
    )?;
    Ok(AgentDb(Arc::new(Mutex::new(conn))))
}

// ---------- 共享结构（camelCase 与前端一一对应） ----------

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// 会话条目数（写入时忽略，查询时 LEFT JOIN 计算）
    #[serde(default)]
    pub entry_count: i64,
}

/// 一条消息/工具条目：真实列只留排序键与类型，形状归前端（data = 完整 AgentEntry JSON）
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryRow {
    pub seq: i64,
    pub id: String,
    pub kind: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRecord {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub protocol: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub default_model: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub active_model: String,
    #[serde(default)]
    pub has_key: bool,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: i64,
    pub content: String,
    /// 'auto' = AI 提取 | 'manual' = 手动
    pub source: String,
    pub session_id: Option<String>,
    pub pinned: bool,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

// ---------- 会话与条目 ----------

#[tauri::command]
pub async fn agent_sessions_list(db: State<'_, AgentDb>) -> Result<Vec<SessionMeta>, String> {
    let conn = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.title, s.created_at, s.updated_at,
                        COUNT(e.seq)
                 FROM sessions s
                 LEFT JOIN session_entries e ON e.session_id = s.id
                 GROUP BY s.id ORDER BY s.updated_at DESC",
            )
            .map_err(|e| format!("查询会话列表失败: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SessionMeta {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    entry_count: row.get(4)?,
                })
            })
            .map_err(|e| format!("查询会话列表失败: {e}"))?;
        let mut sessions = Vec::new();
        for session in rows {
            sessions.push(session.map_err(|e| format!("读取会话列表失败: {e}"))?);
        }
        Ok(sessions)
    })
    .await
    .map_err(|e| format!("会话列表任务失败: {e}"))?
}

#[tauri::command]
pub async fn agent_session_save(
    db: State<'_, AgentDb>,
    session: SessionMeta,
) -> Result<(), String> {
    let conn = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title, updated_at = excluded.updated_at",
            params![
                session.id,
                session.title,
                session.created_at,
                session.updated_at
            ],
        )
        .map_err(|e| format!("保存会话失败: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("保存会话任务失败: {e}"))?
}

#[tauri::command]
pub async fn agent_sessions_delete(
    db: State<'_, AgentDb>,
    session_id: String,
) -> Result<(), String> {
    let conn = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().unwrap();
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
            .map_err(|e| format!("删除会话失败: {e}"))?;
        conn.execute(
            "DELETE FROM session_entries WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(|e| format!("删除会话条目失败: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("删除会话任务失败: {e}"))?
}

#[tauri::command]
pub async fn agent_entries_load(
    db: State<'_, AgentDb>,
    session_id: String,
) -> Result<Vec<EntryRow>, String> {
    let conn = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT seq, id, kind, data FROM session_entries
                 WHERE session_id = ?1 ORDER BY seq",
            )
            .map_err(|e| format!("查询会话条目失败: {e}"))?;
        let rows = stmt
            .query_map(params![session_id], |row| {
                let data: String = row.get(3)?;
                Ok(EntryRow {
                    seq: row.get(0)?,
                    id: row.get(1)?,
                    kind: row.get(2)?,
                    data: serde_json::from_str(&data).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            3,
                            rusqlite::types::Type::Text,
                            e.into(),
                        )
                    })?,
                })
            })
            .map_err(|e| format!("查询会话条目失败: {e}"))?;
        let mut entries = Vec::new();
        for entry in rows {
            entries.push(entry.map_err(|e| format!("读取会话条目失败: {e}"))?);
        }
        Ok(entries)
    })
    .await
    .map_err(|e| format!("会话条目任务失败: {e}"))?
}

#[tauri::command]
pub async fn agent_entries_replace(
    db: State<'_, AgentDb>,
    session_id: String,
    entries: Vec<EntryRow>,
) -> Result<(), String> {
    let conn = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启事务失败: {e}"))?;
        tx.execute(
            "DELETE FROM session_entries WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(|e| format!("清空会话条目失败: {e}"))?;
        for entry in &entries {
            let data =
                serde_json::to_string(&entry.data).map_err(|e| format!("序列化条目失败: {e}"))?;
            tx.execute(
                "INSERT INTO session_entries (session_id, seq, id, kind, data)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![session_id, entry.seq, entry.id, entry.kind, data],
            )
            .map_err(|e| format!("写入会话条目失败: {e}"))?;
        }
        tx.commit().map_err(|e| format!("提交会话条目失败: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("会话条目写入任务失败: {e}"))?
}

// ---------- Provider（API Key 仍走系统凭据管理器，不入库） ----------

fn row_to_provider(row: &rusqlite::Row) -> rusqlite::Result<ProviderRecord> {
    let models_json: String = row.get(5)?;
    Ok(ProviderRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        protocol: row.get(2)?,
        base_url: row.get(3)?,
        default_model: row.get(4)?,
        models: serde_json::from_str(&models_json).unwrap_or_default(),
        active_model: row.get(6)?,
        has_key: row.get::<_, i64>(7)? != 0,
        created_at: row.get(8)?,
    })
}

#[tauri::command]
pub async fn agent_providers_list(db: State<'_, AgentDb>) -> Result<Vec<ProviderRecord>, String> {
    let conn = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, protocol, base_url, default_model,
                        models_json, active_model, has_key, created_at
                 FROM providers ORDER BY created_at",
            )
            .map_err(|e| format!("查询 Provider 列表失败: {e}"))?;
        let rows = stmt
            .query_map([], row_to_provider)
            .map_err(|e| format!("查询 Provider 列表失败: {e}"))?;
        let mut providers = Vec::new();
        for provider in rows {
            providers.push(provider.map_err(|e| format!("读取 Provider 列表失败: {e}"))?);
        }
        Ok(providers)
    })
    .await
    .map_err(|e| format!("Provider 列表任务失败: {e}"))?
}

#[tauri::command]
pub async fn agent_providers_save(
    db: State<'_, AgentDb>,
    providers: Vec<ProviderRecord>,
) -> Result<(), String> {
    let conn = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启事务失败: {e}"))?;
        tx.execute("DELETE FROM providers", [])
            .map_err(|e| format!("清空 Provider 失败: {e}"))?;
        for p in &providers {
            let models =
                serde_json::to_string(&p.models).map_err(|e| format!("序列化模型列表失败: {e}"))?;
            tx.execute(
                "INSERT INTO providers (id, name, protocol, base_url, default_model,
                                        models_json, active_model, has_key, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    p.id,
                    p.name,
                    p.protocol,
                    p.base_url,
                    p.default_model,
                    models,
                    p.active_model,
                    p.has_key as i64,
                    p.created_at,
                ],
            )
            .map_err(|e| format!("写入 Provider 失败: {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("提交 Provider 失败: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Provider 保存任务失败: {e}"))?
}

fn kv_get(conn: &Connection, key: &str) -> Result<String, String> {
    match conn.query_row(
        "SELECT value FROM app_kv WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    ) {
        Ok(value) => Ok(value),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(String::new()),
        Err(e) => Err(format!("读取配置失败: {e}")),
    }
}

#[tauri::command]
pub async fn agent_kv_get(db: State<'_, AgentDb>, key: String) -> Result<String, String> {
    let conn = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().unwrap();
        kv_get(&conn, &key)
    })
    .await
    .map_err(|e| format!("读取配置任务失败: {e}"))?
}

#[tauri::command]
pub async fn agent_kv_set(
    db: State<'_, AgentDb>,
    key: String,
    value: String,
) -> Result<(), String> {
    let conn = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().unwrap();
        conn.execute(
            "INSERT INTO app_kv (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(|e| format!("保存配置失败: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("保存配置任务失败: {e}"))?
}

// ---------- 长期记忆 ----------

fn row_to_memory(row: &rusqlite::Row) -> rusqlite::Result<Memory> {
    Ok(Memory {
        id: row.get(0)?,
        content: row.get(1)?,
        source: row.get(2)?,
        session_id: row.get(3)?,
        pinned: row.get::<_, i64>(4)? != 0,
        enabled: row.get::<_, i64>(5)? != 0,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

const MEMORY_COLS: &str =
    "id, content, source, session_id, pinned, enabled, created_at, updated_at";

#[tauri::command]
pub async fn agent_memories_list(db: State<'_, AgentDb>) -> Result<Vec<Memory>, String> {
    let conn = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {MEMORY_COLS} FROM memories
                 ORDER BY pinned DESC, updated_at DESC"
            ))
            .map_err(|e| format!("查询记忆列表失败: {e}"))?;
        let rows = stmt
            .query_map([], row_to_memory)
            .map_err(|e| format!("查询记忆列表失败: {e}"))?;
        let mut memories = Vec::new();
        for memory in rows {
            memories.push(memory.map_err(|e| format!("读取记忆列表失败: {e}"))?);
        }
        Ok(memories)
    })
    .await
    .map_err(|e| format!("记忆列表任务失败: {e}"))?
}

#[tauri::command]
pub async fn agent_memory_add(
    db: State<'_, AgentDb>,
    content: String,
    source: Option<String>,
    session_id: Option<String>,
) -> Result<Memory, String> {
    let conn = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().unwrap();
        let now = now_millis();
        conn.execute(
            "INSERT INTO memories (content, source, session_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                content,
                source.as_deref().unwrap_or("manual"),
                session_id,
                now,
                now,
            ],
        )
        .map_err(|e| format!("写入记忆失败: {e}"))?;
        let id = conn.last_insert_rowid();
        Ok(Memory {
            id,
            content,
            source: source.unwrap_or_else(|| "manual".to_string()),
            session_id,
            pinned: false,
            enabled: true,
            created_at: now,
            updated_at: now,
        })
    })
    .await
    .map_err(|e| format!("写入记忆任务失败: {e}"))?
}

#[tauri::command]
pub async fn agent_memory_update(
    db: State<'_, AgentDb>,
    id: i64,
    content: Option<String>,
    pinned: Option<bool>,
    enabled: Option<bool>,
) -> Result<(), String> {
    let conn = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().unwrap();
        conn.execute(
            "UPDATE memories SET
               content = COALESCE(?2, content),
               pinned  = COALESCE(?3, pinned),
               enabled = COALESCE(?4, enabled),
               updated_at = ?5
             WHERE id = ?1",
            params![id, content, pinned, enabled, now_millis()],
        )
        .map_err(|e| format!("更新记忆失败: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("更新记忆任务失败: {e}"))?
}

#[tauri::command]
pub async fn agent_memory_delete(db: State<'_, AgentDb>, id: i64) -> Result<(), String> {
    let conn = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().unwrap();
        conn.execute("DELETE FROM memories WHERE id = ?1", params![id])
            .map_err(|e| format!("删除记忆失败: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("删除记忆任务失败: {e}"))?
}

#[tauri::command]
pub async fn agent_memories_clear(db: State<'_, AgentDb>) -> Result<(), String> {
    let conn = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().unwrap();
        conn.execute("DELETE FROM memories", [])
            .map_err(|e| format!("清空记忆失败: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("清空记忆任务失败: {e}"))?
}

// ---------- 一次性迁移（localStorage -> SQLite，全部 upsert 幂等） ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntries {
    pub session_id: String,
    pub entries: Vec<EntryRow>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportArgs {
    pub providers: Vec<ProviderRecord>,
    pub active_provider_id: String,
    pub sessions: Vec<SessionMeta>,
    pub entries: Vec<SessionEntries>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportReport {
    providers: usize,
    sessions: usize,
    entries: usize,
}

#[tauri::command]
pub async fn agent_legacy_import(
    db: State<'_, AgentDb>,
    args: LegacyImportArgs,
) -> Result<LegacyImportReport, String> {
    let conn = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启事务失败: {e}"))?;
        for p in &args.providers {
            let models =
                serde_json::to_string(&p.models).map_err(|e| format!("序列化模型列表失败: {e}"))?;
            tx.execute(
                "INSERT INTO providers (id, name, protocol, base_url, default_model,
                                        models_json, active_model, has_key, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                   name = excluded.name, protocol = excluded.protocol,
                   base_url = excluded.base_url, default_model = excluded.default_model,
                   models_json = excluded.models_json, active_model = excluded.active_model,
                   has_key = excluded.has_key",
                params![
                    p.id,
                    p.name,
                    p.protocol,
                    p.base_url,
                    p.default_model,
                    models,
                    p.active_model,
                    p.has_key as i64,
                    p.created_at,
                ],
            )
            .map_err(|e| format!("导入 Provider 失败: {e}"))?;
        }
        for s in &args.sessions {
            tx.execute(
                "INSERT INTO sessions (id, title, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET
                   title = excluded.title, updated_at = excluded.updated_at",
                params![s.id, s.title, s.created_at, s.updated_at],
            )
            .map_err(|e| format!("导入会话失败: {e}"))?;
        }
        let mut entry_total = 0usize;
        for group in &args.entries {
            tx.execute(
                "DELETE FROM session_entries WHERE session_id = ?1",
                params![group.session_id],
            )
            .map_err(|e| format!("清理会话条目失败: {e}"))?;
            for entry in &group.entries {
                let data = serde_json::to_string(&entry.data)
                    .map_err(|e| format!("序列化条目失败: {e}"))?;
                tx.execute(
                    "INSERT INTO session_entries (session_id, seq, id, kind, data)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![group.session_id, entry.seq, entry.id, entry.kind, data],
                )
                .map_err(|e| format!("导入会话条目失败: {e}"))?;
                entry_total += 1;
            }
        }
        tx.execute(
            "INSERT INTO app_kv (key, value) VALUES ('active_provider_id', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![args.active_provider_id],
        )
        .map_err(|e| format!("导入活跃 Provider 失败: {e}"))?;
        tx.commit().map_err(|e| format!("提交迁移失败: {e}"))?;
        Ok(LegacyImportReport {
            providers: args.providers.len(),
            sessions: args.sessions.len(),
            entries: entry_total,
        })
    })
    .await
    .map_err(|e| format!("迁移任务失败: {e}"))?
}
