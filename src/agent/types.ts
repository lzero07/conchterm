// 智能体相关的共享类型

export type AgentProtocol = "openai" | "anthropic";

export type AgentMode = "chat" | "agent";

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
  type: "delta" | "done" | "error" | "tool_call";
  id: string;
  content?: string;
  message?: string;
  callId?: string;
  tool?: string;
  args?: Record<string, unknown>;
}

// ---------- 聊天记录条目（消息与工具调用卡片） ----------

export type ToolStatus =
  | "pending"
  | "running"
  | "approved"
  | "rejected"
  | "error"
  | "timeout";

export interface MessageEntry {
  kind: "message";
  id: string;
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

export interface ToolEntry {
  kind: "tool";
  id: string;
  /** Python 侧的调用 id（tool_result 回传用） */
  callId: string;
  /** 所属请求 id */
  requestId: string;
  tool: string;
  command: string;
  status: ToolStatus;
  output?: string;
}

export type AgentEntry = MessageEntry | ToolEntry;
