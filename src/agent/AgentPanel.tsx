import { useEffect, useRef, useState } from "react";
import {
  Bot,
  ChevronRight,
  Eraser,
  LoaderCircle,
  MessageSquarePlus,
  MessageSquare,
  Pencil,
  Plus,
  Send,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import ProviderForm from "./ProviderForm";
import { sshExec } from "../api";
import {
  agentCancel,
  agentChat,
  agentDeleteKey,
  agentHasKey,
  agentSetKey,
  agentToolResult,
} from "./api";
import {
  loadActiveProviderId,
  deleteSessionEntries,
  DEFAULT_SESSION_TITLE,
  loadMode,
  loadSessionEntries,
  loadSessionIndex,
  loadProviders,
  saveActiveProviderId,
  saveMode,
  saveProviders,
  saveSessionEntries,
  saveSessionIndex,
  newSessionMeta,
} from "./storage";
import type { AgentSessionIndex } from "./storage";
import type {
  AgentChatMessage,
  AgentEntry,
  AgentEvent,
  AgentMode,
  AgentProvider,
  MessageEntry,
  ToolEntry,
  ToolStatus,
} from "./types";

interface ActiveStream {
  /** 请求首个助手条目 id，用于识别过期事件 */
  entryId: string;
  /** 当前正在流式追加的助手气泡（工具调用后会另起新气泡） */
  messageEntryId: string;
  requestId: string | null;
  cancelled: boolean;
}

export interface SessionInfo {
  id: string;
  title: string;
}

interface Props {
  sessions: SessionInfo[];
  activeTerminalId: string | null;
}

const SYSTEM_PROMPT =
  "你是 ConchTerm SSH 终端内置的 AI 助手，回答简洁直接，优先给出可执行的命令或步骤。";

const AGENT_PROMPT_EXTRA =
  "\n你处于 Agent 模式，可以通过 run_command 工具在用户的 SSH 会话中执行命令。" +
  "调用工具前先用一句话说明你要做什么；对 rm、重启服务等危险命令要说明后果。" +
  "得到输出后基于结果给出总结。";

const TOOL_STATUS_LABEL: Record<ToolStatus, string> = {
  pending: "等待确认",
  running: "执行中…",
  approved: "已执行",
  rejected: "已拒绝",
  error: "执行失败",
  timeout: "确认超时",
};

/** AI 助手侧栏面板：问答 / Agent 双模式，流式聊天与命令确认 */
export default function AgentPanel({ sessions, activeTerminalId }: Props) {
  const [providers, setProviders] = useState<AgentProvider[]>(loadProviders);
  const [activeId, setActiveId] = useState<string>(loadActiveProviderId);
  const [mode, setMode] = useState<AgentMode>(loadMode);
  const [sessionIndex, setSessionIndex] =
    useState<AgentSessionIndex>(loadSessionIndex);
  const [targetSessionId, setTargetSessionId] = useState<string>(
    activeTerminalId ?? sessions[0]?.id ?? ""
  );
  const [entries, setEntries] = useState<AgentEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AgentProvider | null>(null);
  const activeStreamRef = useRef<ActiveStream | null>(null);
  const msgsRef = useRef<HTMLDivElement | null>(null);

  // 思考中指示：请求进行中、当前气泡还没有输出、且没有在等确认/执行工具
  const activeStream = activeStreamRef.current;
  const waitingTool = entries.some(
    (e) =>
      e.kind === "tool" && (e.status === "pending" || e.status === "running")
  );
  const currentBubble = entries.find(
    (e): e is MessageEntry =>
      e.kind === "message" && e.id === activeStream?.messageEntryId
  );
  const thinking =
    busy &&
    !waitingTool &&
    !!activeStream &&
    !activeStream.cancelled &&
    (currentBubble?.content ?? "") === "";

  const activeProvider =
    providers.find((p) => p.id === activeId) ?? providers[0] ?? null;
  const targetSession = sessions.find((s) => s.id === targetSessionId) ?? null;
  const activeSessionId = sessionIndex.activeId;
  const sortedSessions = [...sessionIndex.sessions].sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
  // 会话刚载入时跳过一次保存，避免用空数组覆盖已存记录
  const skipSaveRef = useRef(true);

  // 启动时用系统凭据管理器的实际状态校准 hasKey 标记
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      loadProviders().map(async (p) => ({
        id: p.id,
        hasKey: await agentHasKey(p.id).catch(() => p.hasKey),
      }))
    ).then((flags) => {
      if (cancelled) return;
      setProviders((prev) => {
        const next = prev.map((p) => ({
          ...p,
          hasKey: flags.find((f) => f.id === p.id)?.hasKey ?? p.hasKey,
        }));
        saveProviders(next);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 活跃终端变化时跟随切换目标会话
  useEffect(() => {
    if (activeTerminalId) setTargetSessionId(activeTerminalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTerminalId]);

  // 没有任何会话时自动创建一个
  useEffect(() => {
    if (!sessionIndex.sessions.length) {
      const meta = newSessionMeta();
      const next: AgentSessionIndex = {
        sessions: [meta],
        activeId: meta.id,
      };
      setSessionIndex(next);
      saveSessionIndex(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换会话时载入对应记录
  useEffect(() => {
    skipSaveRef.current = true;
    setEntries(activeSessionId ? loadSessionEntries(activeSessionId) : []);
  }, [activeSessionId]);

  useEffect(() => {
    if (skipSaveRef.current) {
      skipSaveRef.current = false;
      return;
    }
    if (activeSessionId) saveSessionEntries(activeSessionId, entries);
  }, [entries, activeSessionId]);

  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight });
  }, [entries]);

  const updateMessage = (
    entryId: string,
    fn: (e: MessageEntry) => MessageEntry
  ) => {
    setEntries((prev) =>
      prev.map((e) => (e.id === entryId && e.kind === "message" ? fn(e) : e))
    );
  };

  const updateTool = (callId: string, fn: (e: ToolEntry) => ToolEntry) => {
    setEntries((prev) =>
      prev.map((e) => (e.kind === "tool" && e.callId === callId ? fn(e) : e))
    );
  };

  const toggleTool = (callId: string) => {
    updateTool(callId, (t) => ({ ...t, collapsed: !t.collapsed }));
  };

  const finishStream = () => {
    activeStreamRef.current = null;
    setBusy(false);
  };

  const handleEvent = (event: AgentEvent, entryId: string) => {
    const stream = activeStreamRef.current;
    if (!stream || stream.entryId !== entryId) return;

    if (event.type === "delta") {
      if (stream.cancelled) return;
      updateMessage(stream.messageEntryId, (e) => ({
        ...e,
        content: e.content + (event.content ?? ""),
      }));
      return;
    }
    if (event.type === "tool_call") {
      if (stream.cancelled) return;
      const command =
        typeof event.args?.command === "string" ? event.args.command : "";
      setEntries((prev) => [
        ...prev,
        {
          kind: "tool",
          id: crypto.randomUUID(),
          callId: event.callId ?? "",
          requestId: stream.requestId ?? "",
          tool: event.tool ?? "",
          command,
          status: "pending",
          collapsed: false,
        },
      ]);
      // 工具之后的文本应显示在命令下方，另起一个助手气泡
      const nextEntry: MessageEntry = {
        kind: "message",
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
      };
      setEntries((prev) => [...prev, nextEntry]);
      stream.messageEntryId = nextEntry.id;
      return;
    }
    if (event.type === "done") {
      if (event.id === stream.requestId) finishStream();
      return;
    }
    // error：空 id 表示进程级错误，否则是当前请求失败
    if (!event.id || event.id === stream.requestId) {
      updateMessage(stream.messageEntryId, (e) => ({
        ...e,
        content: e.content || event.message || "未知错误",
        error: true,
      }));
      finishStream();
    }
  };

  const send = async () => {
    const provider = activeProvider;
    const text = input.trim();
    if (!provider || !text || busy || !activeSessionId) return;
    if (mode === "agent" && !targetSession) return;

    const userEntry: MessageEntry = {
      kind: "message",
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };
    const assistantEntry: MessageEntry = {
      kind: "message",
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
    };
    const history = [...entries, userEntry, assistantEntry];
    setEntries(history);

    // 首条消息生成会话标题；每次发言刷新活跃时间
    const activeMeta = sessionIndex.sessions.find(
      (s) => s.id === activeSessionId
    );
    if (activeMeta) {
      const title =
        activeMeta.title === DEFAULT_SESSION_TITLE
          ? text.slice(0, 20)
          : activeMeta.title;
      const nextIndex: AgentSessionIndex = {
        sessions: sessionIndex.sessions.map((s) =>
          s.id === activeMeta.id ? { ...s, title, updatedAt: Date.now() } : s
        ),
        activeId: activeSessionId,
      };
      setSessionIndex(nextIndex);
      saveSessionIndex(nextIndex);
    }

    setInput("");
    setBusy(true);
    activeStreamRef.current = {
      entryId: assistantEntry.id,
      messageEntryId: assistantEntry.id,
      requestId: null,
      cancelled: false,
    };

    // 上下文只带消息条目；空内容的占位/已取消条目不进入
    const payload: AgentChatMessage[] = [
      {
        role: "system",
        content:
          mode === "agent" ? SYSTEM_PROMPT + AGENT_PROMPT_EXTRA : SYSTEM_PROMPT,
      },
      ...history
        .filter(
          (e): e is MessageEntry =>
            e.kind === "message" &&
            e.id !== assistantEntry.id &&
            e.content.trim() !== ""
        )
        .map((e) => ({ role: e.role, content: e.content })),
    ];

    try {
      const requestId = await agentChat(provider, payload, mode, (event) =>
        handleEvent(event, assistantEntry.id)
      );
      if (activeStreamRef.current?.entryId === assistantEntry.id) {
        activeStreamRef.current.requestId = requestId;
      } else {
        // 等待 invoke 返回期间已被取消
        agentCancel(requestId).catch(() => {});
      }
    } catch (err) {
      updateMessage(assistantEntry.id, (e) => ({
        ...e,
        content: e.content || String(err),
        error: true,
      }));
      finishStream();
    }
  };

  const stop = () => {
    const stream = activeStreamRef.current;
    if (stream) {
      stream.cancelled = true;
      if (stream.requestId) agentCancel(stream.requestId).catch(() => {});
    }
    finishStream();
  };

  const clearChat = () => {
    stop();
    setEntries([]);
  };

  const switchSession = (id: string) => {
    if (id === activeSessionId) return;
    // 流式进行中切换会把增量写进错误会话，先取消
    stop();
    const next: AgentSessionIndex = { ...sessionIndex, activeId: id };
    setSessionIndex(next);
    saveSessionIndex(next);
  };

  const createSession = () => {
    // 没发送过消息的空会话直接复用，不重复新建
    const activeMeta = sessionIndex.sessions.find(
      (s) => s.id === activeSessionId
    );
    if (activeMeta?.title === DEFAULT_SESSION_TITLE && entries.length === 0) {
      return;
    }
    const emptySession = sessionIndex.sessions.find(
      (s) =>
        s.title === DEFAULT_SESSION_TITLE &&
        loadSessionEntries(s.id).length === 0
    );
    if (emptySession) {
      switchSession(emptySession.id);
      return;
    }
    const meta = newSessionMeta();
    const next: AgentSessionIndex = {
      sessions: [meta, ...sessionIndex.sessions],
      activeId: meta.id,
    };
    setSessionIndex(next);
    saveSessionIndex(next);
  };

  const removeSession = (id: string) => {
    if (!confirm("删除当前会话及其聊天记录？")) return;
    stop();
    deleteSessionEntries(id);
    const rest = sessionIndex.sessions.filter((s) => s.id !== id);
    if (rest.length === 0) {
      const meta = newSessionMeta();
      const next: AgentSessionIndex = { sessions: [meta], activeId: meta.id };
      setSessionIndex(next);
      saveSessionIndex(next);
      return;
    }
    const nextActive =
      id === activeSessionId
        ? [...rest].sort((a, b) => b.updatedAt - a.updatedAt)[0].id
        : activeSessionId;
    const next: AgentSessionIndex = { sessions: rest, activeId: nextActive };
    setSessionIndex(next);
    saveSessionIndex(next);
  };

  const switchMode = (next: AgentMode) => {
    setMode(next);
    saveMode(next);
  };

  const approveTool = async (entry: ToolEntry) => {
    if (!targetSession) return;
    updateTool(entry.callId, (t) => ({ ...t, status: "running" }));
    try {
      const output = await sshExec(targetSession.id, entry.command);
      updateTool(entry.callId, (t) => ({
        ...t,
        status: "approved",
        collapsed: true,
        output,
      }));
      await agentToolResult(entry.requestId, entry.callId, true, output);
    } catch (err) {
      const message = `执行失败: ${String(err)}`;
      updateTool(entry.callId, (t) => ({
        ...t,
        status: "error",
        collapsed: true,
        output: message,
      }));
      // 执行失败也如实回传，让模型有机会调整策略
      await agentToolResult(entry.requestId, entry.callId, true, message);
    }
  };

  const rejectTool = async (entry: ToolEntry) => {
    updateTool(entry.callId, (t) => ({
      ...t,
      status: "rejected",
      collapsed: true,
    }));
    await agentToolResult(entry.requestId, entry.callId, false, "");
  };

  const persistProviders = (next: AgentProvider[]) => {
    setProviders(next);
    saveProviders(next);
  };

  const changeProvider = (id: string) => {
    setActiveId(id);
    saveActiveProviderId(id);
  };

  const removeProvider = (provider: AgentProvider) => {
    if (!confirm(`删除 Provider「${provider.name}」？`)) return;
    const next = providers.filter((p) => p.id !== provider.id);
    persistProviders(next);
    agentDeleteKey(provider.id).catch(() => {});
    if (activeId === provider.id) {
      const fallback = next[0]?.id ?? "";
      changeProvider(fallback);
    }
  };

  const saveProvider = async (provider: AgentProvider, apiKey: string) => {
    let saved = provider;
    if (apiKey) {
      try {
        await agentSetKey(provider.id, apiKey);
        saved = { ...provider, hasKey: true };
      } catch (err) {
        alert(`保存 API Key 失败：${String(err)}`);
        return;
      }
    }
    const exists = providers.some((p) => p.id === saved.id);
    persistProviders(
      exists
        ? providers.map((p) => (p.id === saved.id ? saved : p))
        : [...providers, saved]
    );
    if (!activeProvider) {
      changeProvider(saved.id);
    }
    setFormOpen(false);
  };

  return (
    <div className="panel agent-panel">
      <div className="panel-header">
        <span>AI 助手</span>
        <span className="panel-header-actions">
          <button
            className="icon-btn"
            title="清空当前会话"
            onClick={clearChat}
          >
            <Eraser size={13} strokeWidth={1.8} />
          </button>
          <button
            className="icon-btn"
            title="添加 Provider"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus size={15} strokeWidth={2} />
          </button>
        </span>
      </div>

      {providers.length === 0 ? (
        <div className="empty-state agent-empty">
          <span className="empty-icon">
            <Bot size={26} strokeWidth={1.5} />
          </span>
          <p>还没有 AI Provider</p>
          <span>支持 OpenAI 兼容接口与 Anthropic</span>
          <button
            className="primary"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            添加 Provider
          </button>
        </div>
      ) : (
        <>
          <div className="agent-provider-bar">
            <select
              value={activeProvider?.id ?? ""}
              onChange={(e) => changeProvider(e.target.value)}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.hasKey ? "" : "（未配置 Key）"}
                </option>
              ))}
            </select>
            <button
              className="icon-btn"
              title="编辑"
              onClick={() => {
                setEditing(activeProvider);
                setFormOpen(true);
              }}
            >
              <Pencil size={13} strokeWidth={1.8} />
            </button>
            <button
              className="icon-btn danger"
              title="删除"
              onClick={() => activeProvider && removeProvider(activeProvider)}
            >
              <Trash2 size={13} strokeWidth={1.8} />
            </button>
          </div>

          <div className="agent-session-bar">
            <select
              value={activeSessionId}
              title="历史会话"
              onChange={(e) => switchSession(e.target.value)}
            >
              {sortedSessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
            <button
              className="icon-btn"
              title="新建会话"
              onClick={createSession}
            >
              <MessageSquarePlus size={13} strokeWidth={1.8} />
            </button>
            <button
              className="icon-btn danger"
              title="删除当前会话"
              onClick={() => activeSessionId && removeSession(activeSessionId)}
            >
              <Trash2 size={13} strokeWidth={1.8} />
            </button>
          </div>

          <div className="agent-msgs" ref={msgsRef}>
            {entries.map((e) =>
              e.kind === "message" ? (
                <div
                  key={e.id}
                  className={`agent-msg ${e.role}${e.error ? " error" : ""}`}
                >
                  {e.content}
                </div>
              ) : (
                <div
                  key={e.id}
                  className={`agent-tool ${e.status}${e.collapsed ? " collapsed" : ""}`}
                >
                  <div
                    className="agent-tool-summary"
                    onClick={
                      e.status === "pending"
                        ? undefined
                        : () => toggleTool(e.callId)
                    }
                  >
                    {e.status === "pending" ? (
                      <Terminal size={12} strokeWidth={2} />
                    ) : (
                      <ChevronRight
                        size={12}
                        strokeWidth={2}
                        className={`agent-tool-chevron${e.collapsed ? "" : " open"}`}
                      />
                    )}
                    <span className="agent-tool-title">{e.tool}</span>
                    <code className="agent-tool-brief">{e.command}</code>
                    <span className="agent-tool-status">
                      {TOOL_STATUS_LABEL[e.status]}
                    </span>
                  </div>
                  {!e.collapsed && (
                    <>
                      <code className="agent-tool-command">{e.command}</code>
                      {e.status === "pending" ? (
                        <div className="agent-tool-actions">
                          <button
                            className="primary"
                            disabled={!busy || !targetSession}
                            onClick={() => approveTool(e)}
                          >
                            批准执行
                          </button>
                          <button
                            disabled={!busy}
                            onClick={() => rejectTool(e)}
                          >
                            拒绝
                          </button>
                        </div>
                      ) : (
                        e.output && (
                          <pre className="agent-tool-output">{e.output}</pre>
                        )
                      )}
                    </>
                  )}
                </div>
              )
            )}
            {thinking && (
              <div className="agent-thinking">
                <LoaderCircle size={13} strokeWidth={2} />
                思考中…
              </div>
            )}
          </div>

          <div className="agent-controls">
            <div className="agent-modes">
              <button
                className={mode === "chat" ? "active" : ""}
                title="问答模式：仅对话，不执行命令"
                onClick={() => switchMode("chat")}
              >
                <MessageSquare size={12} strokeWidth={2} />
                问答
              </button>
              <button
                className={mode === "agent" ? "active" : ""}
                title="Agent 模式：将自然语言转为命令，经确认后执行"
                onClick={() => switchMode("agent")}
              >
                <Terminal size={12} strokeWidth={2} />
                Agent
              </button>
            </div>
            {mode === "agent" && sessions.length > 0 && (
              <select
                className="agent-session-select"
                value={targetSessionId}
                title="选择命令执行的目标会话"
                onChange={(e) => setTargetSessionId(e.target.value)}
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            )}
            {mode === "agent" && sessions.length === 0 && (
              <span className="agent-session-hint">
                先连接服务器才能执行命令
              </span>
            )}
          </div>

          <div className="agent-input">
            <textarea
              rows={2}
              value={input}
              placeholder={
                mode === "agent"
                  ? "描述你想做的事，Agent 会转化为命令（执行前需确认）…"
                  : "问点什么…（Enter 发送，Shift+Enter 换行）"
              }
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {busy ? (
              <button className="agent-stop" title="停止生成" onClick={stop}>
                <Square size={13} strokeWidth={2} />
              </button>
            ) : (
              <button
                className="agent-send"
                title="发送"
                disabled={
                  !input.trim() ||
                  !activeProvider ||
                  (mode === "agent" && !targetSession)
                }
                onClick={send}
              >
                <Send size={14} strokeWidth={2} />
              </button>
            )}
          </div>
        </>
      )}

      {formOpen && (
        <ProviderForm
          initial={editing}
          onCancel={() => setFormOpen(false)}
          onSave={saveProvider}
        />
      )}
    </div>
  );
}
