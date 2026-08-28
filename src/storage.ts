// 服务器连接配置的本地持久化（应用数据目录下的 servers.json）

export interface ServerProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  password?: string;
  privateKey?: string;
  passphrase?: string;
  createdAt: number;
}

const STORAGE_KEY = "conchterm.servers";
const LEGACY_STORAGE_KEY = "shelltool.servers";

// MVP 用 localStorage；TODO: 迁移到 Rust 端 + OS 凭据管理器加密存储
export function loadServers(): ServerProfile[] {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ServerProfile[]) : [];
  } catch {
    return [];
  }
}

export function saveServers(servers: ServerProfile[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(servers, null, 2));
}

export function newId(): string {
  return crypto.randomUUID();
}
