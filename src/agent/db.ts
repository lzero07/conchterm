// SQLite 存储的 TS 调用封装 + localStorage 一次性迁移
// 模式参照 src/monitor/api.ts：invoke + camelCase 参数镜像 Rust serde 结构

import { invoke } from "@tauri-apps/api/core";
import type { AgentEntry, AgentProvider } from "./types";

/** 会话元信息（与 Rust SessionMeta 一一对应） */
export interface DbSessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 条目数（LEFT JOIN 计算），用于空会话剪枝 */
  entryCount: number;
}

/** 条目行：data 为完整 AgentEntry JSON */
interface DbEntryRow {
  seq: number;
  id: string;
  kind: string;
  data: AgentEntry;
}

/** 长期记忆（与 Rust Memory 一一对应） */
export interface MemoryItem {
  id: number;
  content: string;
  source: "auto" | "manual";
  sessionId: string | null;
  pinned: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

// ---------- 一次性迁移：localStorage -> SQLite ----------

let migrated: Promise<void> | null = null;

/** 扫描不到任何旧键时跳过迁移（绝大多数启动的快路径） */
function hasLegacyData(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("conchterm.agent")) return true;
    }
  } catch {
    // localStorage 不可用（极端环境）就当没有旧数据
  }
  return false;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/**
 * 直接从 localStorage 读旧数据（不经 storage 层——那里已是 SQLite 封装，
 * 会回调 ensureMigrated 造成无限递归）。旧格式兼容逻辑与旧版 storage 一致。
 */
async function runMigration(): Promise<void> {
  if (!hasLegacyData()) return;

  // Provider：旧版单一 model 字段 -> 默认模型 + 模型列表 + 当前选中
  const providers: AgentProvider[] = (
    (readJson<Record<string, unknown>[]>("conchterm.agentProviders") ?? [])
      .map((p) => {
        const legacyModel = typeof p.model === "string" ? p.model : "";
        const defaultModel =
          typeof p.defaultModel === "string" && p.defaultModel
            ? p.defaultModel
            : legacyModel;
        const models =
          Array.isArray(p.models) && p.models.length > 0
            ? (p.models as string[])
            : defaultModel
              ? [defaultModel]
              : [];
        const activeModel =
          typeof p.activeModel === "string" && p.activeModel
            ? p.activeModel
            : defaultModel;
        return {
          ...p,
          name: typeof p.name === "string" ? p.name : String(p.id ?? ""),
          protocol: p.protocol === "anthropic" ? "anthropic" : "openai",
          baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : "",
          defaultModel,
          models,
          activeModel,
          hasKey: p.hasKey === true,
          createdAt:
            typeof p.createdAt === "number" ? p.createdAt : Date.now(),
        } as AgentProvider;
      })
      .filter((p) => typeof p.id === "string" && p.id !== "")
  );

  // 会话索引
  interface LegacySessionMeta {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
  }
  const parsedIndex = readJson<{
    sessions?: LegacySessionMeta[];
  }>("conchterm.agentSessions");
  const sessions: LegacySessionMeta[] = Array.isArray(parsedIndex?.sessions)
    ? parsedIndex!.sessions!
    : [];

  // 每会话条目：旧版消息迁移 + 未决工具卡改写为超时
  const normalizeEntries = (parsed: unknown): AgentEntry[] => {
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[])
      .map((item) => {
        const e = item as Record<string, unknown>;
        if (typeof e.kind === "string") return e as unknown as AgentEntry;
        if (e.role === "user" || e.role === "assistant") {
          return {
            kind: "message",
            id: crypto.randomUUID(),
            role: e.role,
            content: typeof e.content === "string" ? e.content : "",
          } as AgentEntry;
        }
        return null;
      })
      .filter((e): e is AgentEntry => e !== null)
      .map((e) =>
        e.kind === "tool"
          ? {
              ...e,
              status:
                e.status === "pending" || e.status === "running"
                  ? ("timeout" as const)
                  : e.status,
              collapsed: true,
            }
          : e
      );
  };
  const entryGroups: { sessionId: string; entries: unknown[] }[] = [];
  for (const s of sessions) {
    const parsed = readJson<unknown>(`conchterm.agentChat:${s.id}`);
    const entries = normalizeEntries(parsed);
    if (entries.length > 0) {
      entryGroups.push({
        sessionId: s.id,
        entries: entries.map((e, seq) => ({
          seq,
          id: e.id,
          kind: e.kind,
          data: e,
        })),
      });
    }
  }

  const activeProviderId =
    localStorage.getItem("conchterm.agentActiveProvider") ?? "";

  await invoke("agent_legacy_import", {
    args: { providers, activeProviderId, sessions, entries: entryGroups },
  });
  // 导入成功后才清空；中断最坏情形 = 双份存在，下次启动幂等重导
  try {
    localStorage.removeItem("conchterm.agentSessions");
    localStorage.removeItem("conchterm.agentProviders");
    localStorage.removeItem("conchterm.agentActiveProvider");
    localStorage.removeItem("conchterm.agentMode");
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("conchterm.agentChat:")) stale.push(key);
    }
    stale.forEach((k) => localStorage.removeItem(k));
  } catch {
    // 清理失败不影响使用，下次启动再试
  }
}

/** 模块级单例：首个存储调用触发一次迁移，后续调用复用同一 Promise */
export function ensureMigrated(): Promise<void> {
  if (!migrated) {
    migrated = runMigration().catch((err) => {
      migrated = null; // 失败允许下次重试
      throw err;
    });
  }
  return migrated;
}

// ---------- 会话与条目 ----------

export function dbListSessions(): Promise<DbSessionMeta[]> {
  return ensureMigrated().then(() => invoke("agent_sessions_list"));
}

export function dbSaveSession(session: DbSessionMeta): Promise<void> {
  return ensureMigrated().then(() =>
    invoke("agent_session_save", { session })
  );
}

export function dbDeleteSession(sessionId: string): Promise<void> {
  return ensureMigrated().then(() =>
    invoke("agent_sessions_delete", { sessionId })
  );
}

export async function dbLoadEntries(sessionId: string): Promise<AgentEntry[]> {
  await ensureMigrated();
  const rows = await invoke<DbEntryRow[]>("agent_entries_load", { sessionId });
  return rows.map((r) => r.data);
}

export function dbReplaceEntries(
  sessionId: string,
  entries: AgentEntry[]
): Promise<void> {
  const rows = entries.map((e, seq) => ({
    seq,
    id: e.id,
    kind: e.kind,
    data: e,
  }));
  return ensureMigrated().then(() =>
    invoke("agent_entries_replace", { sessionId, entries: rows })
  );
}

// ---------- Provider ----------

export function dbListProviders(): Promise<AgentProvider[]> {
  return ensureMigrated().then(() => invoke("agent_providers_list"));
}

export function dbSaveProviders(providers: AgentProvider[]): Promise<void> {
  return ensureMigrated().then(() =>
    invoke("agent_providers_save", { providers })
  );
}

export function dbGetActiveProvider(): Promise<string> {
  return ensureMigrated().then(() =>
    invoke("agent_kv_get", { key: "active_provider_id" })
  );
}

export function dbSetActiveProvider(id: string): Promise<void> {
  return ensureMigrated().then(() =>
    invoke("agent_kv_set", { key: "active_provider_id", value: id })
  );
}

/** 活跃会话 id 与 Provider 同样落 app_kv */
export function dbGetActiveSession(): Promise<string> {
  return ensureMigrated().then(() =>
    invoke("agent_kv_get", { key: "active_session_id" })
  );
}

export function dbSetActiveSession(id: string): Promise<void> {
  return ensureMigrated().then(() =>
    invoke("agent_kv_set", { key: "active_session_id", value: id })
  );
}

// ---------- 长期记忆 ----------

export function dbListMemories(): Promise<MemoryItem[]> {
  return ensureMigrated().then(() => invoke("agent_memories_list"));
}

export function dbAddMemory(
  content: string,
  source: "auto" | "manual",
  sessionId?: string | null
): Promise<MemoryItem> {
  return ensureMigrated().then(() =>
    invoke("agent_memory_add", { content, source, sessionId: sessionId ?? null })
  );
}

export function dbUpdateMemory(
  id: number,
  patch: { content?: string; pinned?: boolean; enabled?: boolean }
): Promise<void> {
  return ensureMigrated().then(() =>
    invoke("agent_memory_update", {
      id,
      content: patch.content ?? null,
      pinned: patch.pinned ?? null,
      enabled: patch.enabled ?? null,
    })
  );
}

export function dbDeleteMemory(id: number): Promise<void> {
  return ensureMigrated().then(() => invoke("agent_memory_delete", { id }));
}

export function dbClearMemories(): Promise<void> {
  return ensureMigrated().then(() => invoke("agent_memories_clear"));
}
