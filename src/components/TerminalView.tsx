import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  Copy,
  Clipboard,
  SquareAsterisk,
  Eraser,
} from "lucide-react";
import {
  sshConnect,
  sshResize,
  sshWrite,
  type ConnectParams,
} from "../api";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
} from "../settings";

interface Props {
  sessionKey: string;
  params: ConnectParams;
  appearance: TerminalAppearance;
  /** 允许 Ctrl+滚轮临时缩放本终端字体（设置里可关） */
  ctrlWheelZoom: boolean;
  onStatus?: (status: "connected" | "failed") => void;
}

/** 终端右键菜单状态 */
interface TermContextMenu {
  x: number;
  y: number;
}

export interface TerminalAppearance {
  fontFamily: string;
  fontSize: number;
  theme: "light" | "dark";
  accent: string;
  selection: string;
}

// 每个会话键的连接代数：清理时仅当仍是最新一代才真正断开，
// 避免 StrictMode 双挂载时旧的异步断开跑在新连接之后、把新会话杀掉
const disconnectGenerators = new Map<string, number>();

function termTheme(appearance: TerminalAppearance) {
  const light = appearance.theme === "light";
  return {
    background: light ? "#ffffff" : "#16171b",
    foreground: light ? "#24262c" : "#d6d9e0",
    cursor: appearance.accent,
    cursorAccent: light ? "#ffffff" : "#16171b",
    selectionBackground: appearance.selection,
  };
}

function charWidth(code: number): number {
  // CJK 表意文字、假名、谚文及全角形式按 2 列；制表符/✓ 等歧义宽度字符按 1 列
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(s: string): number {
  return [...s].reduce((n, ch) => n + charWidth(ch.charCodeAt(0)), 0);
}

function truncate(s: string, max: number): string {
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = charWidth(ch.charCodeAt(0));
    if (w + cw > max - 1) return out + "…";
    out += ch;
    w += cw;
  }
  return out;
}

function padEnd(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - displayWidth(s)));
}

/**
 * 单个 SSH 终端：挂载即连接，xterm 输出接 Tauri ipc Channel
 * 注意：卸载时断开远端会话
 */
export default function TerminalView({
  sessionKey,
  params,
  appearance,
  ctrlWheelZoom,
  onStatus,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Ctrl+滚轮产生的临时字号偏移（相对设置里的基础字号），仅在当前会话内生效
  const zoomOffsetRef = useRef(0);
  const baseFontSizeRef = useRef(appearance.fontSize);
  // 设置开关的实时值，滚轮监听器只注册一次、按此判断是否生效
  const ctrlWheelZoomRef = useRef(ctrlWheelZoom);
  ctrlWheelZoomRef.current = ctrlWheelZoom;
  // 右键菜单（坐标 + 快照的选区/剪贴板状态，决定菜单项可用性）
  const [ctxMenu, setCtxMenu] = useState<TermContextMenu | null>(null);
  const [ctxHasSelection, setCtxHasSelection] = useState(false);

  const pasteText = (text: string) => {
    if (!text) return;
    sshWrite(sessionKey, new TextEncoder().encode(text));
  };

  const copySelection = () => {
    const term = termRef.current;
    const sel = term?.getSelection();
    if (sel) void writeText(sel).catch(() => {});
  };

  // 设置面板里改字体/主题/字号时，原地更新已存在的终端实例
  useEffect(() => {
    baseFontSizeRef.current = appearance.fontSize;
    // 字号设置变化时重置滚轮缩放偏移，让新字号立即生效
    zoomOffsetRef.current = 0;
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = appearance.fontFamily;
    term.options.fontSize = appearance.fontSize;
    term.options.theme = termTheme(appearance);
    try {
      fitRef.current?.fit();
    } catch {
      // 容器尺寸为 0 时忽略
    }
  }, [appearance]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily: appearance.fontFamily,
      fontSize: appearance.fontSize,
      cursorBlink: true,
      scrollback: 5000,
      theme: termTheme(appearance),
    });
    const fit = new FitAddon();
    termRef.current = term;
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(containerRef.current);

    const doFit = () => {
      try {
        fit.fit();
        sshResize(sessionKey, term.cols, term.rows);
      } catch {
        // 容器尺寸为 0 时（tab 切换瞬间）忽略
      }
    };
    doFit();

    const resizeObserver = new ResizeObserver(() => {
      window.clearTimeout((doFit as any)._t);
      (doFit as any)._t = window.setTimeout(doFit, 100);
    });
    resizeObserver.observe(containerRef.current);

    let disposed = false;

    const connectGen = (disconnectGenerators.get(sessionKey) ?? 0) + 1;
    disconnectGenerators.set(sessionKey, connectGen);

    // MobaXterm 风格的会话信息横幅
    const showBanner = () => {
      const IW = 48; // 横幅内宽（两边界框之间）
      const dim = "\x1b[90m";
      const reset = "\x1b[0m";
      const bar = (l: string, r: string) =>
        `${dim}${l}${"─".repeat(IW)}${r}${reset}`;
      const blank = `${dim}│${" ".repeat(IW)}│${reset}`;
      const text = (plain: string, color = "") =>
        `${dim}│${reset}  ${color}${padEnd(truncate(plain, IW - 3), IW - 3)}${reset} ${dim}│${reset}`;
      const kv = (k: string, v: string, color: string) => {
        const label = padEnd(k, 10);
        const value = truncate(v, IW - 13);
        const fill = " ".repeat(Math.max(0, IW - 13 - displayWidth(value)));
        return `${dim}│${reset}  ${dim}${label}${reset}${color}${value}${reset}${fill} ${dim}│${reset}`;
      };

      const authMethod = params.password
        ? "密码"
        : params.privateKey
          ? "私钥"
          : "-";
      const lines = [
        bar("┌", "┐"),
        blank,
        text("ConchTerm · SSH 终端", "\x1b[1;36m"),
        blank,
        kv("会话", `${params.username}@${params.host}:${params.port}`, "\x1b[37m"),
        kv("认证", authMethod, "\x1b[37m"),
        kv("状态", "✓ 连接成功", "\x1b[1;32m"),
        blank,
        bar("└", "┘"),
      ];
      term.write(lines.join("\r\n") + "\r\n\r\n");
    };

    sshConnect(params, connectGen, (data) => {
      if (!disposed) term.write(data);
    })
      .then((res) => {
        if (res.ok) {
          if (!disposed) showBanner();
          onStatus?.("connected");
        } else {
          if (!disposed) term.writeln(`\r\n\x1b[31m[x] ${res.message}\x1b[0m`);
          onStatus?.("failed");
        }
      })
      .catch((err) => {
        if (!disposed) term.writeln(`\r\n\x1b[31m[x] 连接失败: ${err}\x1b[0m`);
        onStatus?.("failed");
      });

    // Ctrl+滚轮缩放当前终端字体：只影响本标签页，不写全局设置
    const wheelHandler = (e: WheelEvent) => {
      if (!e.ctrlKey || !ctrlWheelZoomRef.current) return;
      e.preventDefault();
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      const step = e.deltaY < 0 ? 1 : -1;
      const next = Math.min(
        TERMINAL_FONT_SIZE_MAX,
        Math.max(
          TERMINAL_FONT_SIZE_MIN,
          baseFontSizeRef.current + zoomOffsetRef.current + step
        )
      );
      if (next === term.options.fontSize) return;
      zoomOffsetRef.current = next - baseFontSizeRef.current;
      term.options.fontSize = next;
      try {
        fit.fit();
        sshResize(sessionKey, term.cols, term.rows);
      } catch {
        // 容器尺寸为 0 时忽略
      }
    };
    const container = containerRef.current;
    container.addEventListener("wheel", wheelHandler, { passive: false });

    // 自定义右键菜单，替代 WebView2 默认菜单
    const contextMenuHandler = (e: MouseEvent) => {
      e.preventDefault();
      setCtxHasSelection(term.hasSelection());
      setCtxMenu({ x: e.clientX, y: e.clientY });
    };
    container.addEventListener("contextmenu", contextMenuHandler);

    const inputHandler = term.onData((d) => {
      sshWrite(sessionKey, new TextEncoder().encode(d));
    });

    // 终端操作快捷键：在按键送达远端之前拦截处理
    // 返回 false 表示已消费该按键，不再写入 PTY
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // 按键抬起/非按下事件放行，避免干扰组合键的释放序列
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey && !e.altKey && !e.metaKey;

      // Ctrl+Shift+C / Ctrl+Insert：复制选区
      if ((e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) || (e.ctrlKey && e.key === "Insert")) {
        const sel = term.getSelection();
        if (sel) {
          void writeText(sel).catch(() => {});
          return false;
        }
        // 无选区时不吞按键
        return true;
      }
      // Ctrl+Shift+V / Shift+Insert：粘贴
      if (
        (e.ctrlKey && e.shiftKey && (e.key === "V" || e.key === "v")) ||
        (e.shiftKey && !e.ctrlKey && e.key === "Insert")
      ) {
        void readText()
          .then((text) => pasteText(text))
          .catch(() => {});
        return false;
      }
      // Ctrl+Shift+A：全选终端缓冲区；Ctrl+A 留给远端 shell（行首跳转）
      if (mod && e.shiftKey && (e.key === "A" || e.key === "a")) {
        term.selectAll();
        return false;
      }
      // Ctrl+L 不拦截：透传给远端 shell，由 readline 原生清屏，不干扰全屏程序
      // Ctrl+Shift+K：本地清屏并清空滚动缓冲（等同 clear 命令的 E3 行为）
      if (e.ctrlKey && e.shiftKey && (e.key === "K" || e.key === "k")) {
        term.write("\x1b[H\x1b[2J\x1b[3J");
        return false;
      }
      // Shift+PageUp / Shift+PageDown：滚动缓冲翻页
      if (e.shiftKey && e.key === "PageUp") {
        term.scrollPages(-1);
        return false;
      }
      if (e.shiftKey && e.key === "PageDown") {
        term.scrollPages(1);
        return false;
      }
      // Ctrl+Home / Ctrl+End：滚到最顶 / 最底
      if (mod && e.key === "Home") {
        term.scrollToTop();
        return false;
      }
      if (mod && e.key === "End") {
        term.scrollToBottom();
        return false;
      }
      return true;
    });

    return () => {
      disposed = true;
      container.removeEventListener("wheel", wheelHandler);
      container.removeEventListener("contextmenu", contextMenuHandler);
      inputHandler.dispose();
      resizeObserver.disconnect();
      import("../api").then(({ sshDisconnect }) =>
        {
          // 仅当本次连接仍是该会话键的最新一代时才真正断开；
          // StrictMode 双挂载时旧清理的断开会晚于新连接完成，跳过以免杀掉新会话
          if (disconnectGenerators.get(sessionKey) === connectGen) {
            disconnectGenerators.delete(sessionKey);
            sshDisconnect(sessionKey).catch(() => {});
          }
        }
      );
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  const closeCtxMenu = () => {
    setCtxMenu(null);
    // 菜单操作后把焦点还给终端，键盘输入不中断
    termRef.current?.focus();
  };

  return (
    <>
      <div ref={containerRef} className="terminal-container" />
      {ctxMenu && (
        <>
          <div
            className="ctx-backdrop"
            onClick={closeCtxMenu}
            onContextMenu={(e) => {
              e.preventDefault();
              closeCtxMenu();
            }}
          />
          <div
            className="ctx-menu"
            style={{
              left: Math.min(ctxMenu.x, window.innerWidth - 190),
              top: Math.min(ctxMenu.y, window.innerHeight - 190),
            }}
          >
            <button
              className="ctx-item"
              disabled={!ctxHasSelection}
              onClick={() => {
                copySelection();
                closeCtxMenu();
              }}
            >
              <Copy size={14} strokeWidth={1.8} />
              复制
              <span className="ctx-key">Ctrl+Shift+C</span>
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                void readText()
                  .then((text) => pasteText(text ?? ""))
                  .catch(() => {});
                closeCtxMenu();
              }}
            >
              <Clipboard size={14} strokeWidth={1.8} />
              粘贴
              <span className="ctx-key">Ctrl+Shift+V</span>
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                termRef.current?.selectAll();
                closeCtxMenu();
              }}
            >
              <SquareAsterisk size={14} strokeWidth={1.8} />
              全选
              <span className="ctx-key">Ctrl+Shift+A</span>
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                termRef.current?.clear();
                closeCtxMenu();
              }}
            >
              <Eraser size={14} strokeWidth={1.8} />
              清屏
              <span className="ctx-key">Ctrl+Shift+K</span>
            </button>
          </div>
        </>
      )}
    </>
  );
}
