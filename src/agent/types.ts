// 智能体相关的共享类型

export type AgentProtocol = "openai" | "anthropic";

export type AgentMode = "chat" | "agent";

export interface AgentProvider {
  id: string;
  name: string;
  protocol: AgentProtocol;
  baseUrl: string;
  /** 默认模型（Provider 的首选） */
  defaultModel: string;
  /** 可用模型列表 */
  models: string[];
  /** 当前选中的模型（每个 Provider 各自记忆） */
  activeModel: string;
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
  type: "delta" | "done" | "error" | "tool_call" | "models";
  id: string;
  content?: string;
  message?: string;
  models?: string[];
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
  /** 默认收起；待确认的卡片保持展开 */
  collapsed: boolean;
  output?: string;
}

export type AgentEntry = MessageEntry | ToolEntry;
