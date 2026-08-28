import { useState } from "react";
import { X } from "lucide-react";
import type { ServerProfile } from "../storage";

interface Props {
  initial?: ServerProfile | null;
  onSave: (profile: ServerProfile) => void;
  onCancel: () => void;
}

/** 新建/编辑服务器连接的表单弹窗 */
export default function ServerForm({ initial, onSave, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(String(initial?.port ?? 22));
  const [username, setUsername] = useState(initial?.username ?? "root");
  const [authType, setAuthType] = useState<"password" | "key">(
    initial?.authType ?? "password"
  );
  const [password, setPassword] = useState(initial?.password ?? "");
  const [privateKey, setPrivateKey] = useState(initial?.privateKey ?? "");
  const [passphrase, setPassphrase] = useState(initial?.passphrase ?? "");

  const valid = name.trim() && host.trim() && username.trim();

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          <h3>{initial ? "编辑服务器" : "新建服务器"}</h3>
          <button className="icon-btn" title="关闭" onClick={onCancel}>
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>
        <label>
          名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：生产环境-Web01"
          />
        </label>
        <div className="form-row">
          <label className="grow">
            主机
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="IP 或域名"
            />
          </label>
          <label style={{ width: 90 }}>
            端口
            <input value={port} onChange={(e) => setPort(e.target.value)} />
          </label>
        </div>
        <label>
          用户名
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          认证方式
          <select
            value={authType}
            onChange={(e) => setAuthType(e.target.value as "password" | "key")}
          >
            <option value="password">密码</option>
            <option value="key">私钥</option>
          </select>
        </label>
        {authType === "password" ? (
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        ) : (
          <>
            <label>
              私钥（PEM）
              <textarea
                rows={5}
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              />
            </label>
            <label>
              私钥口令（可选）
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </label>
          </>
        )}
        <div className="modal-actions">
          <button onClick={onCancel}>取消</button>
          <button
            className="primary"
            disabled={!valid}
            onClick={() =>
              onSave({
                id: initial?.id ?? crypto.randomUUID(),
                name: name.trim(),
                host: host.trim(),
                port: parseInt(port, 10) || 22,
                username: username.trim(),
                authType,
                password: authType === "password" ? password : undefined,
                privateKey: authType === "key" ? privateKey : undefined,
                passphrase: authType === "key" ? passphrase || undefined : undefined,
                createdAt: initial?.createdAt ?? Date.now(),
              })
            }
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
