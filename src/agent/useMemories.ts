// 长期记忆的 React hook：加载 / 增删改清 + 跨组件同步（CustomEvent 模式）

import { useCallback, useEffect, useRef, useState } from "react";
import {
  dbAddMemory,
  dbClearMemories,
  dbDeleteMemory,
  dbListMemories,
  dbUpdateMemory,
  type MemoryItem,
} from "./db";

const CHANGED_EVENT = "conchterm.memories-changed";

export function useMemories(): {
  memories: MemoryItem[];
  loading: boolean;
  reload: () => void;
  add: (content: string) => Promise<void>;
  update: (
    id: number,
    patch: { content?: string; pinned?: boolean; enabled?: boolean }
  ) => Promise<void>;
  remove: (id: number) => Promise<void>;
  clear: () => Promise<void>;
} {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const aliveRef = useRef(true);

  const reload = useCallback(() => {
    setLoading(true);
    dbListMemories()
      .then((list) => {
        if (aliveRef.current) setMemories(list);
      })
      .catch(() => {
        if (aliveRef.current) setMemories([]);
      })
      .finally(() => {
        if (aliveRef.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    reload();
    const onChanged = () => reload();
    window.addEventListener(CHANGED_EVENT, onChanged);
    return () => {
      aliveRef.current = false;
      window.removeEventListener(CHANGED_EVENT, onChanged);
    };
  }, [reload]);

  const add = useCallback(async (content: string) => {
    await dbAddMemory(content, "manual", null);
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
  }, []);

  const update = useCallback(
    async (
      id: number,
      patch: { content?: string; pinned?: boolean; enabled?: boolean }
    ) => {
      await dbUpdateMemory(id, patch);
      window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
    },
    []
  );

  const remove = useCallback(async (id: number) => {
    await dbDeleteMemory(id);
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
  }, []);

  const clear = useCallback(async () => {
    await dbClearMemories();
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
  }, []);

  return { memories, loading, reload, add, update, remove, clear };
}
