import { useMemo, useState } from "react";
import { Info, Palette, RotateCcw, Search } from "lucide-react";
import {
  COLOR_THEMES,
  DEFAULT_SETTINGS,
  TERMINAL_FONTS,
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

interface Props {
  settings: AppSettings;
  onApply: (next: AppSettings) => void;
  onClose: () => void;
}

type Category = "appearance" | "about";

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

export default function SettingsView({ settings, onApply, onClose }: Props) {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [category, setCategory] = useState<Category>("appearance");
  const [query, setQuery] = useState("");

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(settings),
    [draft, settings]
  );
  const isDefault = useMemo(
    () => JSON.stringify(draft) === JSON.stringify(DEFAULT_SETTINGS),
    [draft]
  );

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
      hit: visible(["字体", "font"]),
      node: (
        <div className="settings-grid" key="fonts">
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
            onClick={() => {
              onApply(draft);
              onClose();
            }}
          >
            应用并关闭
          </button>
        </div>
      </div>
    </div>
  );
}
