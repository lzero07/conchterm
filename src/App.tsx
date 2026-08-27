import { useMemo, useState } from "react";
import TerminalView from "./components/TerminalView";
import ServerForm from "./components/ServerForm";
import FileBrowser from "./components/FileBrowser";
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

export default function App() {
  const [servers, setServers] = useState<ServerProfile[]>(loadServers);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("servers");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ServerProfile | null>(null);
  const [tabs, setTabs] = useState<TermTab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  // 文件面板跟随当前活跃终端的会话
  const activeSessionId = activeKey;

  const persist = (next: ServerProfile[]) => {
    setServers(next);
    saveServers(next);
  };

  const openTerminal = (server: ServerProfile) => {
    // 同一台服务器只开一个 Tab，重复点击聚焦已有 Tab
    const existing = tabs.find((t) => t.serverId === server.id);
    if (existing) {
      setActiveKey(existing.key);
      return;
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
    setTabs((prev) => {
      const next = prev.filter((t) => t.key !== key);
      if (activeKey === key) {
        setActiveKey(next.length ? next[next.length - 1].key : null);
      }
      return next;
    });
  };

  const activeTab = tabs.find((t) => t.key === activeKey) ?? null;
  void activeTab;
  const terminalViews = useMemo(
    () =>
      tabs.map((t) => (
        <div
          key={t.key}
          className="terminal-pane"
          style={{ display: t.key === activeKey ? "block" : "none" }}
        >
          <TerminalView sessionKey={t.key} params={t.params} />
        </div>
      )),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabs.map((t) => t.key).join(","), activeKey]
  );

  return (
    <div className="app-shell">
      {/* 最左侧功能按钮条 */}
      <nav className="activity-bar">
        <button
          className={`act-btn ${sidebarTab === "servers" ? "active" : ""}`}
          title="服务器"
          onClick={() => setSidebarTab("servers")}
        >
          🖥️
        </button>
        <button
          className={`act-btn ${sidebarTab === "files" ? "active" : ""}`}
          title="文件"
          onClick={() => setSidebarTab("files")}
        >
          📂
        </button>
      </nav>

      {/* 内容侧栏 */}
      <aside className="sidebar">
        {sidebarTab === "servers" ? (
          <div className="panel">
            <div className="panel-header">
              <span>服务器</span>
              <button
                title="新建服务器"
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                ＋
              </button>
            </div>
            <ul className="server-list">
              {servers.map((s) => (
                <li key={s.id} onClick={() => openTerminal(s)}>
                  <div className="server-item-main">
                    <span className="server-name">{s.name}</span>
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
                      ✎
                    </button>
                    <button
                      className="icon-btn danger"
                      title="删除"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`删除服务器「${s.name}」？`)) {
                          persist(servers.filter((x) => x.id !== s.id));
                        }
                      }}
                    >
                      ✕
                    </button>
                  </span>
                </li>
              ))}
              {servers.length === 0 && (
                <li className="empty-hint">点击 ＋ 添加你的第一台服务器</li>
              )}
            </ul>
          </div>
        ) : (
          <FileBrowser sessionId={activeSessionId} />
        )}
      </aside>

      {/* 右侧：终端标签页 */}
      <main className="main-area">
        <div className="tab-bar">
          {tabs.map((t) => (
            <div
              key={t.key}
              className={`term-tab ${t.key === activeKey ? "active" : ""}`}
              onClick={() => setActiveKey(t.key)}
            >
              <span>{t.title}</span>
              <span
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminal(t.key);
                }}
              >
                ×
              </span>
            </div>
          ))}
        </div>
        <div className="terminal-stack">
          {terminalViews}
          {tabs.length === 0 && (
            <div className="empty-hint welcome">左侧选择服务器即可打开终端</div>
          )}
        </div>
      </main>

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
  );
}
