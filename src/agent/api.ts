// 智能体后端命令的 TS 调用封装

import { invoke, Channel } from "@tauri-apps/api/core";
import type { AgentChatMessage, AgentEvent, AgentProvider } from "./types";

export function agentSetKey(providerId: string, apiKey: string): Promise<void> {
  return invoke("agent_set_key", { providerId, apiKey });
}

export function agentDeleteKey(providerId: string): Promise<void> {
  return invoke("agent_delete_key", { providerId });
}

export function agentHasKey(providerId: string): Promise<boolean> {
  return invoke("agent_has_key", { providerId });
}

/** 发起聊天；onEvent 接收流式增量，resolve 返回请求 id 用于取消 */
export function agentChat(
  provider: AgentProvider,
  messages: AgentChatMessage[],
  onEvent: (event: AgentEvent) => void
): Promise<string> {
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  return invoke<string>("agent_chat", {
    provider: {
      id: provider.id,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      model: provider.model,
    },
    messages,
    onDelta: channel,
  });
}

export function agentCancel(requestId: string): Promise<void> {
  return invoke("agent_cancel", { requestId });
}
