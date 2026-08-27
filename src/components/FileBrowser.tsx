import { useCallback, useEffect, useState } from "react";
import {
  sftpList,
  sftpMkdir,
  sftpRemove,
  sftpRename,
  type RemoteFile,
} from "../api";

interface Props {
  sessionId: string | null;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatDate(ms: number): string {
  if (!ms) return "-";
  const d = new Date(ms * (ms < 1e12 ? 1 : 1));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/** 远端文件浏览器（连接成功后可用），路径面包屑 + 列表视图 */
export default function FileBrowser({ sessionId }: Props) {
  const [path, setPath] = useState("/root");
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(
    async (target: string) => {
      if (!sessionId) {
        setError("未连接到任何服务器");
        setFiles([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const list = await sftpList(sessionId, target);
        setFiles(list);
        setPath(target);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [sessionId]
  );

  // 会话切换时回到家目录重新加载
  useEffect(() => {
    if (sessionId) refresh("/root");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  if (!sessionId) {
    return (
      <div className="file-browser">
        <div className="empty-hint">连接服务器后可浏览远端文件</div>
      </div>
    );
  }

  const enter = (f: RemoteFile) => {
    if (f.isDir) {
      refresh(path === "/" ? `/${f.name}` : `${path}/${f.name}`);
    }
  };

  const crumbs = path.split("/").filter(Boolean);

  return (
    <div className="file-browser">
      <div className="breadcrumb">
        <span className="crumb" onClick={() => refresh("/")}>
          /
        </span>
        {crumbs.map((c, i) => (
          <span key={i} className="crumb" onClick={() => refresh("/" + crumbs.slice(0, i + 1).join("/"))}>
            {c}/
          </span>
        ))}
        <span className="flex-spacer" />
        <button title="刷新" onClick={() => refresh(path)}>
          ⟳
        </button>
        <button
          title="新建目录"
          onClick={async () => {
            const name = prompt("新目录名：");
            if (name) {
              await sftpMkdir(sessionId, path === "/" ? `/${name}` : `${path}/${name}`);
              refresh(path);
            }
          }}
        >
          ＋📁
        </button>
      </div>
      {error && <div className="empty-hint error">{error}</div>}
      {loading ? (
        <div className="empty-hint">加载中…</div>
      ) : (
        <table className="file-table">
          <thead>
            <tr>
              <th>名称</th>
              <th style={{ width: 90 }}>大小</th>
              <th style={{ width: 130 }}>修改时间</th>
              <th style={{ width: 100 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.name}>
                <td className={f.isDir ? "dir" : ""} onDoubleClick={() => enter(f)}>
                  {f.isDir ? "📁 " : "📄 "}
                  {f.name}
                </td>
                <td>{f.isDir ? "-" : formatSize(f.size)}</td>
                <td>{formatDate(f.modifiedMs)}</td>
                <td>
                  <button
                    className="link"
                    onClick={async () => {
                      const nn = prompt("重命名为：", f.name);
                      if (nn && nn !== f.name) {
                        await sftpRename(
                          sessionId,
                          path === "/" ? `/${f.name}` : `${path}/${f.name}`,
                          path === "/" ? `/${nn}` : `${path}/${nn}`
                        );
                        refresh(path);
                      }
                    }}
                  >
                    重命名
                  </button>
                  <button
                    className="link danger"
                    onClick={async () => {
                      if (confirm(`确定删除 ${f.name} 吗？`)) {
                        await sftpRemove(
                          sessionId,
                          path === "/" ? `/${f.name}` : `${path}/${f.name}`,
                          f.isDir
                        );
                        refresh(path);
                      }
                    }}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
            {files.length === 0 && !loading && (
              <tr>
                <td colSpan={4} className="empty-hint">
                  空目录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
