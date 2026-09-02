import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";

export type DialogKind = "info" | "success" | "warning" | "error";

interface DialogOptions {
  /** 弹窗标题 */
  title?: string;
  /** 图标类型：默认 info；alert 未指定时错误样式自动识别（见 DialogHost） */
  kind?: DialogKind;
  /** 确认按钮文字，默认「确定」 */
  okLabel?: string;
  /** 取消按钮文字；alert 默认没有取消按钮，传值则显示 */
  cancelLabel?: string;
}

interface ConfirmOptions extends DialogOptions {
  /** 危险操作确认：确认按钮显示为红色 */
  danger?: boolean;
}

interface PromptOptions extends DialogOptions {
  defaultValue?: string;
  placeholder?: string;
}

interface DialogResult {
  /** confirm 是否点了确认；alert 关闭恒为 true */
  ok: boolean;
  /** prompt 的输入值；取消时为 null */
  value: string | null;
}

interface DialogApi {
  alert: (message: string, options?: DialogOptions) => Promise<DialogResult>;
  confirm: (message: string, options?: ConfirmOptions) => Promise<DialogResult>;
  prompt: (message: string, options?: PromptOptions) => Promise<DialogResult>;
}

const DialogContext = createContext<DialogApi | null>(null);

/** 获取全局弹窗 API；必须在 <DialogProvider> 内使用 */
export function useDialogs(): DialogApi {
  const api = useContext(DialogContext);
  if (!api) throw new Error("useDialogs 必须在 DialogProvider 内使用");
  return api;
}

interface PendingDialog {
  variant: "alert" | "confirm" | "prompt";
  message: string;
  title?: string;
  kind?: DialogKind;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  defaultValue?: string;
  placeholder?: string;
  resolve: (r: DialogResult) => void;
}

/** 应用内统一弹窗：与主界面深/亮色主题一致，替代原生 alert/confirm/prompt */
export function DialogProvider({ children }: { children: ReactNode }) {
  // 队列结构支持连续弹窗依次展示，不互相覆盖
  const [queue, setQueue] = useState<PendingDialog[]>([]);
  const current = queue[0] ?? null;

  const push = useCallback(
    (
      variant: PendingDialog["variant"],
      message: string,
      options?: Omit<PendingDialog, "variant" | "message" | "resolve">
    ) =>
      new Promise<DialogResult>((resolve) => {
        setQueue((prev) => [...prev, { variant, message, resolve, ...options }]);
      }),
    []
  );

  const apiRef = useRef<DialogApi>({
    alert: (message, options) => push("alert", message, options),
    confirm: (message, options) => push("confirm", message, options),
    prompt: (message, options) => push("prompt", message, options),
  });

  const settle = useCallback((result: DialogResult) => {
    setQueue((prev) => {
      const [head, ...rest] = prev;
      head?.resolve(result);
      return rest;
    });
  }, []);

  return (
    <DialogContext.Provider value={apiRef.current}>
      {children}
      {current && (
        <DialogHost
          key={queue.length}
          dialog={current}
          onSettle={settle}
        />
      )}
    </DialogContext.Provider>
  );
}

const KIND_ICON = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
} as const;

function DialogHost({
  dialog,
  onSettle,
}: {
  dialog: PendingDialog;
  onSettle: (r: DialogResult) => void;
}) {
  const [value, setValue] = useState(dialog.defaultValue ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const variant = dialog.variant;
  const isAlert = variant === "alert";
  // alert 未显式指定类型时，标题含「失败/错误」按错误样式，否则 info
  const kind: DialogKind =
    dialog.kind ??
    (isAlert && /失败|错误/.test(dialog.message) ? "error" : "info");
  const Icon = KIND_ICON[kind];
  const showCancel = variant !== "alert" || !!dialog.cancelLabel;
  const okText = dialog.okLabel ?? "确定";
  const defaultTitle = { alert: "提示", confirm: "确认", prompt: "输入" }[variant];

  // alert 的任意方式关闭都视为 ok；confirm/prompt 的取消路径 ok=false
  const dismiss = () => onSettle({ ok: isAlert, value: null });
  const accept = () =>
    onSettle({
      ok: true,
      value: variant === "prompt" ? value : null,
    });

  // Esc 取消；Enter 确认（prompt 由输入框自己处理）。capture 确保先于页面其它快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        dismiss();
      } else if (e.key === "Enter" && variant !== "prompt") {
        e.preventDefault();
        accept();
      }
    };
    window.addEventListener("keydown", onKey, true);
    inputRef.current?.select();
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-backdrop" onClick={dismiss}>
      <div
        className={`modal dialog-modal${dialog.danger ? " danger-modal" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-title">
          <h3>{dialog.title ?? defaultTitle}</h3>
          <button className="icon-btn" title="关闭" onClick={dismiss}>
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>
        <div className={`dialog-body ${kind}`}>
          <span className="dialog-icon">
            <Icon size={20} strokeWidth={1.8} />
          </span>
          <div className="dialog-text">{dialog.message}</div>
        </div>
        {variant === "prompt" && (
          <input
            ref={inputRef}
            className="dialog-input"
            value={value}
            placeholder={dialog.placeholder}
            autoFocus
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                accept();
              }
            }}
          />
        )}
        <div className="modal-actions">
          {showCancel && (
            <button onClick={dismiss}>{dialog.cancelLabel ?? "取消"}</button>
          )}
          <button
            className={`primary${dialog.danger && !isAlert ? " danger" : ""}`}
            onClick={accept}
          >
            {okText}
          </button>
        </div>
      </div>
    </div>
  );
}
