import { useEffect, useRef, useState } from "react";
import { Moon, Sun, SunMoon } from "lucide-react";

export type ToastKind = "info" | "success";

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
  /** 主题类提示的自定义图标节点 */
  icon?: React.ReactNode;
}

/** 自动消失时长：短促反馈，快速连续切换时立刻被新提示取代 */
const TOAST_DURATION = 1200;

/** 轻量全局提示：出现在标题栏下方居中，单条展示，新提示直接替换旧提示 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [item, setItem] = useState<ToastItem | null>(null);
  const nextId = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<Omit<ToastItem, "id">>).detail;
      window.clearTimeout(timerRef.current);
      // 换 id 让入场动画在连续切换时重新播放
      const id = nextId.current++;
      setItem({ id, ...detail });
      timerRef.current = window.setTimeout(
        () => setItem(null),
        TOAST_DURATION
      );
    };
    window.addEventListener("app-toast", handler);
    return () => {
      window.removeEventListener("app-toast", handler);
      window.clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <>
      {children}
      {item && (
        <div key={item.id} className={`toast toast-${item.kind}`}>
          {item.icon}
          <span>{item.message}</span>
        </div>
      )}
    </>
  );
}

/** 任意组件内可直接调用的全局提示（无需 hook / context） */
export function showToast(
  message: string,
  options?: { kind?: ToastKind; icon?: React.ReactNode }
): void {
  window.dispatchEvent(
    new CustomEvent("app-toast", {
      detail: { message, kind: options?.kind ?? "info", icon: options?.icon },
    })
  );
}

/** 主题切换提示的便捷封装：按模式显示对应图标与文案 */
export function showThemeToast(mode: "light" | "dark" | "system"): void {
  const iconProps = { size: 15, strokeWidth: 2 } as const;
  const map = {
    light: { icon: <Sun {...iconProps} />, text: "已切换到亮色主题" },
    dark: { icon: <Moon {...iconProps} />, text: "已切换到暗色主题" },
    system: { icon: <SunMoon {...iconProps} />, text: "已切换为跟随系统主题" },
  } as const;
  showToast(map[mode].text, { kind: "success", icon: map[mode].icon });
}
