// AI 会话/Provider 配置的存储层（façade）：底层是 Rust 端 SQLite（见 db.ts）。
// 注意：API Key 不在这里存储，走 Rust 端系统凭据管理器（见 src/agent/api.ts）
// 保存类函数保持同步 fire-and-forget 签名，调用方无需 await。

import {
  dbDeleteSession,
  dbGetActiveProvider,
  dbGetActiveSession,
  dbListProviders,
  dbListSessions,
  dbLoadEntries,
  dbReplaceEntries,
  dbSaveProviders,
  dbSaveSession,
  dbSetActiveProvider,
  dbSetActiveSession,
} from "./db";
import type { AgentEntry, AgentProvider } from "./types";

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

export function newSessionMeta(
  title: string = DEFAULT_SESSION_TITLE
): AgentSessionMeta {
  return {
    id: crypto.randomUUID(),
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const HISTORY_LIMIT = 200;

// ---------- 会话索引 ----------

/** 加载会话索引；空会话（从未发过消息）直接从库里剪掉 */
export async function loadSessionIndex(): Promise<AgentSessionIndex> {
  const sessions = await dbListSessions();
  const kept: AgentSessionMeta[] = [];
  for (const s of sessions) {
    if (s.title !== DEFAULT_SESSION_TITLE || s.entryCount > 0) {
      kept.push({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      });
    } else {
      dbDeleteSession(s.id).catch(() => {});
    }
  }
  if (kept.length === 0) {
    return { sessions: [], activeId: "" };
  }
  const activeId = await dbGetActiveSession();
  if (kept.some((s) => s.id === activeId)) {
    return { sessions: kept, activeId };
  }
  return { sessions: kept, activeId: kept[0].id };
}

/** fire-and-forget：逐会话 upsert；activeId 落 app_kv */
export function saveSessionIndex(index: AgentSessionIndex): void {
  index.sessions.forEach((s) => {
    dbSaveSession({ ...s, entryCount: 0 }).catch(() => {});
  });
  dbSetActiveSession(index.activeId).catch(() => {});
}

// ---------- 会话条目（高频写：模块级节流缓冲） ----------

interface PendingWrite {
  sessionId: string;
  entries: AgentEntry[];
}

let pending: PendingWrite | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let lastWriteAt = 0;
const THROTTLE_MS = 500;

function flushPending(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  if (!pending) return;
  const { sessionId, entries } = pending;
  pending = null;
  lastWriteAt = Date.now();
  dbReplaceEntries(sessionId, entries.slice(-HISTORY_LIMIT)).catch(() => {});
}

/** 立即写出待缓冲的条目（卸载兜底/测试用） */
export function flushPendingEntries(): void {
  flushPending();
}

/**
 * 全量保存会话条目：首写立即落库，流式期间的密集调用合并为
 * 每 500ms 一次尾写，避免每个 delta 都全量写库。
 */
export function saveSessionEntries(
  sessionId: string,
  entries: AgentEntry[]
): void {
  pending = { sessionId, entries: [...entries] };
  const sinceLast = Date.now() - lastWriteAt;
  if (sinceLast >= THROTTLE_MS) {
    flushPending();
    return;
  }
  if (!pendingTimer) {
    pendingTimer = setTimeout(flushPending, THROTTLE_MS - sinceLast);
  }
}

export async function loadSessionEntries(
  sessionId: string
): Promise<AgentEntry[]> {
  return dbLoadEntries(sessionId);
}

/** 删除会话条目；同会话的待写缓冲一并清空，防止「删除后被尾写复活」 */
export function deleteSessionEntries(sessionId: string): void {
  if (pending?.sessionId === sessionId) {
    pending = null;
  }
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  // 库里按会话删除
  void dbDeleteSession(sessionId).catch(() => {});
}

// ---------- Provider 配置 ----------

export async function loadProviders(): Promise<AgentProvider[]> {
  return dbListProviders();
}

export function saveProviders(providers: AgentProvider[]): void {
  dbSaveProviders(providers).catch(() => {});
}

export async function loadActiveProviderId(): Promise<string> {
  return dbGetActiveProvider();
}

export function saveActiveProviderId(id: string): void {
  dbSetActiveProvider(id).catch(() => {});
}
