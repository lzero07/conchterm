// 智能体后端命令的 TS 调用封装

import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  AgentChatMessage,
  AgentEvent,
  AgentProvider,
  AgentRequestMode,
} from "./types";

export function agentSetKey(providerId: string, apiKey: string): Promise<void> {
  return invoke("agent_set_key", { providerId, apiKey });
}

export function agentDeleteKey(providerId: string): Promise<void> {
  return invoke("agent_delete_key", { providerId });
}

export function agentHasKey(providerId: string): Promise<boolean> {
  return invoke("agent_has_key", { providerId });
}

/** 发起聊天；onEvent 接收流式增量，resolve 返回请求 id 用于取消。
 *  maxRounds 透传 Python 侧 Agent 工具调用轮数上限。 */
export function agentChat(
  provider: AgentProvider,
  messages: AgentChatMessage[],
  mode: AgentRequestMode,
  onEvent: (event: AgentEvent) => void,
  maxRounds?: number
): Promise<string> {
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  return invoke<string>("agent_chat", {
    provider: {
      id: provider.id,
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      model: provider.activeModel || provider.defaultModel,
    },
    messages,
    mode,
    maxRounds: maxRounds ?? null,
    onDelta: channel,
  });
}

/** 拉取 Provider 可用模型列表（经 Python sidecar 调 /models 接口）。
 *  apiKeyOverride：编辑表单里尚未保存的 Key，优先于凭据管理器中已存的。 */
export function agentListModels(
  provider: AgentProvider,
  onEvent: (event: AgentEvent) => void,
  apiKeyOverride?: string
): Promise<string> {
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  return invoke<string>("agent_list_models", {
    provider: {
      id: provider.id,
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      model: provider.defaultModel,
      overrideApiKey: apiKeyOverride ?? null,
    },
    onEvent: channel,
  });
}

export function agentToolResult(
  requestId: string,
  callId: string,
  approved: boolean,
  output: string
): Promise<void> {
  return invoke("agent_tool_result", { requestId, callId, approved, output });
}

export function agentCancel(requestId: string): Promise<void> {
  return invoke("agent_cancel", { requestId });
}
