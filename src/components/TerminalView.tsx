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
}

/**
 * 单个 SSH 终端：挂载即连接，xterm 输出接 Tauri ipc Channel
 * 注意：卸载时断开远端会话
 */
export default function TerminalView({ sessionKey, params }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sessionStartedRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || sessionStartedRef.current) return;
    sessionStartedRef.current = true;

    const term = new Terminal({
      fontFamily: "Consolas, 'Courier New', monospace",
      fontSize: 14,
      cursorBlink: true,
      theme: {
        background: "#1e1e1e",
        foreground: "#cccccc",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    termRef.current = term;

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

    sshConnect(params, (data) => {
      if (!disposed) term.write(data);
    })
      .then((res) => {
        if (!res.ok) term.writeln(`\r\n[x] ${res.message}`);
      })
      .catch((err) => {
        term.writeln(`\r\n[x] 连接失败: ${err}`);
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
