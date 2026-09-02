import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  Copy,
  FolderOpen,
  Minus,
  Pencil,
  Plus,
  Settings as SettingsIcon,
  Server,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import TerminalView from "./components/TerminalView";
import ServerForm from "./components/ServerForm";
import FileBrowser from "./components/FileBrowser";
import SettingsView from "./components/SettingsView";
import { DialogProvider, useDialogs } from "./components/Dialogs";
import AgentPanel from "./agent/AgentPanel";
import {
  applyAppearance,
  applyZoom,
  COLOR_THEMES,
  loadSettings,
  resolveTheme,
  saveSettings,
  TERMINAL_FONTS,
  type AppSettings,
} from "./settings";
import {
  loadServers,
  saveServers,
  newId,
  type ServerProfile,
} from "./storage";
import type { ConnectParams } from "./api";

interface TermTab {
  key: string;          // 终端唯一标识（= SSH session id）
  serverId: string;
  title: string;
  params: ConnectParams;
}

type SidebarTab = "servers" | "files";

type SessionStatus = "connected" | "failed";

interface TerminalAppearance {
  fontFamily: string;
  fontSize: number;
  theme: "light" | "dark";
  accent: string;
  selection: string;
}

const DEFAULT_SIDEBAR_WIDTH = 272;
const SIDEBAR_STORAGE_KEY = "sidebarWidth";
const DEFAULT_AGENT_DOCK_WIDTH = 360;
const AGENT_DOCK_WIDTH_KEY = "agentDockWidth";
const AGENT_DOCK_OPEN_KEY = "agentDockOpen";

export default function App() {
  return (
    <DialogProvider>
      <AppShell />
    </DialogProvider>
  );
}

function AppShell() {
  const dialogs = useDialogs();
  const [servers, setServers] = useState<ServerProfile[]>(loadServers);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewSettings, setPreviewSettings] = useState<AppSettings | null>(
    null
  );
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("servers");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ServerProfile | null>(null);
  const [tabs, setTabs] = useState<TermTab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<
    Record<string, SessionStatus>
  >({});
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = parseInt(localStorage.getItem(SIDEBAR_STORAGE_KEY) ?? "", 10);
    return Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_SIDEBAR_WIDTH;
  });
  const [agentDockOpen, setAgentDockOpen] = useState<boolean>(
    () => localStorage.getItem(AGENT_DOCK_OPEN_KEY) === "1"
  );
  const [agentDockWidth, setAgentDockWidth] = useState<number>(() => {
    const saved = parseInt(
      localStorage.getItem(AGENT_DOCK_WIDTH_KEY) ?? "",
      10
    );
    return Number.isFinite(saved) && saved > 0
      ? saved
      : DEFAULT_AGENT_DOCK_WIDTH;
  });
  const [isMaximized, setIsMaximized] = useState(false);

  // 跟踪最大化状态，切换标题栏的 最大化/还原 图标
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    win
      .onResized(async () => {
        setIsMaximized(await win.isMaximized());
      })
      .then((fn) => {
        unlisten = fn;
      });
    win.isMaximized().then(setIsMaximized).catch(() => {});
    return () => unlisten?.();
  }, []);

  // 远端断开：把对应终端标记为 failed（侧栏红点、Agent 不再可用）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<{ sessionId: string }>("session-closed", (event) => {
      setSessionStatus((prev) =>
        prev[event.payload.sessionId] === "connected"
          ? { ...prev, [event.payload.sessionId]: "failed" }
          : prev
      );
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 外观设置即时生效的统一入口：提交与预览共用
  const applySideEffects = useCallback((s: AppSettings) => {
    applyAppearance(s);
    void applyZoom(s.zoom);
    invoke("set_tray_visible", { visible: s.trayIcon }).catch(() => {});
  }, []);

  useEffect(() => {
    applySideEffects(settings);
  }, [settings, applySideEffects]);

  // 跟随系统时监听系统主题切换
  useEffect(() => {
    if (settings.themeMode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyAppearance(settings);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [settings, applyAppearance]);

  // 预览优先：设置页打开时草稿即时生效，关闭后回到已提交配置
  const effectiveSettings = previewSettings ?? settings;

  const terminalAppearance = useMemo<TerminalAppearance>(() => {
    const theme =
      COLOR_THEMES[effectiveSettings.colorTheme] ?? COLOR_THEMES.ocean;
    return {
      fontFamily:
        TERMINAL_FONTS[effectiveSettings.terminalFont]?.stack ??
        TERMINAL_FONTS.consolas.stack,
      fontSize: effectiveSettings.terminalFontSize,
      theme: resolveTheme(effectiveSettings.themeMode),
      accent: theme.accent,
      selection: theme.selection,
    };
  }, [
    effectiveSettings.colorTheme,
    effectiveSettings.themeMode,
    effectiveSettings.terminalFont,
    effectiveSettings.terminalFontSize,
  ]);

  const applySettings = (next: AppSettings) => {
    setSettings(next);
    saveSettings(next);
    setPreviewSettings(null);
    applySideEffects(next);
  };

  const applySettingsAndClose = (next: AppSettings) => {
    applySettings(next);
    setSettingsOpen(false);
  };

  const previewSettingsChange = useCallback(
    (next: AppSettings) => {
      setPreviewSettings(next);
      applySideEffects(next);
    },
    [applySideEffects]
  );

  const closeSettings = () => {
    setPreviewSettings(null);
    setSettingsOpen(false);
    // 丢弃未应用的预览，还原到已提交配置
    applySideEffects(settings);
  };

  // 文件面板跟随当前活跃终端的会话
  const activeSessionId = activeKey;

  const persist = (next: ServerProfile[]) => {
    setServers(next);
    saveServers(next);
  };

  const openTerminal = (server: ServerProfile) => {
    // 同一台服务器只开一个 Tab，重复点击聚焦已有 Tab；
    // 但连接失败的 Tab 点击视为重连：关掉旧终端重建连接
    const existing = tabs.find((t) => t.serverId === server.id);
    if (existing) {
      if (sessionStatus[existing.key] !== "failed") {
        setActiveKey(existing.key);
        return;
      }
      // 旧 key 的会话已死，先清理再以新 key 重建，触发 TerminalView 重新挂载
      closeTerminal(existing.key);
    }
    const key = newId();
    const params: ConnectParams = {
      id: key,
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password ?? null,
      privateKey: server.privateKey ?? null,
      passphrase: server.passphrase ?? null,
    };
    setTabs((prev) => [
      ...prev,
      { key, serverId: server.id, title: server.name, params },
    ]);
    setActiveKey(key);
  };

  const closeTerminal = (key: string) => {
    setSessionStatus((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setTabs((prev) => {
      const next = prev.filter((t) => t.key !== key);
      if (activeKey === key) {
        setActiveKey(next.length ? next[next.length - 1].key : null);
      }
      return next;
    });
  };

  const activeTab = tabs.find((t) => t.key === activeKey) ?? null;
  const activeServerId = activeTab?.serverId ?? null;

  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    let width = sidebarWidth;
    document.body.classList.add("resizing");
    const onMove = (ev: MouseEvent) => {
      width = Math.min(
        Math.max(startX + (ev.clientX - startX), 224),
        window.innerWidth - 320
      );
      setSidebarWidth(width);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(width));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const resetSidebarWidth = () => {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(DEFAULT_SIDEBAR_WIDTH));
  };

  const toggleAgentDock = () => {
    const next = !agentDockOpen;
    setAgentDockOpen(next);
    localStorage.setItem(AGENT_DOCK_OPEN_KEY, next ? "1" : "0");
  };

  const startAgentDockResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = agentDockWidth;
    let width = startWidth;
    document.body.classList.add("resizing");
    const onMove = (ev: MouseEvent) => {
      width = Math.min(Math.max(startWidth + (startX - ev.clientX), 320), 560);
      setAgentDockWidth(width);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
      localStorage.setItem(AGENT_DOCK_WIDTH_KEY, String(width));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const resetAgentDockWidth = () => {
    setAgentDockWidth(DEFAULT_AGENT_DOCK_WIDTH);
    localStorage.setItem(
      AGENT_DOCK_WIDTH_KEY,
      String(DEFAULT_AGENT_DOCK_WIDTH)
    );
  };

  const terminalViews = useMemo(
    () =>
      tabs.map((t) => (
        <div
          key={t.key}
          className="terminal-pane"
          style={{ display: t.key === activeKey ? "block" : "none" }}
        >
          <TerminalView
            sessionKey={t.key}
            params={t.params}
            appearance={terminalAppearance}
            ctrlWheelZoom={effectiveSettings.ctrlWheelZoom}
            onStatus={(status) =>
              setSessionStatus((prev) => ({ ...prev, [t.key]: status }))
            }
          />
        </div>
      )),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabs.map((t) => t.key).join(","), activeKey, terminalAppearance]
  );

  return (
    <div className="app-root">
      {/* 自定义标题栏 */}
      <div className="title-bar" data-tauri-drag-region>
        <img
          className="title-app-icon"
          src="/app-icon.png"
          alt="ConchTerm"
          data-tauri-drag-region
        />
        <span className="title-app-name" data-tauri-drag-region>
          ConchTerm
        </span>
        <div className="title-actions">
          <button
            className={`title-ai${settingsOpen ? " active" : ""}`}
            title="设置"
            onClick={settingsOpen ? closeSettings : () => setSettingsOpen(true)}
          >
            <SettingsIcon size={17} strokeWidth={2} />
          </button>
          <button
            className={`title-ai${agentDockOpen ? " active" : ""}`}
            title="AI 助手"
            onClick={toggleAgentDock}
          >
            <Bot size={20} strokeWidth={2} />
          </button>
          <button
            className="title-btn"
            title="最小化"
            onClick={() => void getCurrentWindow().minimize()}
          >
            <Minus size={14} strokeWidth={1.8} />
          </button>
          <button
            className="title-btn"
            title={isMaximized ? "向下还原" : "最大化"}
            onClick={() => void getCurrentWindow().toggleMaximize()}
          >
            {isMaximized ? (
              <Copy size={12} strokeWidth={1.8} />
            ) : (
              <Square size={12} strokeWidth={1.8} />
            )}
          </button>
          <button
            className="title-btn close"
            title="关闭"
            onClick={() => void getCurrentWindow().close()}
          >
            <X size={14} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      <div className="app-shell">
      {/* 最左侧功能按钮条 */}
      <nav className="activity-bar">
        <button
          className={`act-btn ${sidebarTab === "servers" ? "active" : ""}`}
          title="服务器"
          onClick={() => setSidebarTab("servers")}
        >
          <Server size={19} strokeWidth={1.8} />
        </button>
        <button
          className={`act-btn ${sidebarTab === "files" ? "active" : ""}`}
          title="文件"
          onClick={() => setSidebarTab("files")}
        >
          <FolderOpen size={19} strokeWidth={1.8} />
        </button>
      </nav>

      {/* 内容侧栏 */}
      <aside className="sidebar" style={{ width: sidebarWidth }}>
        {sidebarTab === "servers" ? (
          <div className="panel">
            <div className="panel-header">
              <span>服务器</span>
              <button
                className="icon-btn"
                title="新建服务器"
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                <Plus size={15} strokeWidth={2} />
              </button>
            </div>
            <ul className="server-list">
              {servers.map((s) => {
                const tab = tabs.find((t) => t.serverId === s.id);
                const status = tab ? sessionStatus[tab.key] : undefined;
                const cls = [
                  tab && status === undefined ? "connecting" : "",
                  status === "connected" ? "open" : "",
                  status === "failed" ? "failed" : "",
                  activeServerId === s.id ? "active" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <li
                    key={s.id}
                    className={cls}
                    onClick={() => openTerminal(s)}
                  >
                    <div className="server-item-main">
                      <span className="server-name">
                        <span className="server-dot" />
                        {s.name}
                      </span>
                      <span className="server-host">
                        {s.username}@{s.host}
                      </span>
                    </div>
                    <span className="server-actions">
                      <button
                        className="icon-btn"
                        title="编辑"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(s);
                          setFormOpen(true);
                        }}
                      >
                        <Pencil size={13} strokeWidth={1.8} />
                      </button>
                      <button
                        className="icon-btn danger"
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation();
                          void dialogs
                            .confirm(`删除服务器「${s.name}」？`, {
                              title: "删除服务器",
                              danger: true,
                              okLabel: "删除",
                            })
                            .then(({ ok }) => {
                              if (ok) {
                                persist(servers.filter((x) => x.id !== s.id));
                              }
                            });
                        }}
                      >
                        <Trash2 size={13} strokeWidth={1.8} />
                      </button>
                    </span>
                  </li>
                );
              })}
              {servers.length === 0 && (
                <li className="empty-state">
                  <Server size={26} strokeWidth={1.5} />
                  <p>还没有服务器</p>
                  <span>点击右上角 + 添加第一台服务器</span>
                </li>
              )}
            </ul>
          </div>
        ) : (
          <FileBrowser sessionId={activeSessionId} />
        )}
      </aside>

      {/* 侧栏与终端之间的拖拽分隔条 */}
      <div
        className="sidebar-resizer"
        title="拖动调整侧栏宽度（双击恢复默认）"
        onMouseDown={startSidebarResize}
        onDoubleClick={resetSidebarWidth}
      />

      {/* 右侧：终端标签页 */}
      <main className="main-area">
        <div
          className="main-normal"
          style={{ display: settingsOpen ? "none" : "flex" }}
        >
          <div
            className={`tab-bar${settings.tabOverflow === "wrap" ? " tab-wrap" : ""}`}
          >
            {tabs.map((t) => (
              <div
                key={t.key}
                className={`term-tab ${t.key === activeKey ? "active" : ""}`}
                onClick={() => setActiveKey(t.key)}
              >
                <span>{t.title}</span>
                <span
                  className="tab-close"
                  title="关闭标签页"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTerminal(t.key);
                  }}
                >
                  <X size={13} strokeWidth={2} />
                </span>
              </div>
            ))}
          </div>
          <div className="terminal-stack">
            {terminalViews}
            {tabs.length === 0 && (
              <div className="empty-state welcome">
                <span className="empty-icon">
                  <Terminal size={30} strokeWidth={1.5} />
                </span>
                <p>欢迎使用 ConchTerm</p>
                <span>从左侧选择一台服务器即可打开终端</span>
              </div>
            )}
          </div>
        </div>
        {settingsOpen && (
          <SettingsView
            settings={settings}
            onPreview={previewSettingsChange}
            onApply={applySettings}
            onApplyAndClose={applySettingsAndClose}
            onClose={closeSettings}
          />
        )}
      </main>

      {/* AI 助手右侧面板 */}
      {agentDockOpen && (
        <>
          <div
            className="agent-dock-resizer"
            title="拖动调整宽度（双击恢复默认）"
            onMouseDown={startAgentDockResize}
            onDoubleClick={resetAgentDockWidth}
          />
          <aside className="agent-dock" style={{ width: agentDockWidth }}>
            <AgentPanel
              // 仅暴露连接成功的终端会话：连接失败的标签不允许 Agent 执行命令
              sessions={tabs
                .filter((t) => sessionStatus[t.key] === "connected")
                .map((t) => ({ id: t.key, title: t.title }))}
              activeTerminalId={
                activeKey && sessionStatus[activeKey] === "connected"
                  ? activeKey
                  : null
              }
              aiSettings={{
                maxRounds: effectiveSettings.agentMaxRounds,
                maxRetries: effectiveSettings.aiMaxRetries,
                defaultMode: effectiveSettings.aiDefaultMode,
                customInstruction: effectiveSettings.aiCustomInstruction,
              }}
            />
          </aside>
        </>
      )}

      {formOpen && (
        <ServerForm
          initial={editing}
          onCancel={() => setFormOpen(false)}
          onSave={(p) => {
            const exists = servers.some((x) => x.id === p.id);
            persist(
              exists
                ? servers.map((x) => (x.id === p.id ? p : x))
                : [...servers, p]
            );
            setFormOpen(false);
          }}
        />
      )}
      </div>
    </div>
  );
}
