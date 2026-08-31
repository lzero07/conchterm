import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Cpu,
  Eraser,
  History,
  LoaderCircle,
  MessageSquare,
  Pencil,
  Plus,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Zap,
  X,
} from "lucide-react";
import ProviderForm from "./ProviderForm";
import { sshExec } from "../api";
import {
  agentCancel,
  agentChat,
  agentDeleteKey,
  agentHasKey,
  agentListModels,
  agentSetKey,
  agentToolResult,
} from "./api";
import {
  deleteSessionEntries,
  DEFAULT_SESSION_TITLE,
  loadActiveProviderId,
  loadMode,
  loadProviders,
  loadSessionEntries,
  loadSessionIndex,
  newSessionMeta,
  saveActiveProviderId,
  saveMode,
  saveProviders,
  saveSessionEntries,
  saveSessionIndex,
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

type MenuKind = "history" | "mode" | "provider" | "session" | "model";

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

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** AI 助手面板：会话管理 / 问答与 Agent 双模式 / 流式聊天 / 命令确认 */
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
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [openMenu, setOpenMenu] = useState<MenuKind | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  /** Agent 自动放行：开启后命令无需确认直接执行（会话级，重启失效） */
  const [autoExec, setAutoExec] = useState(
    () => sessionStorage.getItem("agentAutoExec") === "1"
  );
  const [autoExecConfirmOpen, setAutoExecConfirmOpen] = useState(false);
  /** 面板较窄时芯片收缩为纯图标 */
  const [composerCompact, setComposerCompact] = useState(false);
  const activeStreamRef = useRef<ActiveStream | null>(null);
  const autoExecRef = useRef(autoExec);
  const msgsRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);

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
  const activeMeta = sessionIndex.sessions.find(
    (s) => s.id === activeSessionId
  );
  const sortedSessions = [...sessionIndex.sessions].sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
  const currentModel = activeProvider
    ? activeProvider.activeModel || activeProvider.defaultModel
    : "";
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

  // 监听合成输入区宽度：窄面板自动切换为紧凑排版
  useEffect(() => {
    const el = composerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((observed) => {
      for (const entry of observed) {
        setComposerCompact(entry.contentRect.width < 330);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
      const toolEntry: ToolEntry = {
        kind: "tool",
        id: crypto.randomUUID(),
        callId: event.callId ?? "",
        requestId: stream.requestId ?? "",
        tool: event.tool ?? "",
        command,
        status: autoExecRef.current ? "running" : "pending",
        collapsed: false,
      };
      setEntries((prev) => [...prev, toolEntry]);
      // 工具之后的文本应显示在命令下方，另起一个助手气泡
      const nextEntry: MessageEntry = {
        kind: "message",
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
      };
      setEntries((prev) => [...prev, nextEntry]);
      stream.messageEntryId = nextEntry.id;
      // 自动放行模式：无需用户确认，直接执行
      if (autoExecRef.current) {
        void executeTool(toolEntry);
      }
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

  const switchMode = (next: AgentMode) => {
    setMode(next);
    saveMode(next);
  };

  const toggleAutoExec = () => {
    const next = !autoExec;
    if (next) {
      // 自定义暗色弹窗：原生对话框样式无法跟随应用主题
      setAutoExecConfirmOpen(true);
      return;
    }
    setAutoExec(false);
    autoExecRef.current = false;
    sessionStorage.setItem("agentAutoExec", "0");
  };

  const confirmAutoExec = () => {
    setAutoExecConfirmOpen(false);
    setAutoExec(true);
    autoExecRef.current = true;
    sessionStorage.setItem("agentAutoExec", "1");
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
    if (
      activeMeta?.title === DEFAULT_SESSION_TITLE &&
      entries.length === 0
    ) {
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

  const startRename = () => {
    if (!activeMeta) return;
    setRenameValue(activeMeta.title);
    setRenaming(true);
  };

  const confirmRename = () => {
    if (!renaming) return;
    const title = renameValue.trim();
    if (title && activeSessionId) {
      const next: AgentSessionIndex = {
        sessions: sessionIndex.sessions.map((s) =>
          s.id === activeSessionId ? { ...s, title } : s
        ),
        activeId: activeSessionId,
      };
      setSessionIndex(next);
      saveSessionIndex(next);
    }
    setRenaming(false);
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

  /** 执行工具：需确认时由批准按钮触发，自动放行时由 tool_call 事件触发 */
  const executeTool = async (entry: ToolEntry) => {
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

  const approveTool = (entry: ToolEntry) => {
    void executeTool(entry);
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

  const setModelActive = (model: string) => {
    if (!activeProvider) return;
    persistProviders(
      providers.map((p) =>
        p.id === activeProvider.id ? { ...p, activeModel: model } : p
      )
    );
  };

  const fetchModels = () => {
    const provider = activeProvider;
    if (!provider || fetchingModels) return;
    setFetchingModels(true);
    agentListModels(provider, (event) => {
      if (event.type === "models") {
        const fetched = event.models ?? [];
        if (fetched.length === 0) {
          alert("该 Provider 未返回任何模型");
        }
        setProviders((prev) =>
          prev.map((p) => {
            if (p.id !== provider.id) return p;
            const merged = Array.from(new Set([...p.models, ...fetched]));
            return { ...p, models: merged };
          })
        );
        setFetchingModels(false);
      } else if (event.type === "error") {
        alert(`获取模型列表失败：${event.message ?? "未知错误"}`);
        setFetchingModels(false);
      }
    }).catch((err) => {
      alert(String(err));
      setFetchingModels(false);
    });
  };

  const canSend =
    !!input.trim() &&
    !!activeProvider &&
    !!currentModel &&
    (mode === "chat" || !!targetSession);

  return (
    <div className="panel agent-panel">
      {openMenu && (
        <div className="agent-menu-backdrop" onClick={() => setOpenMenu(null)} />
      )}

      {/* 顶栏：会话标题 + 会话操作 */}
      <div className="agent-topbar">
        {renaming ? (
          <input
            className="agent-topbar-input"
            value={renameValue}
            autoFocus
            maxLength={30}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmRename();
              if (e.key === "Escape") setRenaming(false);
            }}
            onBlur={confirmRename}
          />
        ) : (
          <span className="agent-topbar-title" title={activeMeta?.title}>
            {activeMeta?.title ?? "新对话"}
          </span>
        )}
        <div className="agent-topbar-actions">
          <button className="icon-btn" title="新建会话" onClick={createSession}>
            <Plus size={14} strokeWidth={1.8} />
          </button>
          <button
            className={`icon-btn${openMenu === "history" ? " active" : ""}`}
            title="历史会话"
            onClick={() =>
              setOpenMenu(openMenu === "history" ? null : "history")
            }
          >
            <History size={14} strokeWidth={1.8} />
          </button>
          <button className="icon-btn" title="重命名" onClick={startRename}>
            <Pencil size={13} strokeWidth={1.8} />
          </button>
          <button className="icon-btn" title="清空当前会话" onClick={clearChat}>
            <Eraser size={13} strokeWidth={1.8} />
          </button>
          <button
            className="icon-btn danger"
            title="删除会话"
            onClick={() => activeSessionId && removeSession(activeSessionId)}
          >
            <Trash2 size={13} strokeWidth={1.8} />
          </button>
        </div>
        {openMenu === "history" && (
          <div className="agent-menu agent-menu-history">
            {sortedSessions.map((s) => (
              <div
                key={s.id}
                className={`agent-menu-item${
                  s.id === activeSessionId ? " active" : ""
                }`}
                onClick={() => {
                  switchSession(s.id);
                  setOpenMenu(null);
                }}
              >
                <span className="grow">{s.title}</span>
                <span className="agent-menu-time">
                  {formatTime(s.updatedAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 消息区 */}
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
                  <ChevronDown
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
        {entries.length === 0 && !busy && (
          <div className="agent-welcome">
            <Bot size={40} strokeWidth={1.3} />
            <p>
              {mode === "agent"
                ? "描述你想做的事，我来帮你执行"
                : "问问任何问题"}
            </p>
          </div>
        )}
      </div>

      {/* 底部输入合成区 */}
      <div
        ref={composerRef}
        className={`agent-composer${composerCompact ? " compact" : ""}`}
      >
        <div className="agent-composer-row">
          <button
            className="agent-chip"
            title="切换模式"
            onClick={() => setOpenMenu(openMenu === "mode" ? null : "mode")}
          >
            {mode === "agent" ? (
              <Terminal size={12} strokeWidth={2} />
            ) : (
              <MessageSquare size={12} strokeWidth={2} />
            )}
            <span>{mode === "agent" ? "Agent · 命令" : "Ask · 问答"}</span>
            <ChevronDown size={11} strokeWidth={2} className="agent-chip-caret" />
            {openMenu === "mode" && (
              <div className="agent-menu">
                <div
                  className={`agent-menu-item${mode === "chat" ? " active" : ""}`}
                  onClick={() => {
                    switchMode("chat");
                    setOpenMenu(null);
                  }}
                >
                  <MessageSquare size={12} strokeWidth={2} />
                  <span>Ask · 问答</span>
                  <span className="agent-menu-sub">仅对话</span>
                </div>
                <div
                  className={`agent-menu-item${mode === "agent" ? " active" : ""}`}
                  onClick={() => {
                    switchMode("agent");
                    setOpenMenu(null);
                  }}
                >
                  <Terminal size={12} strokeWidth={2} />
                  <span>Agent · 命令</span>
                  <span className="agent-menu-sub">执行前需确认</span>
                </div>
              </div>
            )}
          </button>
          {mode === "agent" && sessions.length > 0 && (
            <button
              className="agent-chip"
              title="选择命令执行的目标会话"
              onClick={() =>
                setOpenMenu(openMenu === "session" ? null : "session")
              }
            >
              <Terminal size={12} strokeWidth={2} />
              <span>{targetSession?.title ?? "选择会话"}</span>
              <ChevronDown size={11} strokeWidth={2} className="agent-chip-caret" />
              {openMenu === "session" && (
                <div className="agent-menu">
                  {sessions.map((s) => (
                    <div
                      key={s.id}
                      className={`agent-menu-item${
                        s.id === targetSessionId ? " active" : ""
                      }`}
                      onClick={() => {
                        setTargetSessionId(s.id);
                        setOpenMenu(null);
                      }}
                    >
                      <Terminal size={12} strokeWidth={2} />
                      <span className="grow">{s.title}</span>
                    </div>
                  ))}
                </div>
              )}
            </button>
          )}
          <span className="spacer" />
          <button
            className="agent-chip"
            title="切换当前 Provider 下的模型"
            onClick={() => setOpenMenu(openMenu === "model" ? null : "model")}
          >
            <Cpu size={12} strokeWidth={2} />
            <span>{currentModel || "设置模型"}</span>
            <ChevronDown size={11} strokeWidth={2} className="agent-chip-caret" />
            {openMenu === "model" && (
              <div className="agent-menu right">
                {(activeProvider?.models ?? []).map((m) => (
                  <div
                    key={m}
                    className={`agent-menu-item${
                      m === currentModel ? " active" : ""
                    }`}
                    onClick={() => {
                      setModelActive(m);
                      setOpenMenu(null);
                    }}
                  >
                    <span className="grow">{m}</span>
                    {m === activeProvider?.defaultModel && (
                      <span className="agent-menu-badge">默认</span>
                    )}
                    {m === currentModel && <Check size={12} strokeWidth={2} />}
                  </div>
                ))}
                <div
                  className="agent-menu-item add"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!fetchingModels) fetchModels();
                  }}
                >
                  {fetchingModels ? (
                    <LoaderCircle
                      size={12}
                      strokeWidth={2}
                      className="spin"
                    />
                  ) : (
                    <ArrowDown size={12} strokeWidth={2} />
                  )}
                  获取模型列表
                </div>
                <div
                  className="agent-menu-item add"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(activeProvider);
                    setFormOpen(true);
                    setOpenMenu(null);
                  }}
                >
                  <Pencil size={12} strokeWidth={2} />
                  管理模型
                </div>
              </div>
            )}
          </button>
          <button
            className="agent-chip"
            title="切换 / 管理 AI Provider"
            onClick={() =>
              setOpenMenu(openMenu === "provider" ? null : "provider")
            }
          >
            <Bot size={12} strokeWidth={2} />
            <span>{activeProvider?.name ?? "选择模型"}</span>
            <ChevronDown size={11} strokeWidth={2} className="agent-chip-caret" />
            {openMenu === "provider" && (
              <div className="agent-menu right">
                {providers.map((p) => (
                  <div
                    key={p.id}
                    className={`agent-menu-item${
                      p.id === activeProvider?.id ? " active" : ""
                    }`}
                    onClick={() => {
                      changeProvider(p.id);
                      setOpenMenu(null);
                    }}
                  >
                    <Bot size={12} strokeWidth={2} />
                    <span className="grow">
                      {p.name}
                      {!p.hasKey && (
                        <span className="agent-menu-warn">未配置 Key</span>
                      )}
                    </span>
                    <span className="agent-menu-actions">
                      <button
                        title="编辑"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(p);
                          setFormOpen(true);
                          setOpenMenu(null);
                        }}
                      >
                        <Pencil size={11} strokeWidth={1.8} />
                      </button>
                      <button
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeProvider(p);
                        }}
                      >
                        <Trash2 size={11} strokeWidth={1.8} />
                      </button>
                    </span>
                  </div>
                ))}
                <div
                  className="agent-menu-item add"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(null);
                    setFormOpen(true);
                    setOpenMenu(null);
                  }}
                >
                  <Plus size={12} strokeWidth={2} />
                  添加 Provider
                </div>
              </div>
            )}
          </button>
        </div>
        <textarea
          className="agent-composer-input"
          rows={2}
          value={input}
          placeholder={
            mode === "agent"
              ? "描述你想做的事，Agent 将转化为命令执行（执行前需确认）…"
              : "问任何问题…（Enter 发送，Shift+Enter 换行）"
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
        <div className="agent-composer-row">
          {mode === "agent" && (
            <button
              className={`agent-hint-toggle${autoExec ? " warn" : ""}`}
              title={
                autoExec
                  ? "自动执行已开启，点击关闭以恢复命令确认"
                  : "开启自动执行（危险：命令无需确认直接执行）"
              }
              onClick={toggleAutoExec}
            >
              {autoExec ? (
                <Zap size={11} strokeWidth={2} />
              ) : (
                <ShieldCheck size={11} strokeWidth={2} />
              )}
              {autoExec ? "自动执行中 · 点击关闭" : "命令执行前需确认"}
            </button>
          )}
          <span className="spacer" />
          <button
            className={`agent-send-circle${busy || canSend ? " ready" : ""}`}
            title={busy ? "停止生成" : "发送"}
            disabled={!busy && !canSend}
            onClick={busy ? stop : send}
          >
            {busy ? (
              <Square size={12} strokeWidth={2} />
            ) : (
              <ArrowUp size={16} strokeWidth={2} />
            )}
          </button>
        </div>
      </div>

      {autoExecConfirmOpen && (
        <div
          className="modal-backdrop"
          onClick={() => setAutoExecConfirmOpen(false)}
        >
          <div
            className="modal danger-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-title">
              <h3>危险操作确认：开启自动执行</h3>
              <button
                className="icon-btn"
                title="关闭"
                onClick={() => setAutoExecConfirmOpen(false)}
              >
                <X size={15} strokeWidth={1.8} />
              </button>
            </div>
            <p className="danger-text">
              开启后 Agent 执行的命令将不再需要你的确认，模型可以未经允许地在目标服务器上直接执行任意命令（包括删除文件、修改系统、重启服务等）。
            </p>
            <p className="danger-text">
              请自行评估并承担由此产生的一切风险与后果，操作失误与本系统无关。
            </p>
            <p className="danger-question">确定要开启自动执行吗？</p>
            <div className="modal-actions">
              <button onClick={() => setAutoExecConfirmOpen(false)}>
                取消
              </button>
              <button className="primary danger" onClick={confirmAutoExec}>
                我已知晓风险，开启
              </button>
            </div>
          </div>
        </div>
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
