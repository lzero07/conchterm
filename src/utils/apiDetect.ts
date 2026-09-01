export interface DetectResult {
  baseUrl: string;
  models: string[];
}

function normalizeBase(input: string): string {
  return input.replace(/\/+$/, "");
}

function buildUrl(base: string, path: string): string {
  return `${base}${path}`;
}

async function tryFetchModels(
  base: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string[] | null> {
  try {
    const res = await fetch(buildUrl(base, "/models"), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json && Array.isArray(json.data)) {
      return json.data.map((m: { id?: string }) => m.id).filter(Boolean);
    }
    return null;
  } catch {
    return null;
  }
}

export async function detectBaseUrl(
  userInput: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<DetectResult> {
  const base = normalizeBase(userInput);

  const withV1 = await tryFetchModels(buildUrl(base, "/v1"), apiKey, signal);
  if (withV1) {
    return { baseUrl: buildUrl(base, "/v1"), models: withV1 };
  }

  const withoutV1 = await tryFetchModels(base, apiKey, signal);
  if (withoutV1) {
    return { baseUrl: base, models: withoutV1 };
  }

  throw new Error(
    "无法自动检测 API 路径。请确认 URL 和 API Key 是否正确，或手动填写完整 Base URL。",
  );
}
