import { useEffect, useRef, useState } from "react";
import {
  Bot,
  Eraser,
  Pencil,
  Plus,
  Send,
  Square,
  Trash2,
} from "lucide-react";
import ProviderForm from "./ProviderForm";
import {
  agentCancel,
  agentChat,
  agentDeleteKey,
  agentHasKey,
  agentSetKey,
} from "./api";
import {
  clearHistory,
  loadActiveProviderId,
  loadHistory,
  loadProviders,
  saveActiveProviderId,
  saveHistory,
  saveProviders,
} from "./storage";
import type { AgentChatMessage, AgentEvent, AgentProvider } from "./types";

interface ChatEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

interface ActiveStream {
  entryId: string;
  requestId: string | null;
  cancelled: boolean;
}

const SYSTEM_PROMPT =
  "你是 ConchTerm SSH 终端内置的 AI 助手，回答简洁直接，优先给出可执行的命令或步骤。";

/** AI 助手侧栏面板：Provider 管理与流式聊天 */
export default function AgentPanel() {
  const [providers, setProviders] = useState<AgentProvider[]>(loadProviders);
  const [activeId, setActiveId] = useState<string>(loadActiveProviderId);
  const [entries, setEntries] = useState<ChatEntry[]>(() =>
    loadHistory()
      .filter((m) => m.role !== "system")
      .map((m) => ({
        ...m,
        role: m.role as "user" | "assistant",
        id: crypto.randomUUID(),
      }))
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AgentProvider | null>(null);
  const activeStreamRef = useRef<ActiveStream | null>(null);
  const msgsRef = useRef<HTMLDivElement | null>(null);

  const activeProvider =
    providers.find((p) => p.id === activeId) ?? providers[0] ?? null;

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

  useEffect(() => {
    saveHistory(entries);
  }, [entries]);

  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight });
  }, [entries]);

  const applyToEntry = (entryId: string, fn: (e: ChatEntry) => ChatEntry) => {
    setEntries((prev) => prev.map((e) => (e.id === entryId ? fn(e) : e)));
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
      applyToEntry(entryId, (e) => ({
        ...e,
        content: e.content + (event.content ?? ""),
      }));
      return;
    }
    if (event.type === "done") {
      if (event.id === stream.requestId) finishStream();
      return;
    }
    // error：空 id 表示进程级错误，否则是当前请求失败
    if (!event.id || event.id === stream.requestId) {
      applyToEntry(entryId, (e) => ({
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
    if (!provider || !text || busy) return;

    const userEntry: ChatEntry = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };
    const assistantEntry: ChatEntry = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
    };
    const history = [...entries, userEntry, assistantEntry];
    setEntries(history);
    setInput("");
    setBusy(true);
    activeStreamRef.current = {
      entryId: assistantEntry.id,
      requestId: null,
      cancelled: false,
    };

    // 空内容的占位/已取消条目不进入上下文
    const payload: AgentChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history
        .filter((e) => e.id !== assistantEntry.id && e.content.trim())
        .map((e) => ({ role: e.role, content: e.content })),
    ];

    try {
      const requestId = await agentChat(provider, payload, (event) =>
        handleEvent(event, assistantEntry.id)
      );
      if (activeStreamRef.current?.entryId === assistantEntry.id) {
        activeStreamRef.current.requestId = requestId;
      } else {
        // 等待 invoke 返回期间已被取消
        agentCancel(requestId).catch(() => {});
      }
    } catch (err) {
      applyToEntry(assistantEntry.id, (e) => ({
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
    clearHistory();
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

  const saveProvider = async (
    provider: AgentProvider,
    apiKey: string
  ) => {
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
          <button className="icon-btn" title="清空对话" onClick={clearChat}>
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

          <div className="agent-msgs" ref={msgsRef}>
            {entries.map((e) => (
              <div
                key={e.id}
                className={`agent-msg ${e.role}${e.error ? " error" : ""}`}
              >
                {e.content}
              </div>
            ))}
          </div>

          <div className="agent-input">
            <textarea
              rows={2}
              value={input}
              placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
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
                disabled={!input.trim() || !activeProvider}
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
