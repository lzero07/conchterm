// 监控中心：token 用量统计（KPI + 趋势折线 + Provider 分布 + 模型明细）

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { usageFilterOptions, usageQuery } from "./api";
import type { ProviderUsageOption, UsageReport } from "./types";
import { useECharts } from "./useECharts";
import { type ChartTheme, type EChartsCoreOption } from "./echarts";
import TimeRangePicker, {
  defaultRange,
  type TimeRange,
} from "./TimeRangePicker";

/** 自动刷新间隔（秒）；0 = 关闭 */
const REFRESH_OPTIONS = [0, 5, 10, 30, 60];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatDayBucket(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 前端按本地时间补齐 SQL 缺失的空桶（与 usage_db.rs 的 strftime 格式一致）。
 *  桶数上限 400：超出（如"全部"跨数年）时返回 null，退化为只显示有数据的桶。 */
function buildBuckets(
  startTs: number,
  endTs: number,
  granularity: "hour" | "day"
): string[] | null {
  const buckets: string[] = [];
  if (granularity === "day") {
    // 从起始日的当天 0 点逐天推进
    const cursor = new Date(startTs);
    cursor.setHours(0, 0, 0, 0);
    const endDay = formatDayBucket(new Date(endTs));
    while (formatDayBucket(cursor) <= endDay) {
      if (buckets.length > 400) return null;
      buckets.push(formatDayBucket(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
  } else {
    const cursor = new Date(startTs);
    cursor.setMinutes(0, 0, 0);
    const formatter = (d: Date) =>
      `${formatDayBucket(d)} ${pad2(d.getHours())}:00`;
    const endHour = formatter(new Date(endTs));
    while (formatter(cursor) <= endHour) {
      if (buckets.length > 400) return null;
      buckets.push(formatter(cursor));
      cursor.setTime(cursor.getTime() + 3_600_000);
    }
  }
  return buckets;
}

/** token 数量：万/亿缩写，小数字保留千分位 */
function formatTokens(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return n.toLocaleString();
}

/** 系列固定色（输入=蓝、输出=绿，两个图表保持一致；亮/暗模式分别取浅深两档） */
function seriesColors(): { input: string; output: string } {
  const isDark =
    document.documentElement.getAttribute("data-theme") !== "light";
  return isDark ? { input: "#3987e5", output: "#199e70" } : { input: "#2a78d6", output: "#1baf7a" };
}

function buildTrendOption(
  report: UsageReport,
  startTs: number,
  endTs: number,
  granularity: "hour" | "day",
  theme: ChartTheme
): EChartsCoreOption {
  // 桶数过多时（长跨度"全部"）不做零填充，只画有数据的桶
  const buckets = buildBuckets(startTs, endTs, granularity);
  const byBucket = new Map(report.trend.map((p) => [p.bucket, p]));
  const fill = (key: "inputTokens" | "outputTokens") =>
    buckets
      ? buckets.map((b) => byBucket.get(b)?.[key] ?? 0)
      : report.trend.map((p) => p[key]);
  const xLabels = buckets ?? report.trend.map((p) => p.bucket);
  const input = fill("inputTokens");
  const output = fill("outputTokens");
  const colors = seriesColors();
  return {
    animation: false,
    grid: { left: 12, right: 16, top: 34, bottom: 8, containLabel: true },
    legend: {
      top: 4,
      right: 8,
      icon: "roundRect",
      itemWidth: 14,
      itemHeight: 4,
      textStyle: { color: theme.textDim, fontSize: 12 },
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: theme.bg2,
      borderColor: theme.border,
      textStyle: { color: theme.text0, fontSize: 12 },
      valueFormatter: (value: unknown) =>
        (value as number).toLocaleString() + " tokens",
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: xLabels,
      axisLine: { lineStyle: { color: theme.border } },
      axisTick: { show: false },
      axisLabel: { color: theme.textDim, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: theme.border } },
      axisLabel: {
        color: theme.textDim,
        fontSize: 11,
        formatter: (v: number) => formatTokens(v),
      },
    },
    series: [
      {
        name: "输入",
        type: "line",
        smooth: true,
        smoothMonotone: "x",
        data: input,
        showSymbol: false,
        lineStyle: { width: 2, color: colors.input },
        itemStyle: { color: colors.input },
        emphasis: { disabled: false },
      },
      {
        name: "输出",
        type: "line",
        smooth: true,
        smoothMonotone: "x",
        data: output,
        showSymbol: false,
        lineStyle: { width: 2, color: colors.output },
        itemStyle: { color: colors.output },
      },
    ],
  };
}

function buildProviderOption(
  report: UsageReport,
  theme: ChartTheme
): EChartsCoreOption | null {
  const slices = report.byProvider.slice(0, 8).reverse(); // 横向条形图：总量大的在上面
  if (slices.length === 0) return null;
  const colors = seriesColors();
  return {
    animation: false,
    grid: { left: 12, right: 40, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      backgroundColor: theme.bg2,
      borderColor: theme.border,
      textStyle: { color: theme.text0, fontSize: 12 },
      valueFormatter: (value: unknown) =>
        (value as number).toLocaleString() + " tokens",
    },
    xAxis: {
      type: "value",
      splitLine: { lineStyle: { color: theme.border } },
      axisLabel: {
        color: theme.textDim,
        fontSize: 11,
        formatter: (v: number) => formatTokens(v),
      },
    },
    yAxis: {
      type: "category",
      data: slices.map((s) => s.providerName),
      axisLine: { lineStyle: { color: theme.border } },
      axisTick: { show: false },
      axisLabel: { color: theme.textDim, fontSize: 11 },
    },
    series: [
      {
        name: "输入",
        type: "bar",
        stack: "tokens",
        data: slices.map((s) => s.inputTokens),
        barMaxWidth: 16,
        itemStyle: { color: colors.input },
      },
      {
        name: "输出",
        type: "bar",
        stack: "tokens",
        data: slices.map((s) => s.outputTokens),
        barMaxWidth: 16,
        itemStyle: { color: colors.output, borderRadius: [0, 3, 3, 0] },
      },
    ],
  };
}

export default function MonitorView() {
  const [range, setRange] = useState<TimeRange>(defaultRange);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [options, setOptions] = useState<ProviderUsageOption[]>([]);
  const [refreshSec, setRefreshSec] = useState(0);
  const refreshTimer = useRef<number | null>(null);

  // 趋势粒度：跨度 ≤ 48 小时按小时，否则按天
  const granularity: "hour" | "day" =
    range.endTs - range.startTs <= 48 * 3_600_000 && range.startTs > 0
      ? "hour"
      : "day";

  // 查询引用快照，供自动刷新定时器使用
  const queryRef = useRef({ range, providerId, model, granularity });
  queryRef.current = { range, providerId, model, granularity };

  const fetchReport = useCallback(() => {
    const { range: r, providerId: p, model: m, granularity: g } = queryRef.current;
    let cancelled = false;
    setLoading(true);
    setError("");
    void usageQuery({
      startTs: r.startTs,
      endTs: r.endTs,
      providerId: p,
      model: m,
      granularity: g,
    })
      .then((rep) => {
        if (!cancelled) setReport(rep);
      })
      .catch((e) => {
        if (!cancelled) {
          setReport(null);
          setError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 筛选变化立即查询
  useEffect(fetchReport, [fetchReport, range, providerId, model, granularity]);

  // 手动刷新：若"跟随当前时刻"则推进 endTs（setRange 会触发重新查询）
  const refresh = () => {
    if (queryRef.current.range.followNow) {
      setRange((r) => ({ ...r, endTs: Date.now() }));
    } else {
      fetchReport();
    }
  };
  useEffect(() => {
    if (refreshTimer.current !== null) {
      window.clearInterval(refreshTimer.current);
      refreshTimer.current = null;
    }
    if (refreshSec <= 0) return;
    refreshTimer.current = window.setInterval(refresh, refreshSec * 1000);
    return () => {
      if (refreshTimer.current !== null) {
        window.clearInterval(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [refreshSec, fetchReport]);

  // 刷新筛选下拉（Provider/模型可能新出现，也可能被删除）
  const reloadOptions = useCallback(() => {
    void usageFilterOptions()
      .then((opts) => {
        setOptions(opts);
        // 清掉失效的选中项：Provider/模型被删后其筛选值不再合法
        const pid = queryRef.current.providerId;
        const model = queryRef.current.model;
        if (pid && !opts.some((o) => o.providerId === pid)) {
          setProviderId("");
        }
        if (model && !opts.some((o) => o.models.includes(model))) {
          setModel("");
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    void usageFilterOptions()
      .then(setOptions)
      .catch(() => setOptions([]));
  }, []);

  // AI 对话回合结束后新用量落库：防抖重查，边聊边看也能实时累计。
  // 对话端在 Rust 落库之后才发 done（事件里带 usage），收到事件时数据必然已可查
  useEffect(() => {
    let timer: number | null = null;
    const onUsageChanged = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        reloadOptions();
        // followNow 时推进 endTs 让新区间覆盖刚落库的记录，否则直接重查
        if (queryRef.current.range.followNow) {
          setRange((r) => ({ ...r, endTs: Date.now() }));
        } else {
          fetchReport();
        }
      }, 800);
    };
    window.addEventListener("conchterm.usage-changed", onUsageChanged);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("conchterm.usage-changed", onUsageChanged);
    };
  }, [fetchReport, reloadOptions]);

  const trendRef = useECharts(
    useCallback(
      (theme: ChartTheme) =>
        report
          ? buildTrendOption(
              report,
              range.startTs,
              range.endTs,
              granularity,
              theme
            )
          : null,
      [report, range, granularity]
    )
  );

  const providerChartRef = useECharts(
    useCallback(
      (theme: ChartTheme) => {
        if (!report) return null;
        return buildProviderOption(report, theme);
      },
      [report]
    )
  );

  // 模型下拉：选中 Provider 时只显示它的模型
  const modelOptions = useMemo(() => {
    if (!providerId) {
      const all = new Set<string>();
      options.forEach((o) => o.models.forEach((m) => all.add(m)));
      return [...all].sort();
    }
    return options.find((o) => o.providerId === providerId)?.models ?? [];
  }, [options, providerId]);

  return (
    <div className={`monitor-view${loading ? " loading" : ""}`}>
      <div className="monitor-filters">
        <TimeRangePicker value={range} onChange={setRange} />
        <div className="monitor-filter-right">
          <select
            className="monitor-select"
            value={providerId}
            onChange={(e) => {
              setProviderId(e.target.value);
              setModel("");
            }}
          >
            <option value="">全部 Provider</option>
            {options.map((o) => (
              <option key={o.providerId} value={o.providerId}>
                {o.providerName}
              </option>
            ))}
          </select>
          <select
            className="monitor-select"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">全部模型</option>
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select
            className="monitor-select refresh-select"
            value={refreshSec}
            title="自动刷新"
            onChange={(e) => setRefreshSec(Number(e.target.value))}
          >
            {REFRESH_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s === 0 ? "不自动刷新" : `${s}s`}
              </option>
            ))}
          </select>
          <button
            className="monitor-refresh-btn"
            title="刷新"
            onClick={refresh}
          >
            <RefreshCw size={13} strokeWidth={1.8} />
          </button>
        </div>
        {error && <span className="monitor-error">{error}</span>}
      </div>

      <div className="monitor-kpis">
        <div className="monitor-kpi">
          <span className="monitor-kpi-label">总请求</span>
          <span className="monitor-kpi-value">
            {report ? report.requests.toLocaleString() : "—"}
          </span>
        </div>
        <div className="monitor-kpi">
          <span className="monitor-kpi-label">输入 Tokens</span>
          <span className="monitor-kpi-value">
            {report ? formatTokens(report.inputTokens) : "—"}
          </span>
        </div>
        <div className="monitor-kpi">
          <span className="monitor-kpi-label">输出 Tokens</span>
          <span className="monitor-kpi-value">
            {report ? formatTokens(report.outputTokens) : "—"}
          </span>
        </div>
        <div className="monitor-kpi accent">
          <span className="monitor-kpi-label">总 Tokens</span>
          <span className="monitor-kpi-value">
            {report ? formatTokens(report.totalTokens) : "—"}
          </span>
        </div>
      </div>

      {report && report.requests === 0 ? (
        <div className="empty-state monitor-empty">
          <Activity size={26} strokeWidth={1.5} />
          <p>暂无用量数据</p>
          <span>在 AI 助手中发起对话后，这里会展示 Token 消耗统计</span>
        </div>
      ) : (
        <>
          <div className="monitor-card">
            <div className="monitor-card-title">Token 趋势</div>
            <div ref={trendRef} className="monitor-chart" />
          </div>
          {report && report.byProvider.length > 0 && (
            <div className="monitor-card">
              <div className="monitor-card-title">Provider 用量分布</div>
              <div ref={providerChartRef} className="monitor-chart short" />
            </div>
          )}
          {report && report.byModel.length > 0 && (
            <div className="monitor-card">
              <div className="monitor-card-title">模型明细</div>
              <table className="monitor-table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>模型</th>
                    <th className="num">请求</th>
                    <th className="num">输入</th>
                    <th className="num">输出</th>
                    <th className="num">总计</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byModel.map((m) => (
                    <tr key={`${m.providerName}/${m.model}`}>
                      <td>{m.providerName}</td>
                      <td className="mono">{m.model}</td>
                      <td className="num">{m.requests.toLocaleString()}</td>
                      <td className="num">{m.inputTokens.toLocaleString()}</td>
                      <td className="num">{m.outputTokens.toLocaleString()}</td>
                      <td className="num">
                        {m.totalTokens.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
