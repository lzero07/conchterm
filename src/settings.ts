// 应用外观设置的本地持久化（localStorage）

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export type ThemeMode = "light" | "dark" | "system";
export type RadiusStyle = "none" | "small" | "large";
export type LayoutStyle = "modern" | "classic";
export type TabOverflow = "scroll" | "wrap";
export type ColorThemeId = "ocean" | "jade" | "violet" | "coral";
export type UiFontId = "system" | "yahei" | "segoe";
export type TerminalFontId = "consolas" | "cascadia" | "cascadiaMono" | "jetbrains";

export interface ColorTheme {
  name: string;
  accent: string;
  hover: string;
  soft: string;
  selection: string;
}

export const COLOR_THEMES: Record<ColorThemeId, ColorTheme> = {
  ocean: {
    name: "海雾蓝",
    accent: "#4f8cff",
    hover: "#6ba1ff",
    soft: "rgba(79, 140, 255, 0.15)",
    selection: "rgba(79, 140, 255, 0.30)",
  },
  jade: {
    name: "青瓷绿",
    accent: "#2fbf8f",
    hover: "#4fd8ab",
    soft: "rgba(47, 191, 143, 0.15)",
    selection: "rgba(47, 191, 143, 0.30)",
  },
  violet: {
    name: "暮山紫",
    accent: "#9d7bff",
    hover: "#b69aff",
    soft: "rgba(157, 123, 255, 0.15)",
    selection: "rgba(157, 123, 255, 0.30)",
  },
  coral: {
    name: "珊瑚橙",
    accent: "#ff8a5c",
    hover: "#ffa07e",
    soft: "rgba(255, 138, 92, 0.15)",
    selection: "rgba(255, 138, 92, 0.30)",
  },
};

export const UI_FONTS: Record<UiFontId, { name: string; stack: string }> = {
  system: {
    name: "系统默认",
    stack: `"Segoe UI", "Microsoft YaHei", system-ui, sans-serif`,
  },
  yahei: {
    name: "微软雅黑",
    stack: `"Microsoft YaHei", "Segoe UI", sans-serif`,
  },
  segoe: {
    name: "Segoe UI",
    stack: `"Segoe UI", Arial, sans-serif`,
  },
};

export const TERMINAL_FONTS: Record<TerminalFontId, { name: string; stack: string }> = {
  consolas: {
    name: "Consolas",
    stack: `Consolas, "Courier New", monospace`,
  },
  cascadia: {
    name: "Cascadia Code",
    stack: `"Cascadia Code", Consolas, monospace`,
  },
  cascadiaMono: {
    name: "Cascadia Mono",
    stack: `"Cascadia Mono", Consolas, monospace`,
  },
  jetbrains: {
    name: "JetBrains Mono",
    stack: `"JetBrains Mono", Consolas, monospace`,
  },
};

export const ZOOM_OPTIONS = [80, 90, 100, 110, 125, 150];

// 终端字号允许的范围（px），Ctrl+滚轮缩放同样被夹在此区间
export const TERMINAL_FONT_SIZE_MIN = 10;
export const TERMINAL_FONT_SIZE_MAX = 24;
export const TERMINAL_FONT_SIZE_DEFAULT = 14;

export const RADII: Record<RadiusStyle, string> = {
  none: "0px",
  small: "5px",
  large: "10px",
};

export interface AppSettings {
  language: "zh-CN" | "en-US";
  colorTheme: ColorThemeId;
  zoom: number;
  uiFont: UiFontId;
  terminalFont: TerminalFontId;
  /** 终端基础字号（px），Ctrl+滚轮可临时调整 */
  terminalFontSize: number;
  /** Ctrl+滚轮缩放终端字体 */
  ctrlWheelZoom: boolean;
  themeMode: ThemeMode;
  radius: RadiusStyle;
  layout: LayoutStyle;
  tabOverflow: TabOverflow;
  trayIcon: boolean;
  // ---------- AI ----------
  /** Agent 模式单回合最大工具调用轮数（Python 侧护栏） */
  agentMaxRounds: number;
  /** 遇到瞬时 AI 错误（限流/超时/网络波动）的自动重试次数 */
  aiMaxRetries: number;
  /** 新建 AI 对话使用的默认模式 */
  aiDefaultMode: "chat" | "agent";
  /** 全局自定义指令：附加到所有 AI 对话的 system prompt */
  aiCustomInstruction: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  language: "zh-CN",
  colorTheme: "ocean",
  zoom: 100,
  uiFont: "system",
  terminalFont: "consolas",
  terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
  ctrlWheelZoom: true,
  themeMode: "dark",
  radius: "small",
  layout: "modern",
  tabOverflow: "scroll",
  trayIcon: false,
  agentMaxRounds: 30,
  aiMaxRetries: 2,
  aiDefaultMode: "chat",
  aiCustomInstruction: "",
};

const STORAGE_KEY = "conchterm.settings";

// 枚举字段校验：localStorage 里的旧/坏数据回落默认值
function pick<T extends string>(
  value: unknown,
  record: Record<string, unknown>,
  fallback: T
): T {
  return typeof value === "string" && value in record ? (value as T) : fallback;
}

// 终端字号校验：非数字或超出范围时夹到合法区间
function clampFontSize(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return TERMINAL_FONT_SIZE_DEFAULT;
  return Math.min(
    TERMINAL_FONT_SIZE_MAX,
    Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(n))
  );
}

// 整数设置校验：非法值回落默认，合法值夹到 [min, max]
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    return {
      language: merged.language === "en-US" ? "en-US" : "zh-CN",
      colorTheme: pick(merged.colorTheme, COLOR_THEMES, DEFAULT_SETTINGS.colorTheme),
      zoom: ZOOM_OPTIONS.includes(merged.zoom)
        ? merged.zoom
        : DEFAULT_SETTINGS.zoom,
      uiFont: pick(merged.uiFont, UI_FONTS, DEFAULT_SETTINGS.uiFont),
      terminalFont: pick(merged.terminalFont, TERMINAL_FONTS, DEFAULT_SETTINGS.terminalFont),
      terminalFontSize: clampFontSize(merged.terminalFontSize),
      ctrlWheelZoom: merged.ctrlWheelZoom !== false,
      themeMode: pick(merged.themeMode, { light: 1, dark: 1, system: 1 }, DEFAULT_SETTINGS.themeMode),
      radius: pick(merged.radius, RADII, DEFAULT_SETTINGS.radius),
      layout: pick(merged.layout, { modern: 1, classic: 1 }, DEFAULT_SETTINGS.layout),
      tabOverflow: pick(merged.tabOverflow, { scroll: 1, wrap: 1 }, DEFAULT_SETTINGS.tabOverflow),
      trayIcon: merged.trayIcon === true,
      agentMaxRounds: clampInt(merged.agentMaxRounds, 5, 500, DEFAULT_SETTINGS.agentMaxRounds),
      aiMaxRetries: clampInt(merged.aiMaxRetries, 0, 10, DEFAULT_SETTINGS.aiMaxRetries),
      aiDefaultMode: merged.aiDefaultMode === "agent" ? "agent" : "chat",
      aiCustomInstruction:
        typeof merged.aiCustomInstruction === "string"
          ? merged.aiCustomInstruction
          : "",
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings, null, 2));
}

export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

// 把外观设置写入根节点 CSS 变量 / data 属性，供全局样式消费
export function applyAppearance(settings: AppSettings): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(settings.themeMode);
  root.dataset.layout = settings.layout;
  const theme = COLOR_THEMES[settings.colorTheme] ?? COLOR_THEMES.ocean;
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--accent-hover", theme.hover);
  root.style.setProperty("--accent-soft", theme.soft);
  root.style.setProperty("--radius", RADII[settings.radius]);
  root.style.setProperty(
    "--font-ui",
    UI_FONTS[settings.uiFont]?.stack ?? UI_FONTS.system.stack
  );
}

// 优先用 WebView 原生缩放；纯浏览器调试时退回 CSS zoom
export async function applyZoom(percent: number): Promise<void> {
  const scale = percent / 100;
  try {
    await getCurrentWebviewWindow().setZoom(scale);
    document.body.style.zoom = "";
  } catch {
    document.body.style.zoom = String(scale);
  }
}
