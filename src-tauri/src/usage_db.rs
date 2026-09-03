//! Token 用量存储：SQLite（app 数据目录 usage.db）
//!
//! 每次 AI 回合结束（done 事件带 usage）落一条记录；
//! 监控中心通过 usage_query / usage_filter_options 聚合查询。

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::agent_bridge::TokenUsage;

#[derive(Clone)]
pub struct UsageDb(pub Arc<Mutex<Connection>>);

/// 一次 AI 请求的归属信息（由 agent_bridge 在发起请求时登记）
#[derive(Debug, Clone)]
pub struct RequestContext {
    pub provider_id: String,
    pub provider_name: String,
    pub model: String,
    pub protocol: String,
    pub mode: String,
}

/// 打开（必要时创建）数据库并建表
pub fn init(app: &tauri::App) -> Result<UsageDb, Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let conn = Connection::open(dir.join("usage.db"))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS token_usage (
           id            INTEGER PRIMARY KEY AUTOINCREMENT,
           ts            INTEGER NOT NULL,
           provider_id   TEXT NOT NULL,
           provider_name TEXT NOT NULL,
           model         TEXT NOT NULL,
           protocol      TEXT NOT NULL DEFAULT '',
           mode          TEXT NOT NULL DEFAULT 'chat',
           input_tokens  INTEGER NOT NULL DEFAULT 0,
           output_tokens INTEGER NOT NULL DEFAULT 0,
           total_tokens  INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_token_usage_ts ON token_usage(ts);
         CREATE INDEX IF NOT EXISTS idx_token_usage_provider
           ON token_usage(provider_id, model, ts);",
    )?;
    Ok(UsageDb(Arc::new(Mutex::new(conn))))
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 回合结束时写入一条用量记录
pub fn insert_usage(db: &UsageDb, ctx: &RequestContext, usage: &TokenUsage) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT INTO token_usage
           (ts, provider_id, provider_name, model, protocol, mode,
            input_tokens, output_tokens, total_tokens)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            now_millis(),
            ctx.provider_id,
            ctx.provider_name,
            ctx.model,
            ctx.protocol,
            ctx.mode,
            usage.input_tokens,
            usage.output_tokens,
            usage.total_tokens,
        ],
    )
    .map_err(|e| format!("写入用量记录失败: {e}"))?;
    Ok(())
}

// ---------- 查询命令 ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageQueryArgs {
    start_ts: i64,
    end_ts: i64,
    /// 空 = 全部
    #[serde(default)]
    provider_id: String,
    /// 空 = 全部
    #[serde(default)]
    model: String,
    /// "hour" | "day"；缺省按时间跨度自动选择
    #[serde(default)]
    granularity: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendPoint {
    bucket: String,
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSlice {
    provider_id: String,
    provider_name: String,
    requests: i64,
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSlice {
    provider_name: String,
    model: String,
    requests: i64,
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    requests: i64,
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    by_provider: Vec<ProviderSlice>,
    by_model: Vec<ModelSlice>,
    trend: Vec<TrendPoint>,
}

/// 筛选下拉的数据源：各 Provider 及其出现过的模型
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageOption {
    provider_id: String,
    provider_name: String,
    models: Vec<String>,
}

/// 统一的过滤条件：ts 范围 + 可选 provider/model
const WHERE_SQL: &str = "WHERE ts >= ?1 AND ts <= ?2
     AND (?3 = '' OR provider_id = ?3)
     AND (?4 = '' OR model = ?4)";

fn run_query(conn: &Connection, args: &UsageQueryArgs) -> Result<UsageReport, String> {
    let (start_ts, end_ts) = (args.start_ts, args.end_ts);
    let (provider_id, model) = (args.provider_id.as_str(), args.model.as_str());

    // 1. 汇总
    let (requests, input, output, total) = conn
        .query_row(
            &format!(
                "SELECT COUNT(*), COALESCE(SUM(input_tokens),0),
                        COALESCE(SUM(output_tokens),0), COALESCE(SUM(total_tokens),0)
                 FROM token_usage {WHERE_SQL}"
            ),
            params![start_ts, end_ts, provider_id, model],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .map_err(|e| format!("查询用量汇总失败: {e}"))?;

    // 2. 趋势（按小时/天分桶，本地时间）
    let granularity = match args.granularity.as_deref() {
        Some("hour") => "hour",
        Some("day") => "day",
        _ => {
            // 自动：跨度 ≤ 48 小时按小时，否则按天
            if end_ts - start_ts <= 48 * 3_600_000 {
                "hour"
            } else {
                "day"
            }
        }
    };
    let fmt = if granularity == "hour" {
        "%Y-%m-%d %H:00"
    } else {
        "%Y-%m-%d"
    };
    let mut trend = Vec::new();
    let mut stmt = conn
        .prepare(&format!(
            "SELECT strftime('{fmt}', ts/1000, 'unixepoch', 'localtime') AS bucket,
                    COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                    COALESCE(SUM(total_tokens),0)
             FROM token_usage {WHERE_SQL}
             GROUP BY bucket ORDER BY bucket"
        ))
        .map_err(|e| format!("查询用量趋势失败: {e}"))?;
    let rows = stmt
        .query_map(params![start_ts, end_ts, provider_id, model], |row| {
            Ok(TrendPoint {
                bucket: row.get(0)?,
                input_tokens: row.get(1)?,
                output_tokens: row.get(2)?,
                total_tokens: row.get(3)?,
            })
        })
        .map_err(|e| format!("查询用量趋势失败: {e}"))?;
    for point in rows {
        trend.push(point.map_err(|e| format!("读取用量趋势失败: {e}"))?);
    }

    // 3. 按 Provider 分布（名称为空的旧行回退显示 id，避免坐标轴出现空标签）
    let mut by_provider = Vec::new();
    let mut stmt = conn
        .prepare(&format!(
            "SELECT provider_id,
                    CASE WHEN MAX(provider_name) = '' THEN provider_id
                         ELSE MAX(provider_name) END,
                    COUNT(*),
                    COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                    COALESCE(SUM(total_tokens),0)
             FROM token_usage {WHERE_SQL}
             GROUP BY provider_id ORDER BY 6 DESC"
        ))
        .map_err(|e| format!("查询 Provider 分布失败: {e}"))?;
    let rows = stmt
        .query_map(params![start_ts, end_ts, provider_id, model], |row| {
            Ok(ProviderSlice {
                provider_id: row.get(0)?,
                provider_name: row.get(1)?,
                requests: row.get(2)?,
                input_tokens: row.get(3)?,
                output_tokens: row.get(4)?,
                total_tokens: row.get(5)?,
            })
        })
        .map_err(|e| format!("查询 Provider 分布失败: {e}"))?;
    for slice in rows {
        by_provider.push(slice.map_err(|e| format!("读取 Provider 分布失败: {e}"))?);
    }

    // 4. 按模型分布（同样对空名称回退 id）
    let mut by_model = Vec::new();
    let mut stmt = conn
        .prepare(&format!(
            "SELECT CASE WHEN MAX(provider_name) = '' THEN provider_id
                         ELSE MAX(provider_name) END,
                    model, COUNT(*),
                    COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                    COALESCE(SUM(total_tokens),0)
             FROM token_usage {WHERE_SQL}
             GROUP BY provider_id, model ORDER BY 6 DESC LIMIT 100"
        ))
        .map_err(|e| format!("查询模型分布失败: {e}"))?;
    let rows = stmt
        .query_map(params![start_ts, end_ts, provider_id, model], |row| {
            Ok(ModelSlice {
                provider_name: row.get(0)?,
                model: row.get(1)?,
                requests: row.get(2)?,
                input_tokens: row.get(3)?,
                output_tokens: row.get(4)?,
                total_tokens: row.get(5)?,
            })
        })
        .map_err(|e| format!("查询模型分布失败: {e}"))?;
    for slice in rows {
        by_model.push(slice.map_err(|e| format!("读取模型分布失败: {e}"))?);
    }

    Ok(UsageReport {
        requests,
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        by_provider,
        by_model,
        trend,
    })
}

#[tauri::command]
pub async fn usage_query(
    db: State<'_, UsageDb>,
    args: UsageQueryArgs,
) -> Result<UsageReport, String> {
    let conn = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().unwrap();
        run_query(&conn, &args)
    })
    .await
    .map_err(|e| format!("用量查询任务失败: {e}"))?
}

#[tauri::command]
pub async fn usage_filter_options(
    db: State<'_, UsageDb>,
) -> Result<Vec<ProviderUsageOption>, String> {
    let conn = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().unwrap();
        // 只列出现过的 Provider：有用量记录才出现在筛选里（名称为空回退 id）
        let mut stmt = conn
            .prepare(
                "SELECT provider_id,
                        CASE WHEN MAX(provider_name) = '' THEN provider_id
                             ELSE MAX(provider_name) END,
                        COALESCE(GROUP_CONCAT(DISTINCT model), '')
                 FROM token_usage GROUP BY provider_id ORDER BY 2",
            )
            .map_err(|e| format!("查询筛选选项失败: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                let models_csv: String = row.get(2)?;
                Ok(ProviderUsageOption {
                    provider_id: row.get(0)?,
                    provider_name: row.get(1)?,
                    models: models_csv
                        .split(',')
                        .filter(|m| !m.is_empty())
                        .map(str::to_string)
                        .collect(),
                })
            })
            .map_err(|e| format!("查询筛选选项失败: {e}"))?;
        let mut options = Vec::new();
        for option in rows {
            options.push(option.map_err(|e| format!("读取筛选选项失败: {e}"))?);
        }
        Ok(options)
    })
    .await
    .map_err(|e| format!("筛选选项查询任务失败: {e}"))?
}

/// 删除 Provider 时连带清掉它的历史用量记录（监控中心不再出现已删 Provider）
#[tauri::command]
pub async fn usage_delete_provider(
    db: State<'_, UsageDb>,
    provider_id: String,
) -> Result<(), String> {
    let conn = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().unwrap();
        conn.execute(
            "DELETE FROM token_usage WHERE provider_id = ?1",
            params![provider_id],
        )
        .map_err(|e| format!("删除 Provider 用量记录失败: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("删除用量记录任务失败: {e}"))?
}
