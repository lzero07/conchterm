import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Info,
  Palette,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import {
  COLOR_THEMES,
  DEFAULT_SETTINGS,
  TERMINAL_FONTS,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  UI_FONTS,
  ZOOM_OPTIONS,
  type AppSettings,
  type LayoutStyle,
  type RadiusStyle,
  type TabOverflow,
  type TerminalFontId,
  type ThemeMode,
  type UiFontId,
} from "../settings";
import ProviderForm from "../agent/ProviderForm";
import { useDialogs } from "./Dialogs";
import {
  agentDeleteKey,
  agentListModels,
  agentSetKey,
} from "../agent/api";
import {
  loadActiveProviderId,
  loadProviders,
  saveActiveProviderId,
  saveProviders,
} from "../agent/storage";
import type { AgentProvider } from "../agent/types";

interface Props {
  settings: AppSettings;
  onPreview: (next: AppSettings) => void;
  onApply: (next: AppSettings) => void;
  onApplyAndClose: (next: AppSettings) => void;
  onClose: () => void;
}

type Category = "appearance" | "ai" | "about";

const THEME_OPTIONS: [ThemeMode, string][] = [
  ["light", "亮色"],
  ["dark", "暗色"],
  ["system", "跟随系统"],
];

const RADIUS_OPTIONS: [RadiusStyle, string][] = [
  ["none", "无圆角"],
  ["small", "小圆角"],
  ["large", "大圆角"],
];

export default function SettingsView({
  settings,
  onPreview,
  onApply,
  onApplyAndClose,
  onClose,
}: Props) {
  const dialogs = useDialogs();
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [category, setCategory] = useState<Category>("appearance");
  const [query, setQuery] = useState("");
  // AI Provider 列表：与 Agent 面板共享同一份 SQLite 数据（异步加载）
  const [providers, setProviders] = useState<AgentProvider[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string>("");
  const [providerFormOpen, setProviderFormOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<AgentProvider | null>(
    null
  );
  // 正在拉取模型列表的 Provider id
  const [fetchingModelsId, setFetchingModelsId] = useState<string | null>(null);

  // 初始加载：SQLite 里的 Provider 列表与默认 Provider
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [ps, active] = await Promise.all([
          loadProviders(),
          loadActiveProviderId(),
        ]);
        if (cancelled) return;
        setProviders(ps);
        setActiveProviderId(active);
      } catch {
        // 加载失败保持空列表，具体操作时再暴露错误
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persistProviders = (next: AgentProvider[]) => {
    setProviders(next);
    saveProviders(next);
    // 通知其它挂载点（AgentPanel）同步刷新
    window.dispatchEvent(new CustomEvent("conchterm.providers-changed"));
  };

  const saveProvider = async (provider: AgentProvider, apiKey: string) => {
    let saved = provider;
    if (apiKey) {
      try {
        await agentSetKey(provider.id, apiKey);
        saved = { ...provider, hasKey: true };
      } catch (err) {
        void dialogs.alert(`保存 API Key 失败：${String(err)}`, {
          title: "保存失败",
        });
        return;
      }
    }
    const exists = providers.some((p) => p.id === saved.id);
    const next = exists
      ? providers.map((p) => (p.id === saved.id ? saved : p))
      : [...providers, saved];
    persistProviders(next);
    // 第一个 Provider 自动设为默认
    if (!activeProviderId) {
      setActiveProviderId(saved.id);
      saveActiveProviderId(saved.id);
    }
    setProviderFormOpen(false);
  };

  const removeProvider = (provider: AgentProvider) => {
    void dialogs
      .confirm(`删除 Provider「${provider.name}」？`, {
        title: "删除 Provider",
        danger: true,
        okLabel: "删除",
      })
      .then(({ ok }) => {
        if (!ok) return;
        const next = providers.filter((p) => p.id !== provider.id);
        persistProviders(next);
        agentDeleteKey(provider.id).catch(() => {});
        if (activeProviderId === provider.id) {
          const fallback = next[0]?.id ?? "";
          setActiveProviderId(fallback);
          saveActiveProviderId(fallback);
        }
      });
  };

  const fetchModels = (provider: AgentProvider) => {
    if (fetchingModelsId) return;
    setFetchingModelsId(provider.id);
    agentListModels(provider, (event) => {
      if (event.type === "models") {
        const fetched = event.models ?? [];
        if (fetched.length === 0) {
          void dialogs.alert("该 Provider 未返回任何模型", {
            title: "获取模型列表",
            kind: "warning",
          });
        }
        setProviders((prev) => {
          const next = prev.map((p) =>
            p.id !== provider.id
              ? p
              : {
                  ...p,
                  models: Array.from(new Set([...p.models, ...fetched])),
                }
          );
          saveProviders(next);
          window.dispatchEvent(new CustomEvent("conchterm.providers-changed"));
          return next;
        });
        setFetchingModelsId(null);
      } else if (event.type === "error") {
        void dialogs.alert(`获取模型列表失败：${event.message ?? "未知错误"}`, {
          title: "获取模型列表失败",
          kind: "error",
        });
        setFetchingModelsId(null);
      }
    }).catch((err) => {
      void dialogs.alert(String(err), {
        title: "获取模型列表失败",
        kind: "error",
      });
      setFetchingModelsId(null);
    });
  };

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(settings),
    [draft, settings]
  );
  const isDefault = useMemo(
    () => JSON.stringify(draft) === JSON.stringify(DEFAULT_SETTINGS),
    [draft]
  );

  // 草稿即预览：改动即时应用到界面，关闭或未应用时由外层还原
  useEffect(() => {
    onPreview(draft);
  }, [draft, onPreview]);

  const patch = (p: Partial<AppSettings>) =>
    setDraft((d) => ({ ...d, ...p }));

  // 搜索框按关键词过滤外观设置块
  const visible = (keywords: string[]) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return keywords.some((k) => k.toLowerCase().includes(q));
  };

  const sections = [
    {
      key: "basics",
      hit: visible(["语言", "language", "配色", "主题", "缩放", "zoom"]),
      node: (
        <div className="settings-grid" key="basics">
          <label className="settings-field">
            <span>语言 / Language</span>
            <select
              value={draft.language}
              onChange={(e) =>
                patch({
                  language: e.target.value as AppSettings["language"],
                })
              }
            >
              <option value="zh-CN">cn 简体中文</option>
              <option value="en-US" disabled>
                en English（即将推出）
              </option>
            </select>
          </label>
          <label className="settings-field">
            <span>配色主题</span>
            <select
              value={draft.colorTheme}
              onChange={(e) =>
                patch({
                  colorTheme: e.target.value as AppSettings["colorTheme"],
                })
              }
            >
              {Object.entries(COLOR_THEMES).map(([id, t]) => (
                <option key={id} value={id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span>界面缩放</span>
            <select
              value={draft.zoom}
              onChange={(e) => patch({ zoom: Number(e.target.value) })}
            >
              {ZOOM_OPTIONS.map((z) => (
                <option key={z} value={z}>
                  {z}%
                </option>
              ))}
            </select>
          </label>
        </div>
      ),
    },
    {
      key: "fonts",
      hit: visible(["字体", "font", "字号", "缩放", "滚轮"]),
      node: (
        <div key="fonts">
          <div className="settings-grid">
            <label className="settings-field">
              <span>界面字体</span>
              <select
                value={draft.uiFont}
                onChange={(e) =>
                  patch({ uiFont: e.target.value as UiFontId })
                }
              >
                {Object.entries(UI_FONTS).map(([id, f]) => (
                  <option key={id} value={id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-field">
              <span>终端字体</span>
              <select
                value={draft.terminalFont}
                onChange={(e) =>
                  patch({ terminalFont: e.target.value as TerminalFontId })
                }
              >
                {Object.entries(TERMINAL_FONTS).map(([id, f]) => (
                  <option key={id} value={id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="settings-grid">
            <label className="settings-field">
              <span>终端字号（{draft.terminalFontSize}px）</span>
              <input
                type="range"
                min={TERMINAL_FONT_SIZE_MIN}
                max={TERMINAL_FONT_SIZE_MAX}
                step={1}
                value={draft.terminalFontSize}
                onChange={(e) =>
                  patch({ terminalFontSize: Number(e.target.value) })
                }
              />
            </label>
          </div>
          <section className="settings-section">
            <button
              className={`toggle-row${draft.ctrlWheelZoom ? " on" : ""}`}
              role="switch"
              aria-checked={draft.ctrlWheelZoom}
              onClick={() => patch({ ctrlWheelZoom: !draft.ctrlWheelZoom })}
            >
              <span className="toggle-text">
                <span className="option-title">Ctrl + 滚轮缩放终端字体</span>
                <span className="option-desc">
                  在终端上按住 Ctrl 并滚动滚轮，可临时调整该标签页的字体大小（不改动上面的默认字号）。
                </span>
              </span>
              <span className="switch">
                <span className="knob" />
              </span>
            </button>
          </section>
        </div>
      ),
    },
    {
      key: "theme-radius",
      hit: visible(["主题", "圆角", "亮色", "暗色"]),
      node: (
        <div className="settings-grid" key="theme-radius">
          <div className="settings-field">
            <span>主题</span>
            <div className="seg-group">
              {THEME_OPTIONS.map(([value, label]) => (
                <button
                  key={value}
                  className={`seg-btn${draft.themeMode === value ? " active" : ""}`}
                  onClick={() => patch({ themeMode: value })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-field">
            <span>圆角样式</span>
            <div className="seg-group">
              {RADIUS_OPTIONS.map(([value, label]) => (
                <button
                  key={value}
                  className={`seg-btn${draft.radius === value ? " active" : ""}`}
                  onClick={() => patch({ radius: value })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: "layout",
      hit: visible(["布局", "layout", "分隔", "紧凑"]),
      node: (
        <section className="settings-section" key="layout">
          <h4>界面布局</h4>
          <div className="option-cards">
            <button
              className={`option-card${draft.layout === "modern" ? " active" : ""}`}
              onClick={() => patch({ layout: "modern" as LayoutStyle })}
            >
              <span className="option-title">现代分隔</span>
              <span className="option-desc">
                面板分隔清晰，标签页为块状样式。
              </span>
            </button>
            <button
              className={`option-card${draft.layout === "classic" ? " active" : ""}`}
              onClick={() => patch({ layout: "classic" as LayoutStyle })}
            >
              <span className="option-title">经典紧凑</span>
              <span className="option-desc">
                使用连续标签栏和更紧凑的面板标题。
              </span>
            </button>
          </div>
        </section>
      ),
    },
    {
      key: "tabs",
      hit: visible(["标签", "溢出", "滚动", "平铺", "tab"]),
      node: (
        <section className="settings-section" key="tabs">
          <h4>标签栏溢出</h4>
          <div className="option-cards">
            <button
              className={`option-card${draft.tabOverflow === "scroll" ? " active" : ""}`}
              onClick={() => patch({ tabOverflow: "scroll" as TabOverflow })}
            >
              <span className="option-title">单行滚动</span>
              <span className="option-desc">
                标签页超出一行时水平滚动显示。
              </span>
            </button>
            <button
              className={`option-card${draft.tabOverflow === "wrap" ? " active" : ""}`}
              onClick={() => patch({ tabOverflow: "wrap" as TabOverflow })}
            >
              <span className="option-title">多行平铺</span>
              <span className="option-desc">
                标签页超出一行时自动换行，平铺显示所有标签。
              </span>
            </button>
          </div>
        </section>
      ),
    },
    {
      key: "tray",
      hit: visible(["托盘", "图标", "tray"]),
      node: (
        <section className="settings-section" key="tray">
          <button
            className={`toggle-row${draft.trayIcon ? " on" : ""}`}
            role="switch"
            aria-checked={draft.trayIcon}
            onClick={() => patch({ trayIcon: !draft.trayIcon })}
          >
            <span className="toggle-text">
              <span className="option-title">显示系统托盘/菜单栏图标</span>
              <span className="option-desc">
                开启后在系统托盘显示 ConchTerm 图标，左键点击可快速回到主窗口。
              </span>
            </span>
            <span className="switch">
              <span className="knob" />
            </span>
          </button>
        </section>
      ),
    },
  ].filter((s) => s.hit);

  return (
    <div className="settings-view">
      <nav className="settings-nav">
        <button
          className={`settings-nav-item${category === "appearance" ? " active" : ""}`}
          onClick={() => setCategory("appearance")}
        >
          <Palette size={15} strokeWidth={1.8} />
          外观
        </button>
        <button
          className={`settings-nav-item${category === "ai" ? " active" : ""}`}
          onClick={() => setCategory("ai")}
        >
          <Bot size={15} strokeWidth={1.8} />
          AI
        </button>
        <button
          className={`settings-nav-item${category === "about" ? " active" : ""}`}
          onClick={() => setCategory("about")}
        >
          <Info size={15} strokeWidth={1.8} />
          关于
        </button>
      </nav>

      <div className="settings-main">
        {category === "appearance" && (
          <>
            <div className="settings-search">
              <Search size={14} strokeWidth={1.8} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索设置"
              />
            </div>
            <div className="settings-scroll">
              {sections.length > 0 ? (
                sections.map((s) => s.node)
              ) : (
                <p className="settings-empty">没有匹配的设置项</p>
              )}
            </div>
          </>
        )}
        {category === "ai" && (
          <div className="settings-scroll">
            {/* ---------- AI 配置列表 ---------- */}
            <section className="settings-section">
              <div className="ai-section-head">
                <h4>AI 配置列表</h4>
                <button
                  className="ai-add-btn"
                  onClick={() => {
                    setEditingProvider(null);
                    setProviderFormOpen(true);
                  }}
                >
                  <Plus size={13} strokeWidth={2} />
                  新增配置
                </button>
              </div>
              {providers.length === 0 ? (
                <p className="settings-empty">
                  还没有 AI 配置，点击「新增配置」添加第一个 Provider
                </p>
              ) : (
                <div className="ai-provider-list">
                  {providers.map((p) => (
                    <div
                      key={p.id}
                      className={`ai-provider-card${p.id === activeProviderId ? " active" : ""}`}
                      onClick={() => {
                        setActiveProviderId(p.id);
                        saveActiveProviderId(p.id);
                        window.dispatchEvent(
                          new CustomEvent("conchterm.providers-changed")
                        );
                      }}
                    >
                      <span className="ai-provider-avatar">
                        <Bot size={16} strokeWidth={1.8} />
                      </span>
                      <span className="ai-provider-main">
                        <span className="ai-provider-name">
                          {p.name}
                          {p.id === activeProviderId && (
                            <span className="ai-provider-badge">默认</span>
                          )}
                        </span>
                        <span className="ai-provider-sub">
                          {p.protocol === "anthropic" ? "Claude" : "OpenAI 兼容"}
                          {" · "}
                          {p.activeModel || p.defaultModel}
                          {!p.hasKey && (
                            <span className="ai-provider-warn">未配置 Key</span>
                          )}
                        </span>
                      </span>
                      <span className="ai-provider-actions">
                        <button
                          className="ghost-btn"
                          title="拉取模型列表"
                          disabled={fetchingModelsId !== null}
                          onClick={(e) => {
                            e.stopPropagation();
                            fetchModels(p);
                          }}
                        >
                          {fetchingModelsId === p.id ? (
                            <RotateCcw
                              size={13}
                              strokeWidth={1.8}
                              className="spin"
                            />
                          ) : (
                            <RotateCcw size={13} strokeWidth={1.8} />
                          )}
                        </button>
                        <button
                          className="ai-provider-edit"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingProvider(p);
                            setProviderFormOpen(true);
                          }}
                        >
                          编辑
                        </button>
                        <button
                          className="icon-btn danger"
                          title="删除"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeProvider(p);
                          }}
                        >
                          <Trash2 size={13} strokeWidth={1.8} />
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* ---------- Agent 回合上限 ---------- */}
            <section className="settings-section">
              <h4>Agent 回合上限</h4>
              <p className="ai-field-desc">
                单次 API Agent
                运行的最大工具调用回合数，超过后会暂停并提示继续。
              </p>
              <div className="ai-field-row">
                <input
                  className="ai-number-input"
                  type="number"
                  min={5}
                  max={500}
                  value={draft.agentMaxRounds}
                  onChange={(e) =>
                    patch({ agentMaxRounds: Number(e.target.value) })
                  }
                />
                <span className="ai-field-hint">5–500，默认 30</span>
              </div>
            </section>

            {/* ---------- 默认 AI 模式 ---------- */}
            <section className="settings-section">
              <h4>默认 AI 模式</h4>
              <p className="ai-field-desc">
                新建 AI 对话时使用的模式。切换当前对话的模式不会修改此设置。
              </p>
              <div className="seg-group">
                <button
                  className={`seg-btn${draft.aiDefaultMode === "chat" ? " active" : ""}`}
                  onClick={() => patch({ aiDefaultMode: "chat" })}
                >
                  Ask
                </button>
                <button
                  className={`seg-btn${draft.aiDefaultMode === "agent" ? " active" : ""}`}
                  onClick={() => patch({ aiDefaultMode: "agent" })}
                >
                  Agent
                </button>
              </div>
            </section>

            {/* ---------- 最大重试次数 ---------- */}
            <section className="settings-section">
              <h4>最大重试次数</h4>
              <p className="ai-field-desc">
                遇到瞬时 AI
                错误（限流、超时、网络波动）时的自动重试次数。适用于所有 API
                模式 AI 供应商。
              </p>
              <div className="ai-field-row">
                <input
                  className="ai-number-input"
                  type="number"
                  min={0}
                  max={10}
                  value={draft.aiMaxRetries}
                  onChange={(e) =>
                    patch({ aiMaxRetries: Number(e.target.value) })
                  }
                />
                <span className="ai-field-hint">0–10，默认 2</span>
              </div>
            </section>

            {/* ---------- 全局自定义指令 ---------- */}
            <section className="settings-section">
              <h4>全局自定义指令</h4>
              <p className="ai-field-desc">
                所有 AI 对话自动应用的系统指令，如回答风格、语言偏好等。
              </p>
              <textarea
                className="ai-instruction-input"
                rows={4}
                value={draft.aiCustomInstruction}
                placeholder="例：回答使用中文；优先给出可直接执行的命令；解释保持简短。"
                onChange={(e) =>
                  patch({ aiCustomInstruction: e.target.value })
                }
              />
            </section>

          </div>
        )}
        {category === "about" && (
          <div className="settings-scroll">
            <div className="settings-about">
              <img src="/app-icon.png" alt="ConchTerm" />
              <h3>ConchTerm</h3>
              <p className="dim">版本 0.1.0</p>
              <p className="dim">基于 Tauri 2 的 SSH 终端与 SFTP 文件管理器。</p>
            </div>
          </div>
        )}

        <div className="settings-footer">
          <button disabled={isDefault} onClick={() => setDraft({ ...DEFAULT_SETTINGS })}>
            <RotateCcw size={13} strokeWidth={1.8} />
            恢复默认
          </button>
          <span className="settings-footer-spacer" />
          <button onClick={onClose}>关闭</button>
          <button
            className="primary"
            disabled={!dirty}
            onClick={() => onApply(draft)}
          >
            应用
          </button>
          <button
            className="primary"
            onClick={() => onApplyAndClose(draft)}
          >
            应用并关闭
          </button>
        </div>
      </div>

      {providerFormOpen && (
        <ProviderForm
          initial={editingProvider}
          onCancel={() => setProviderFormOpen(false)}
          onSave={saveProvider}
        />
      )}
    </div>
  );
}
