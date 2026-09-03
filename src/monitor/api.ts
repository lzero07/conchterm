// 监控中心后端命令的 TS 调用封装

import { invoke } from "@tauri-apps/api/core";
import type { ProviderUsageOption, UsageQueryArgs, UsageReport } from "./types";

/** 聚合查询 token 用量（汇总 / 趋势 / Provider / 模型分布） */
export function usageQuery(args: UsageQueryArgs): Promise<UsageReport> {
  return invoke<UsageReport>("usage_query", {
    args: {
      startTs: args.startTs,
      endTs: args.endTs,
      providerId: args.providerId ?? "",
      model: args.model ?? "",
      granularity: args.granularity ?? null,
    },
  });
}

/** 筛选下拉数据源：出现过的 Provider 及其模型 */
export function usageFilterOptions(): Promise<ProviderUsageOption[]> {
  return invoke<ProviderUsageOption[]>("usage_filter_options");
}

/** 删除 Provider 时连带清掉其历史用量记录（监控中心不再出现） */
export function usageDeleteProvider(providerId: string): Promise<void> {
  return invoke("usage_delete_provider", { providerId });
}
