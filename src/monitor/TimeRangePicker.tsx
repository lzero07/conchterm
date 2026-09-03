// 时间范围选择器：预设快捷项（当天 / 1d / 7d / 14d / 30d / 全部）+ 自定义起止日期时间（内置月历）

import { useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
} from "lucide-react";

export interface TimeRange {
  startTs: number;
  endTs: number;
  /** 结束时间跟随当前时刻（每次刷新顺带推进 endTs） */
  followNow?: boolean;
  /** 筛选按钮上展示的标签（当天 / 7d / 09/03 00:00 ~ 现在） */
  label: string;
}

const DAY_MS = 24 * 3_600_000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function startOfDay(d: Date): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function startOfMonth(ms: number): number {
  const d = new Date(ms);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 默认范围：当天 0 点 -> 当前时刻（跟随当前时刻，刷新时推进 endTs） */
export function defaultRange(): TimeRange {
  return {
    startTs: startOfDay(new Date()),
    endTs: Date.now(),
    followNow: true,
    label: "当天",
  };
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtShort(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${fmtTime(ms)}`;
}

/** 只换日期、保留时分 */
function setDatePart(ms: number, dayStart: number): number {
  const t = new Date(ms);
  const d = new Date(dayStart);
  d.setHours(t.getHours(), t.getMinutes(), 0, 0);
  return d.getTime();
}

/** 只换时分、保留日期 */
function setTimePart(ms: number, hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(ms);
  d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
}

interface Preset {
  label: string;
  make: () => TimeRange;
}

const PRESETS: Preset[] = [
  {
    label: "当天",
    make: () => ({
      startTs: startOfDay(new Date()),
      endTs: Date.now(),
      followNow: true,
      label: "当天",
    }),
  },
  ...[1, 7, 14, 30].map((days) => ({
    label: `${days}d`,
    make: () => ({
      startTs: Date.now() - days * DAY_MS,
      endTs: Date.now(),
      followNow: true,
      label: `${days}d`,
    }),
  })),
  {
    label: "全部",
    make: () => ({ startTs: 0, endTs: Date.now(), followNow: true, label: "全部" }),
  },
];

/** 弹层内的草稿状态 */
interface Draft {
  startMs: number;
  endMs: number;
  followNow: boolean;
}

function MonthCalendar({
  monthStart,
  selected,
  onNav,
  onSelect,
}: {
  monthStart: number;
  selected: number;
  onNav: (delta: number) => void;
  onSelect: (dayStart: number) => void;
}) {
  const base = new Date(monthStart);
  const year = base.getFullYear();
  const month = base.getMonth();
  // 从当月 1 号回退到网格起点（周日开头）
  const gridStart = new Date(base);
  gridStart.setDate(1 - base.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
  const today = new Date();
  const selDate = new Date(selected);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  return (
    <div className="tr-cal">
      <div className="tr-cal-head">
        <button className="tr-cal-nav" title="上个月" onClick={() => onNav(-1)}>
          <ChevronLeft size={14} strokeWidth={2} />
        </button>
        <span className="tr-cal-title">
          {year}年{month + 1}月
        </span>
        <button className="tr-cal-nav" title="下个月" onClick={() => onNav(1)}>
          <ChevronRight size={14} strokeWidth={2} />
        </button>
      </div>
      <div className="tr-cal-grid">
        {["日", "一", "二", "三", "四", "五", "六"].map((w) => (
          <span key={w} className="tr-cal-dow">
            {w}
          </span>
        ))}
        {cells.map((d) => {
          const cls = [
            "tr-cal-day",
            d.getMonth() !== month ? "dim" : "",
            sameDay(d, selDate) ? "selected" : "",
            sameDay(d, today) ? "today" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button key={d.getTime()} className={cls} onClick={() => onSelect(startOfDay(d))}>
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function TimeRangePicker({
  value,
  onChange,
}: {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>({ startMs: 0, endMs: 0, followNow: false });
  /** 月历当前作用于开始还是结束时间 */
  const [focused, setFocused] = useState<"start" | "end">("start");
  const [viewMonth, setViewMonth] = useState(startOfMonth(Date.now()));
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const openPicker = () => {
    // 当前为"全部"等无意义起点时，草稿回退到近 30 天
    const now = Date.now();
    const startMs = value.startTs > 0 ? value.startTs : now - 30 * DAY_MS;
    setDraft({
      startMs,
      endMs: Math.max(value.endTs, startMs),
      followNow: value.followNow ?? false,
    });
    setFocused("start");
    setViewMonth(startOfMonth(startMs));
    setOpen(true);
  };

  const confirm = () => {
    const followNow = draft.followNow;
    const endTs = followNow ? Date.now() : draft.endMs;
    onChange({
      startTs: draft.startMs,
      endTs,
      followNow,
      label: followNow
        ? `${fmtShort(draft.startMs)} ~ 现在`
        : `${fmtShort(draft.startMs)} ~ ${fmtShort(draft.endMs)}`,
    });
    setOpen(false);
  };

  const setStart = (hhmm: string) => {
    setDraft((d) => {
      const startMs = setTimePart(d.startMs, hhmm);
      // 开始越过结束时，把结束推到与开始一致，保持区间有效
      if (!d.followNow && startMs > d.endMs) return { ...d, startMs, endMs: startMs };
      return { ...d, startMs };
    });
  };

  const setEnd = (hhmm: string) => {
    setDraft((d) => {
      const endMs = setTimePart(d.endMs, hhmm);
      if (!d.followNow && endMs < d.startMs) return { ...d, endMs, startMs: endMs };
      return { ...d, endMs };
    });
  };

  const pickDay = (dayStart: number) => {
    setDraft((d) => {
      if (focused === "start") {
        const startMs = setDatePart(d.startMs, dayStart);
        if (!d.followNow && startMs > d.endMs) return { ...d, startMs, endMs: startMs };
        return { ...d, startMs };
      }
      const endMs = setDatePart(d.endMs, dayStart);
      if (!d.followNow && endMs < d.startMs) return { ...d, endMs, startMs: endMs };
      return { ...d, endMs };
    });
    // 选完开始自动切换到结束
    if (focused === "start") setFocused("end");
  };

  // 结束时间跟随当前时刻：弹层打开期间每 30s 刷新显示
  useEffect(() => {
    if (!open || !draft.followNow) return;
    const id = window.setInterval(
      () => setDraft((d) => (d.followNow ? { ...d, endMs: Date.now() } : d)),
      30_000
    );
    return () => window.clearInterval(id);
  }, [open, draft.followNow]);

  // 点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="tr-wrap" ref={wrapRef}>
      <button
        className={`tr-btn${open ? " active" : ""}`}
        title="时间范围"
        onClick={() => (open ? setOpen(false) : openPicker())}
      >
        <CalendarDays size={13} strokeWidth={1.8} />
        <span className="tr-btn-label">{value.label}</span>
        <ChevronDown size={13} strokeWidth={2} />
      </button>

      {open && (
        <div className="tr-pop">
          <div className="tr-chips">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                className={`tr-chip${value.label === p.label ? " active" : ""}`}
                onClick={() => {
                  onChange(p.make());
                  setOpen(false);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="tr-main">
            <div className="tr-left">
              <span className="tr-hint">支持日期与时间</span>
              <div
                className={`tr-field${focused === "start" ? " focused" : ""}`}
                onClick={() => setFocused("start")}
              >
                <span className="tr-field-label">开始时间</span>
                <div className="tr-field-row">
                  <span className="tr-date">{fmtDate(draft.startMs)}</span>
                  <CalendarDays size={14} strokeWidth={1.8} />
                  <input
                    type="time"
                    className="tr-time"
                    value={fmtTime(draft.startMs)}
                    onChange={(e) => setStart(e.target.value)}
                  />
                  <Clock size={14} strokeWidth={1.8} />
                </div>
              </div>
              <div
                className={`tr-field${focused === "end" ? " focused" : ""}${draft.followNow ? " disabled" : ""}`}
                onClick={() => setFocused("end")}
              >
                <span className="tr-field-label">结束时间</span>
                <div className="tr-field-row">
                  <span className="tr-date">{fmtDate(draft.endMs)}</span>
                  <CalendarDays size={14} strokeWidth={1.8} />
                  <input
                    type="time"
                    className="tr-time"
                    value={fmtTime(draft.endMs)}
                    onChange={(e) => setEnd(e.target.value)}
                  />
                  <Clock size={14} strokeWidth={1.8} />
                </div>
              </div>
              <label className="tr-check">
                <input
                  type="checkbox"
                  checked={draft.followNow}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      followNow: e.target.checked,
                      endMs: e.target.checked ? Date.now() : d.endMs,
                    }))
                  }
                />
                结束时间跟随当前时刻
              </label>
              <div className="tr-footer">
                <button className="tr-cancel" onClick={() => setOpen(false)}>
                  取消
                </button>
                <button className="primary" onClick={confirm}>
                  确定
                </button>
              </div>
            </div>
            <MonthCalendar
              monthStart={viewMonth}
              selected={focused === "start" ? draft.startMs : draft.endMs}
              onNav={(delta) =>
                setViewMonth((m) => {
                  const d = new Date(m);
                  d.setMonth(d.getMonth() + delta);
                  return d.getTime();
                })
              }
              onSelect={pickDay}
            />
          </div>
        </div>
      )}
    </div>
  );
}
