import { useState } from "react";
import { X } from "lucide-react";
import type { AgentProtocol, AgentProvider } from "./types";

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
  const [model, setModel] = useState(initial?.model ?? "");
  const [apiKey, setApiKey] = useState("");

  // 切换协议时若地址还是另一个协议的默认值，自动跟随
  const changeProtocol = (next: AgentProtocol) => {
    if (baseUrl === PROTOCOL_META[protocol].baseUrl) {
      setBaseUrl(PROTOCOL_META[next].baseUrl);
    }
    setProtocol(next);
  };

  const valid =
    name.trim() &&
    baseUrl.trim() &&
    model.trim() &&
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
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={PROTOCOL_META[protocol].baseUrlPlaceholder}
          />
        </label>
        <label>
          模型
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={PROTOCOL_META[protocol].modelPlaceholder}
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
                  model: model.trim(),
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
