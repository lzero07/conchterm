// 终端底部 FinalShell 风格状态栏：CPU 圆形仪表 / 内存条 / 网速 / 运行时长 / 用户

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  sysstatStart,
  sysstatStop,
  type SysstatSample,
  type SysstatUpdate,
} from "../api";

interface Props {
  sessionId: string;
  /** 会话连接成功后才开始采样 */
  connected: boolean;
}

/** 字节速率格式化：B/s → KB/s → MB/s */
function formatSpeed(bps: number): string {
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(2)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}

/** 运行时长格式化：115 days / 3:25 / 12:03:45 */
function formatUptime(secs: number): string {
  if (secs <= 0) return "-";
  const days = Math.floor(secs / 86400);
  if (days >= 1) return `${days} days`;
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

const EMPTY: SysstatSample = {
  cpuPercent: 0,
  memUsedMb: 0,
  memTotalMb: 0,
  rxBps: 0,
  txBps: 0,
  uptimeSecs: 0,
  user: "",
};

/** CPU 圆形仪表（SVG 圆环），FinalShell 左上角同款 */
function CpuGauge({ percent }: { percent: number }) {
  const r = 8;
  const c = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, percent));
  const color =
    pct >= 85 ? "#e5534b" : pct >= 60 ? "#d29922" : "#3fb950";
  return (
    <svg className="ss-gauge" viewBox="0 0 22 22" width={20} height={20}>
      <circle cx="11" cy="11" r={r} fill="none" stroke="var(--border)" strokeWidth="3" />
      <circle
        cx="11"
        cy="11"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="3"
        strokeDasharray={`${(c * pct) / 100} ${c}`}
        strokeLinecap="round"
        transform="rotate(-90 11 11)"
      />
      <text
        x="11"
        y="14"
        textAnchor="middle"
        fontSize="8"
        fill="var(--text-0)"
        fontWeight="600"
      >
        {pct > 0 && pct < 1 ? "<1" : Math.round(pct)}
      </text>
    </svg>
  );
}

/** 内存使用率横条 */
function MemBar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const color = pct >= 85 ? "#e5534b" : pct >= 60 ? "#d29922" : "#3fb950";
  const label =
    total > 0
      ? `${(used / 1024).toFixed(2)} GB / ${(total / 1024).toFixed(2)} GB`
      : "-";
  return (
    <span className="ss-mem" title={`内存 ${label}（${pct.toFixed(0)}%）`}>
      <span className="ss-mem-bar">
        <span
          className="ss-mem-fill"
          style={{ width: `${pct}%`, background: color }}
        />
      </span>
      <span className="ss-mem-text">{label}</span>
    </span>
  );
}

/**
 * 系统状态状态栏：挂载即在 Rust 侧启动专用监控连接；
 * 采样事件按 sessionId 过滤，卸载/断开时停止
 */
export default function SessionStatusBar({ sessionId, connected }: Props) {
  const [sample, setSample] = useState<SysstatSample>(EMPTY);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!connected) return;
    setSample(EMPTY);
    setFailed(false);

    let unlistenUpdate: (() => void) | undefined;
    let unlistenStopped: (() => void) | undefined;
    let cancelled = false;

    void listen<SysstatUpdate>("sysstat-update", (event) => {
      const { sessionId: sid, sample: s } = event.payload;
      if (sid !== sessionId) return;
      // Rust 每拍推送完整 sample； Partial 仅作前向兼容兜底
      setSample({ ...EMPTY, ...s });
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenUpdate = fn;
    });

    void listen<{ sessionId: string }>("sysstat-stopped", (event) => {
      if (event.payload.sessionId !== sessionId) return;
      setFailed(true);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenStopped = fn;
    });

    void sysstatStart(sessionId).catch(() => setFailed(true));

    return () => {
      cancelled = true;
      unlistenUpdate?.();
      unlistenStopped?.();
      sysstatStop(sessionId).catch(() => {});
    };
  }, [sessionId, connected]);

  if (!connected || failed) return null;

  return (
    <div className="session-status-bar">
      <CpuGauge percent={sample.cpuPercent} />
      <MemBar used={sample.memUsedMb} total={sample.memTotalMb} />
      <span className="ss-net" title={`接收 ${formatSpeed(sample.rxBps)}`}>
        <span className="ss-net-arrow down">↓</span>
        {formatSpeed(sample.rxBps)}
      </span>
      <span className="ss-net" title={`发送 ${formatSpeed(sample.txBps)}`}>
        <span className="ss-net-arrow up">↑</span>
        {formatSpeed(sample.txBps)}
      </span>
      <span className="ss-uptime" title="运行时长">
        <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        {formatUptime(sample.uptimeSecs)}
      </span>
      <span className="ss-user" title="当前用户">
        <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
        {sample.user || "-"}
      </span>
    </div>
  );
}
