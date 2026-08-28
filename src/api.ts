// SSH/SFTP 后端命令的 TS 类型与调用封装

export interface ConnectParams {
  id: string;
  host: string;
  port: number;
  username: string;
  password?: string | null;
  privateKey?: string | null;
  passphrase?: string | null;
}

export interface RemoteFile {
  name: string;
  isDir: boolean;
  size: number;
  modifiedMs: number;
  mode: number;
  owner: string;
  group: string;
}

import { invoke, Channel } from "@tauri-apps/api/core";

/** 建立 SSH 连接并启动 shell；onData 接收远端输出字节流 */
export async function sshConnect(
  params: ConnectParams,
  gen: number,
  onData: (data: Uint8Array) => void
): Promise<{ ok: boolean; message: string }> {
  const channel = new Channel<Array<number>>();
  channel.onmessage = (msg) => {
    onData(new Uint8Array(msg));
  };
  const result = await invoke<{ ok: boolean; message: string }>("ssh_connect", {
    params,
    gen,
    onOutput: channel,
  });
  return result;
}

export function sshWrite(sessionId: string, data: Uint8Array): void {
  invoke("ssh_write", { sessionId, data: Array.from(data) });
}

export function sshResize(sessionId: string, cols: number, rows: number): void {
  invoke("ssh_resize", { sessionId, cols, rows });
}

export function sshDisconnect(sessionId: string): Promise<void> {
  return invoke("ssh_disconnect", { sessionId });
}

export function sftpList(sessionId: string, path: string): Promise<RemoteFile[]> {
  return invoke("sftp_list", { sessionId, path });
}

export function sftpMkdir(sessionId: string, path: string): Promise<void> {
  return invoke("sftp_mkdir", { sessionId, path });
}

export function sftpRemove(
  sessionId: string,
  path: string,
  isDir: boolean
): Promise<void> {
  return invoke("sftp_remove", { sessionId, path, isDir });
}

export function sftpRename(
  sessionId: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  return invoke("sftp_rename", { sessionId, oldPath, newPath });
}
