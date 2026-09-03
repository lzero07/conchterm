// useECharts：管理 echarts 实例生命周期（初始化 / 自适应 / 主题联动 / 销毁）

import { useEffect, useRef, useState } from "react";
import { echarts, readChartTheme, type ChartTheme, type EChartsCoreOption } from "./echarts";

/**
 * 挂载一个 ECharts 容器。
 * buildOption 身份变化（数据/筛选变更）或应用主题切换时重绘；
 * 返回 null 表示暂无数据（清空画布）。
 * 容器节点卸载重建（如空状态切换）时自动重新初始化。
 */
export function useECharts(
  buildOption: (theme: ChartTheme) => EChartsCoreOption | null
): (node: HTMLDivElement | null) => void {
  // 用 callback ref + state 持有节点：节点变化即重建实例
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  // 主题联动等通过 ref 取最新回调，避免闭包过期
  const buildRef = useRef(buildOption);
  buildRef.current = buildOption;
  const chartRef = useRef<echarts.ECharts | null>(null);

  const render = () => {
    const chart = chartRef.current;
    if (!chart) return;
    const option = buildRef.current(readChartTheme());
    if (option) {
      chart.setOption(option, { notMerge: true });
    } else {
      chart.clear();
    }
  };

  useEffect(() => {
    if (!node) return;

    const chart = echarts.init(node);
    chartRef.current = chart;
    render();

    // 容器尺寸变化自适应
    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(node);

    // 跟随应用主题（data-theme 属性 / accent 内联变量变化）重建配色
    const mutationObserver = new MutationObserver(render);
    mutationObserver.observe(document.documentElement, {
      attributeFilter: ["data-theme", "style"],
    });

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node]);

  // 数据 / 筛选变化时重绘
  useEffect(() => {
    render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildOption]);

  return setNode;
}
