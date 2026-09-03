// 长期记忆的自动提取：对话回合结束后，用同一 Provider 发一次轻量请求，
// 让模型从本轮对话中挑出值得跨会话记住的信息（偏好/环境事实）。
// 模块级 fire-and-forget：不碰任何组件 state，面板卸载不影响入库。

import { agentChat } from "./api";
import { dbAddMemory, dbListMemories, type MemoryItem } from "./db";
import type { AgentEntry, AgentProvider } from "./types";

const EXTRACT_SYSTEM_PROMPT =
  "你是对话记忆提取器。从用户与助手的对话中提取值得跨会话长期记住的信息，" +
  "只提取持久性内容：用户的偏好、习惯、服务器/环境事实、常用配置等。" +
  "不要提取：寒暄、一次性任务、临时问题、常识。" +
  '严格输出 JSON：{"memories": ["一句话记忆", ...]}，最多 5 条，每条不超过 200 字；' +
  "没有值得记住的内容就输出 {\"memories\": []}。不要输出 JSON 以外的任何文字。";

const MAX_EXTRACT_MESSAGES = 8;
const MAX_AUTO_MEMORIES = 5;
const MAX_MEMORY_LENGTH = 200;

/** 提取进行中标志：同一时刻最多一次提取请求，忙时直接跳过 */
let extracting = false;

/** 从助手回复/事件流文本里容错截取 JSON（模型可能包裹 ```json 代码块） */
function parseMemories(text: string): string[] {
  let raw = text.trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) raw = fenced[1].trim();
  try {
    return normalize(raw);
  } catch {
    // 非 JSON：截取第一个 {...} 再试
    const brace = raw.match(/\{[\s\S]*\}/);
    if (brace) {
      try {
        return normalize(brace[0]);
      } catch {
        return [];
      }
    }
    return [];
  }

  function normalize(json: string): string[] {
    const parsed = JSON.parse(json) as { memories?: unknown };
    const list = Array.isArray(parsed?.memories) ? parsed.memories : [];
    return list
      .filter((m): m is string => typeof m === "string" && m.trim() !== "")
      .map((m) => m.trim().slice(0, MAX_MEMORY_LENGTH))
      .slice(0, MAX_AUTO_MEMORIES);
  }
}

/** 收集 delta 直到 done，返回完整回复文本 */
function collectStream(
  provider: AgentProvider,
  messages: { role: "system" | "user"; content: string }[],
  onSettled: (text: string | null) => void
): void {
  let text = "";
  let settled = false;
  const finish = (result: string | null) => {
    if (settled) return;
    settled = true;
    onSettled(result);
  };
  void agentChat(provider, messages, "memory", (event) => {
    if (event.type === "delta") {
      text += event.content ?? "";
    } else if (event.type === "done") {
      // 提取请求本身也消耗 token，通知监控中心刷新统计
      window.dispatchEvent(new CustomEvent("conchterm.usage-changed"));
      finish(text);
    } else if (event.type === "error") {
      finish(null);
    }
  }).catch(() => finish(null));
}

/**
 * 回合结束后的提取入口。所有守卫不过就静默返回；
 * 提取到新记忆后广播 memories-changed 供面板/设置页刷新。
 */
export function maybeExtractMemories(
  provider: AgentProvider | null,
  entries: AgentEntry[],
  sessionId: string | null,
  enabled: boolean
): void {
  if (!enabled || !provider || extracting) return;
  // 只看本回合的消息条目；错误回复/空回复不提取
  const messages = entries.filter(
    (e): e is Extract<AgentEntry, { kind: "message" }> => e.kind === "message"
  );
  const tail = messages.slice(-MAX_EXTRACT_MESSAGES);
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant || lastAssistant.error || !lastAssistant.content.trim())
    return;

  const transcript = tail
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content}`)
    .join("\n\n");
  if (!transcript.trim()) return;

  extracting = true;
  void (async () => {
    let known: MemoryItem[] = [];
    try {
      known = await dbListMemories();
    } catch {
      // 读不到现有记忆就去重上下文，提取照常
    }
    const knownList = known
      .filter((m) => m.enabled)
      .map((m) => `- ${m.content}`)
      .join("\n");
    const userPayload =
      (knownList
        ? `已有记忆（不要重复提取，如有更新可改写为新的表述）：\n${knownList}\n\n`
        : "") + `本次对话：\n${transcript}`;
    collectStream(
      provider,
      [
        { role: "system", content: EXTRACT_SYSTEM_PROMPT },
        { role: "user", content: userPayload },
      ],
      (text) => {
        extracting = false;
        if (!text) return;
        const items = parseMemories(text);
        if (items.length === 0) return;
        void (async () => {
          for (const content of items) {
            try {
              await dbAddMemory(content, "auto", sessionId);
            } catch {
              return; // 入库失败就放弃剩余，静默
            }
          }
          window.dispatchEvent(new CustomEvent("conchterm.memories-changed"));
        })();
      }
    );
  })();
}
