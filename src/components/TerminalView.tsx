import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  sshConnect,
  sshResize,
  sshWrite,
  type ConnectParams,
} from "../api";

interface Props {
  sessionKey: string;
  params: ConnectParams;
  onStatus?: (status: "connected" | "failed") => void;
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
export default function TerminalView({ sessionKey, params, onStatus }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily: "Consolas, 'Courier New', monospace",
      fontSize: 14,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: "#16171b",
        foreground: "#d6d9e0",
        cursor: "#4f8cff",
        cursorAccent: "#16171b",
        selectionBackground: "rgba(79, 140, 255, 0.30)",
      },
    });
    const fit = new FitAddon();
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
        text("ShellTool · SSH 终端", "\x1b[1;36m"),
        blank,
        kv("会话", `${params.username}@${params.host}:${params.port}`, "\x1b[37m"),
        kv("认证", authMethod, "\x1b[37m"),
        kv("状态", "✓ 连接成功", "\x1b[1;32m"),
        blank,
        bar("└", "┘"),
      ];
      term.write(lines.join("\r\n") + "\r\n\r\n");
    };

    sshConnect(params, (data) => {
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

    const inputHandler = term.onData((d) => {
      sshWrite(sessionKey, new TextEncoder().encode(d));
    });

    return () => {
      disposed = true;
      inputHandler.dispose();
      resizeObserver.disconnect();
      import("../api").then(({ sshDisconnect }) =>
        sshDisconnect(sessionKey).catch(() => {})
      );
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  return <div ref={containerRef} className="terminal-container" />;
}
