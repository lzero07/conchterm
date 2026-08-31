// 智能体相关的共享类型

export type AgentProtocol = "openai" | "anthropic";

export interface AgentProvider {
  id: string;
  name: string;
  protocol: AgentProtocol;
  baseUrl: string;
  model: string;
  /** Key 本体存系统凭据管理器，这里只标记是否存在 */
  hasKey: boolean;
  createdAt: number;
}

export interface AgentChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Rust 端转发的 Python 流式事件 */
export interface AgentEvent {
  type: "delta" | "done" | "error";
  id: string;
  content?: string;
  message?: string;
}
