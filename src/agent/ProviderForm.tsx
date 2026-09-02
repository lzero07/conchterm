import { useState } from "react";
import { LoaderCircle, PlugZap, X } from "lucide-react";
import { agentListModels } from "./api";
import type { AgentEvent, AgentProtocol, AgentProvider } from "./types";

interface Props {
  initial?: AgentProvider | null;
  onSave: (provider: AgentProvider, apiKey: string) => void;
  onCancel: () => void;
}

const PROTOCOL_META: Record<
  AgentProtocol,
  { baseUrl: string; baseUrlPlaceholder: string; modelPlaceholder: string }
> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    baseUrlPlaceholder:
      "https://api.openai.com/v1（DeepSeek/Ollama 等填对应地址）",
    modelPlaceholder: "如 gpt-4o-mini / deepseek-chat",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    baseUrlPlaceholder: "https://api.anthropic.com",
    modelPlaceholder: "如 claude-sonnet-4-5",
  },
};

/** 新建/编辑 AI Provider 的表单弹窗 */
export default function ProviderForm({ initial, onSave, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [protocol, setProtocol] = useState<AgentProtocol>(
    initial?.protocol ?? "openai"
  );
  const [baseUrl, setBaseUrl] = useState(
    initial?.baseUrl ?? PROTOCOL_META.openai.baseUrl
  );
  const [defaultModel, setDefaultModel] = useState(
    initial?.defaultModel ?? ""
  );
  const [modelsText, setModelsText] = useState(
    initial?.models.join("\n") ?? ""
  );
  const [apiKey, setApiKey] = useState("");
  const [probing, setProbing] = useState(false);
  /** 检测结果行：输入框下方的内联状态文字（成功绿/失败红） */
  const [probeStatus, setProbeStatus] = useState<{
    kind: "success" | "warning" | "error";
    text: string;
  } | null>(null);

  // 切换协议时若地址还是另一个协议的默认值，自动跟随
  const changeProtocol = (next: AgentProtocol) => {
    if (baseUrl === PROTOCOL_META[protocol].baseUrl) {
      setBaseUrl(PROTOCOL_META[next].baseUrl);
    }
    setProtocol(next);
  };

  /** 检测：按当前表单的协议/地址（和输入中的 Key）拉取模型列表并回填 */
  const probeModels = () => {
    const url = baseUrl.trim().replace(/\/+$/, "");
    if (!url || probing) return;
    setProbing(true);
    setProbeStatus(null);
    agentListModels(
      {
        id: initial?.id ?? "probe",
        name: name.trim() || "probe",
        protocol,
        baseUrl: url,
        defaultModel: defaultModel.trim(),
        models: [],
        activeModel: "",
        hasKey: false,
        createdAt: 0,
      },
      (event: AgentEvent) => {
        if (event.type === "models") {
          const fetched = event.models ?? [];
          setProbing(false);
          if (fetched.length === 0) {
            setProbeStatus({
              kind: "warning",
              text: "服务可达，但未返回任何模型，请确认模型服务已部署",
            });
            return;
          }
          // 与已有列表去重合并后回填
          const existing = modelsText
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean);
          const existingSet = new Set(existing);
          const fresh = fetched.filter((m) => !existingSet.has(m));
          setModelsText(Array.from(new Set([...existing, ...fetched])).join("\n"));
          let filledDefault = false;
          if (!defaultModel.trim()) {
            setDefaultModel(fetched[0]);
            filledDefault = true;
          }
          setProbeStatus({
            kind: "success",
            text:
              fresh.length > 0
                ? `检测成功，新增 ${fresh.length} 个模型并已回填${filledDefault ? "，已自动填充默认模型" : ""}`
                : `检测成功，服务返回 ${fetched.length} 个模型，均已存在列表中${filledDefault ? "，已自动填充默认模型" : ""}`,
          });
        } else if (event.type === "error") {
          setProbing(false);
          setProbeStatus({
            kind: "error",
            text: `检测失败：${event.message ?? "未知错误"}`,
          });
        }
      },
      apiKey.trim() || undefined
    ).catch((err) => {
      setProbing(false);
      setProbeStatus({ kind: "error", text: `检测失败：${String(err)}` });
    });
  };

  // 模型列表选填：留空时以默认模型建列表，也可稍后在对话框中在线获取
  const valid =
    name.trim() &&
    baseUrl.trim() &&
    defaultModel.trim() &&
    (initial?.hasKey || apiKey.trim());

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          <h3>{initial ? "编辑 AI Provider" : "添加 AI Provider"}</h3>
          <button className="icon-btn" title="关闭" onClick={onCancel}>
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>
        <label>
          名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：DeepSeek / Claude"
          />
        </label>
        <label>
          协议
          <select
            value={protocol}
            onChange={(e) => changeProtocol(e.target.value as AgentProtocol)}
          >
            <option value="openai">OpenAI 兼容（OpenAI/DeepSeek/Ollama…）</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>
        <label>
          API 地址
          <span className="probe-row">
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={PROTOCOL_META[protocol].baseUrlPlaceholder}
            />
            <button
              type="button"
              className="probe-btn"
              title="检测：连接该地址拉取可用模型列表并回填"
              disabled={probing || !baseUrl.trim()}
              onClick={probeModels}
            >
              {probing ? (
                <>
                  <LoaderCircle size={12} strokeWidth={2} className="spin" />
                  检测中
                </>
              ) : (
                <>
                  <PlugZap size={12} strokeWidth={2} />
                  检测
                </>
              )}
            </button>
          </span>
          {probeStatus && (
            <span className={`probe-status ${probeStatus.kind}`}>
              {probeStatus.text}
            </span>
          )}
        </label>
        <label>
          默认模型
          <input
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            placeholder={PROTOCOL_META[protocol].modelPlaceholder}
          />
        </label>
        <label>
          模型列表（每行一个，可稍后在对话框中获取）
          <textarea
            rows={3}
            value={modelsText}
            onChange={(e) => setModelsText(e.target.value)}
            placeholder={"如：\ndeepseek-chat\ndeepseek-reasoner"}
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              initial?.hasKey ? "已保存到系统凭据管理器，留空不修改" : "sk-..."
            }
          />
        </label>
        <p className="form-hint">
          Key 存入系统凭据管理器，不落本地文件明文。
        </p>
        <div className="modal-actions">
          <button onClick={onCancel}>取消</button>
          <button
            className="primary"
            disabled={!valid}
            onClick={() =>
              onSave(
                {
                  id: initial?.id ?? crypto.randomUUID(),
                  name: name.trim(),
                  protocol,
                  baseUrl: baseUrl.trim().replace(/\/+$/, ""),
                  defaultModel: defaultModel.trim(),
                  models: (() => {
                    const list = modelsText
                      .split(/[\n,]/)
                      .map((s) => s.trim())
                      .filter(Boolean);
                    if (
                      defaultModel.trim() &&
                      !list.includes(defaultModel.trim())
                    ) {
                      list.unshift(defaultModel.trim());
                    }
                    return list;
                  })(),
                  activeModel: initial?.activeModel || defaultModel.trim(),
                  hasKey: initial?.hasKey ?? false,
                  createdAt: initial?.createdAt ?? Date.now(),
                },
                apiKey.trim()
              )
            }
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
