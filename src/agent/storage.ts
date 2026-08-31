// AI Provider 配置与聊天记录的本地持久化
// 注意：API Key 不在这里存储，走 Rust 端系统凭据管理器（见 src/agent/api.ts）

import type { AgentChatMessage, AgentProvider } from "./types";

const PROVIDERS_KEY = "conchterm.agentProviders";
const HISTORY_KEY = "conchterm.agentChat";
const ACTIVE_KEY = "conchterm.agentActiveProvider";
const HISTORY_LIMIT = 200;

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

export function loadHistory(): AgentChatMessage[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as AgentChatMessage[]) : [];
  } catch {
    return [];
  }
}

export function saveHistory(messages: AgentChatMessage[]): void {
  localStorage.setItem(
    HISTORY_KEY,
    JSON.stringify(messages.slice(-HISTORY_LIMIT))
  );
}

export function clearHistory(): void {
  localStorage.removeItem(HISTORY_KEY);
}

export function loadActiveProviderId(): string {
  return localStorage.getItem(ACTIVE_KEY) ?? "";
}

export function saveActiveProviderId(id: string): void {
  localStorage.setItem(ACTIVE_KEY, id);
}
