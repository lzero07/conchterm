// ECharts 模块化引入 + 主题读取（跟随应用的亮/暗主题）

import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export { echarts };
export type { EChartsCoreOption } from "echarts/core";

/** 从 CSS 变量读取的图表主题色（构建 option 时取值，主题切换时重建） */
export interface ChartTheme {
  textDim: string; // 轴标签 / 图例
  border: string; // 网格线 / 轴线
  bg2: string; // tooltip 背景
  text0: string; // tooltip 文字
}

export function readChartTheme(): ChartTheme {
  const style = getComputedStyle(document.documentElement);
  return {
    textDim: style.getPropertyValue("--text-dim").trim(),
    border: style.getPropertyValue("--border").trim(),
    bg2: style.getPropertyValue("--bg-2").trim(),
    text0: style.getPropertyValue("--text-0").trim(),
  };
}
