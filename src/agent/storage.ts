// AI Provider 配置与聊天记录的本地持久化
// 注意：API Key 不在这里存储，走 Rust 端系统凭据管理器（见 src/agent/api.ts）

import type {
  AgentEntry,
  AgentMode,
  AgentProvider,
  MessageEntry,
} from "./types";

const PROVIDERS_KEY = "conchterm.agentProviders";
const SESSIONS_KEY = "conchterm.agentSessions";
/** 阶段 2 早期的单会话存储键，仅用于迁移 */
const LEGACY_HISTORY_KEY = "conchterm.agentChat";
const ACTIVE_KEY = "conchterm.agentActiveProvider";
const MODE_KEY = "conchterm.agentMode";
const HISTORY_LIMIT = 200;

export const DEFAULT_SESSION_TITLE = "新会话";

export interface AgentSessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentSessionIndex {
  sessions: AgentSessionMeta[];
  activeId: string;
}

const sessionEntriesKey = (id: string) => `conchterm.agentChat:${id}`;

/** 条目格式归一化：旧版消息迁移 + 未决工具卡改写为超时 */
function normalizeEntries(parsed: unknown): AgentEntry[] {
  if (!Array.isArray(parsed)) return [];
  return (parsed as unknown[])
    .map((item) => {
      const e = item as Record<string, unknown>;
      if (typeof e.kind === "string") {
        return e as unknown as AgentEntry;
      }
      if (e.role === "user" || e.role === "assistant") {
        const entry: MessageEntry = {
          kind: "message",
          id: crypto.randomUUID(),
          role: e.role,
          content: typeof e.content === "string" ? e.content : "",
        };
        return entry;
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
}

export function newSessionMeta(title: string = DEFAULT_SESSION_TITLE): AgentSessionMeta {
  return {
    id: crypto.randomUUID(),
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function loadSessionIndex(): AgentSessionIndex {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AgentSessionIndex;
      if (Array.isArray(parsed.sessions)) {
        return pruneEmptySessions(parsed);
      }
    }
  } catch {
    // 损坏则走迁移流程重建
  }
  // 迁移：早期版本只有一个全局对话
  const legacy = localStorage.getItem(LEGACY_HISTORY_KEY);
  if (legacy) {
    const meta = newSessionMeta("历史会话");
    try {
      localStorage.setItem(
        sessionEntriesKey(meta.id),
        JSON.stringify(normalizeEntries(JSON.parse(legacy)))
      );
    } catch {
      // 记录损坏就丢弃
    }
    localStorage.removeItem(LEGACY_HISTORY_KEY);
    const index: AgentSessionIndex = { sessions: [meta], activeId: meta.id };
    saveSessionIndex(index);
    return index;
  }
  return { sessions: [], activeId: "" };
}

/** 清理从未发送过消息的空「新会话」（历史 bug 累积的空壳） */
function pruneEmptySessions(index: AgentSessionIndex): AgentSessionIndex {
  const kept = index.sessions.filter(
    (s) =>
      s.title !== DEFAULT_SESSION_TITLE ||
      loadSessionEntries(s.id).length > 0
  );
  if (kept.length === 0) {
    return { sessions: [], activeId: "" };
  }
  if (kept.some((s) => s.id === index.activeId)) {
    return { sessions: kept, activeId: index.activeId };
  }
  return { sessions: kept, activeId: kept[0].id };
}

export function saveSessionIndex(index: AgentSessionIndex): void {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(index, null, 2));
}

export function loadSessionEntries(sessionId: string): AgentEntry[] {
  try {
    const raw = localStorage.getItem(sessionEntriesKey(sessionId));
    return raw ? normalizeEntries(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function saveSessionEntries(
  sessionId: string,
  entries: AgentEntry[]
): void {
  localStorage.setItem(
    sessionEntriesKey(sessionId),
    JSON.stringify(entries.slice(-HISTORY_LIMIT))
  );
}

export function deleteSessionEntries(sessionId: string): void {
  localStorage.removeItem(sessionEntriesKey(sessionId));
}

export function loadProviders(): AgentProvider[] {
  try {
    const raw = localStorage.getItem(PROVIDERS_KEY);
    return raw ? (JSON.parse(raw) as AgentProvider[]) : [];
  } catch {
    return [];
  }
}

export function saveProviders(providers: AgentProvider[]): void {
  localStorage.setItem(PROVIDERS_KEY, JSON.stringify(providers, null, 2));
}

export function loadMode(): AgentMode {
  return localStorage.getItem(MODE_KEY) === "agent" ? "agent" : "chat";
}

export function saveMode(mode: AgentMode): void {
  localStorage.setItem(MODE_KEY, mode);
}

export function loadActiveProviderId(): string {
  return localStorage.getItem(ACTIVE_KEY) ?? "";
}

export function saveActiveProviderId(id: string): void {
  localStorage.setItem(ACTIVE_KEY, id);
}
