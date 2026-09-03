// 监控中心相关类型（与 usage_db.rs 的 serde camelCase 输出一一对应）

export interface UsageQueryArgs {
  startTs: number;
  endTs: number;
  /** 空 = 全部 */
  providerId?: string;
  /** 空 = 全部 */
  model?: string;
  granularity?: "hour" | "day";
}

export interface TrendPoint {
  bucket: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ProviderSlice {
  providerId: string;
  providerName: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ModelSlice {
  providerName: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface UsageReport {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  byProvider: ProviderSlice[];
  byModel: ModelSlice[];
  trend: TrendPoint[];
}

export interface ProviderUsageOption {
  providerId: string;
  providerName: string;
  models: string[];
}
