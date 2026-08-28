import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileText,
  Folder,
  FolderPlus,
  Copy,
  Download,
  FolderOpen,
  FolderUp,
  Pencil,
  RefreshCw,
  Upload,
  Trash2,
} from "lucide-react";
import {
  confirm as confirmDialog,
  open as openFileDialog,
  save as saveFileDialog,
} from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  sftpList,
  sftpMkdir,
  sftpRemove,
  sftpRename,
  sftpUpload,
  sftpDownload,
  sftpExists,
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

function permissionText(mode: number): string {
  if (!mode) return "-";
  const typeMask = mode & 0o170000;
  const type = typeMask === 0o120000 ? "l" : typeMask === 0o40000 ? "d" : "-";
  const bit = (m: number, c: string) => (mode & m ? c : "-");
  return (
    type +
    bit(0o400, "r") + bit(0o200, "w") + bit(0o100, "x") +
    bit(0o40, "r") + bit(0o20, "w") + bit(0o10, "x") +
    bit(0o4, "r") + bit(0o2, "w") + bit(0o1, "x")
  );
}

const isSymlink = (mode: number) =>
  mode !== 0 && (mode & 0o170000) === 0o120000;

/** 估算显示宽度：中文等全角字符按 2 个字符宽度计 */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return w;
}

/** 远端文件浏览器（连接成功后可用），路径面包屑 + 列表视图 */
export default function FileBrowser({ sessionId }: Props) {
  const [path, setPath] = useState("/root");
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState(path);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: RemoteFile;
  } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renamingRef = useRef<string | null>(null);
  const lastClickRef = useRef<{ name: string; time: number } | null>(null);
  const renameTimerRef = useRef<number | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const uploadHandlerRef = useRef<(paths: string[]) => void>(() => {});

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

  /**
   * 资源管理器式交互：
   * 第一次单击选中该行；已选中后再单击（间隔较长）进入重命名；
   * 连续快速的双击（原生 dblclick）进入目录。
   */
  const cancelPendingRename = () => {
    if (renameTimerRef.current) {
      window.clearTimeout(renameTimerRef.current);
      renameTimerRef.current = null;
    }
  };

  const handleNameClick = (f: RemoteFile) => {
    const now = Date.now();
    const last = lastClickRef.current;
    const gapOk = last && last.name === f.name && now - last.time >= 600;
    lastClickRef.current = { name: f.name, time: now };
    if (selectedName !== f.name) {
      cancelPendingRename();
      setSelectedName(f.name);
      return;
    }
    if (!gapOk) return;
    // 已选中的行再次单击：延迟 300ms 生效；
    // 若期间原生 dblclick 到来（快速双击），则取消重命名、进入目录
    cancelPendingRename();
    renameTimerRef.current = window.setTimeout(() => {
      renameTimerRef.current = null;
      startRename(f.name);
    }, 300);
  };

  const handleRowDoubleClick = (f: RemoteFile) => {
    cancelPendingRename();
    if (f.isDir) enter(f);
  };

  const handleParentClick = () => {
    cancelPendingRename();
    setSelectedName("..");
  };

  const fullPath = (name: string) => (path === "/" ? `/${name}` : `${path}/${name}`);

  const startRename = (name: string) => {
    renamingRef.current = name;
    setRenameDraft(name);
    setRenaming(name);
  };

  const commitRename = async (original: string) => {
    if (renamingRef.current !== original) return;
    renamingRef.current = null;
    setRenaming(null);
    const nn = renameDraft.trim();
    if (nn && nn !== original) {
      try {
        await sftpRename(sessionId, fullPath(original), fullPath(nn));
        refresh(path);
      } catch (e) {
        setError(String(e));
      }
    }
  };

  const cancelRename = () => {
    renamingRef.current = null;
    setRenaming(null);
  };

  const removeFile = async (f: RemoteFile) => {
    if (confirm(`确定删除 ${f.name} 吗？`)) {
      await sftpRemove(sessionId, fullPath(f.name), f.isDir);
      refresh(path);
    }
  };

  const copyPath = async (f: RemoteFile) => {
    try {
      await navigator.clipboard.writeText(fullPath(f.name));
    } catch {
      // 剪贴板不可用时忽略
    }
  };

  const uploadPaths = async (paths: string[]) => {
    // 忽略拖出功能产生的临时文件（把刚拖出去的文件又拖回来会命中这里），
    // 否则会把 时间戳-文件名 的临时目录上传到服务器造成垃圾文件
    const isDragTemp = (p: string) =>
      p.replace(/\\/g, "/").includes("/conchterm-drag/");
    const filtered = paths.filter((p) => !isDragTemp(p));
    if (filtered.length === 0) return;
    // 同名冲突检查：存在同名时询问覆盖或跳过（仅检查顶层名称）
    const targets: { local: string; remote: string; name: string }[] = [];
    const conflicts: string[] = [];
    for (const p of filtered) {
      const name = p.split(/[\\/]/).pop() ?? "file";
      const remote = path === "/" ? `/${name}` : `${path}/${name}`;
      targets.push({ local: p, remote, name });
      try {
        if (await sftpExists(sessionId, remote)) conflicts.push(name);
      } catch (e) {
        setError(`检查 ${name} 是否存在失败: ${e}`);
        return;
      }
    }
    if (conflicts.length) {
      const overwrite = await confirmDialog(
        conflicts.length === 1
          ? `「${conflicts[0]}」已存在，是否覆盖？`
          : `发现 ${conflicts.length} 个同名文件/文件夹，是否全部覆盖？`,
        {
          title: "覆盖确认",
          kind: "warning",
          okLabel: "覆盖",
          cancelLabel: conflicts.length === 1 ? "取消" : "跳过",
        }
      );
      if (!overwrite) {
        if (conflicts.length >= targets.length) return;
        const conflictSet = new Set(conflicts);
        await uploadTargets(targets.filter((t) => !conflictSet.has(t.name)));
        return;
      }
    }
    await uploadTargets(targets);
  };

  const uploadTargets = async (
    targets: { local: string; remote: string; name: string }[]
  ) => {
    setUploading(true);
    try {
      const errors: string[] = [];
      for (const t of targets) {
        try {
          await sftpUpload(sessionId, t.local, t.remote);
        } catch (e) {
          errors.push(`${t.name}: ${e}`);
        }
      }
      if (errors.length) setError(errors.join("；"));
      refresh(path);
    } finally {
      setUploading(false);
    }
  };

  // 拖放订阅的回调通过 ref 取最新闭包，避免 path/sessionId 过期
  uploadHandlerRef.current = (paths: string[]) => {
    void uploadPaths(paths);
  };

  useEffect(() => {
    if (!sessionId) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "leave") {
          setDragOver(false);
          return;
        }
        const rect = panelRef.current?.getBoundingClientRect();
        if (!rect) return;
        const dpr = window.devicePixelRatio || 1;
        const pos = event.payload.position;
        const inside =
          pos.x / dpr >= rect.left &&
          pos.x / dpr <= rect.right &&
          pos.y / dpr >= rect.top &&
          pos.y / dpr <= rect.bottom;
        if (event.payload.type === "drop") {
          setDragOver(false);
          if (inside && event.payload.paths.length) {
            uploadHandlerRef.current(event.payload.paths);
          }
        } else {
          setDragOver(inside);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const uploadFiles = async () => {
    const selected = await openFileDialog({
      multiple: true,
      title: "选择要上传的文件",
    });
    if (!selected) return;
    await uploadPaths(Array.isArray(selected) ? selected : [selected]);
  };

  const uploadFolder = async () => {
    const selected = await openFileDialog({
      directory: true,
      title: "选择要上传的文件夹",
    });
    if (!selected) return;
    await uploadPaths(Array.isArray(selected) ? selected : [selected]);
  };

  const downloadFile = async (f: RemoteFile) => {
    const target = await saveFileDialog({
      defaultPath: f.name,
      title: "保存下载文件",
    });
    if (!target) return;
    try {
      await sftpDownload(sessionId, fullPath(f.name), target);
    } catch (e) {
      setError(String(e));
    }
  };

  const closeContextMenu = () => setContextMenu(null);

  useEffect(() => {
    if (!contextMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeContextMenu();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextMenu]);

  const crumbs = path.split("/").filter(Boolean);
  const parentPath =
    path === "/" ? null : path.replace(/\/[^/]*$/, "") || "/";

  const normalizePath = (p: string) => {
    const trimmed = p.trim();
    if (!trimmed) return path;
    const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : "/";
  };

  const startPathEdit = () => {
    setPathDraft(path);
    setEditingPath(true);
  };

  const commitPathEdit = () => {
    setEditingPath(false);
    refresh(normalizePath(pathDraft));
  };

  return (
    <div className="file-browser" ref={panelRef}>
      <div className="breadcrumb">
        {editingPath ? (
          <input
            className="path-input"
            autoFocus
            value={pathDraft}
            title="输入路径后按回车跳转，Esc 取消"
            onChange={(e) => setPathDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitPathEdit();
              } else if (e.key === "Escape") {
                setEditingPath(false);
              }
            }}
            onBlur={() => setEditingPath(false)}
          />
        ) : (
          <div className="crumbs" title="双击可直接输入路径" onDoubleClick={startPathEdit}>
            <span className="crumb" onClick={() => refresh("/")}>
              /
            </span>
            {crumbs.map((c, i) => (
              <span key={i} className="crumb" onClick={() => refresh("/" + crumbs.slice(0, i + 1).join("/"))}>
                {c}/
              </span>
            ))}
          </div>
        )}
        <span className="flex-spacer" />
        <button className="ghost-btn" title="刷新" onClick={() => refresh(path)}>
          <RefreshCw size={13} strokeWidth={1.8} />
        </button>
        <button
          className="ghost-btn"
          title="新建目录"
          onClick={async () => {
            const name = prompt("新目录名：");
            if (name) {
              await sftpMkdir(sessionId, path === "/" ? `/${name}` : `${path}/${name}`);
              refresh(path);
            }
          }}
        >
          <FolderPlus size={13} strokeWidth={1.8} />
        </button>
        <button
          className="ghost-btn"
          title={uploading ? "上传中…" : "上传文件到当前目录"}
          disabled={uploading}
          onClick={uploadFiles}
        >
          <Upload size={13} strokeWidth={1.8} />
        </button>
        <button
          className="ghost-btn"
          title={uploading ? "上传中…" : "上传文件夹（含内部结构）"}
          disabled={uploading}
          onClick={uploadFolder}
        >
          <FolderUp size={13} strokeWidth={1.8} />
        </button>
      </div>
      {uploading && <div className="upload-hint">正在上传文件…</div>}
      {error && <div className="empty-hint error">{error}</div>}
      {loading ? (
        <div className="empty-hint">加载中…</div>
      ) : (
        <div className="file-table-wrap">
          <table className="file-table">
            <thead>
              <tr>
                <th>名称</th>
                <th style={{ width: 70 }}>大小</th>
                <th style={{ width: 120 }}>修改时间</th>
                <th style={{ width: 64 }}>所有者</th>
                <th style={{ width: 64 }}>组</th>
                <th style={{ width: 100 }}>权限</th>
              </tr>
            </thead>
            <tbody>
              {parentPath && (
                <tr
                  title="双击返回上一级目录"
                  className={selectedName === ".." ? "selected" : ""}
                  onClick={handleParentClick}
                  onDoubleClick={() => {
                    cancelPendingRename();
                    refresh(parentPath);
                  }}
                >
                  <td className="dir">
                    <span className="file-icon">
                      <Folder size={14} strokeWidth={1.8} />
                    </span>
                    ..
                  </td>
                  <td>-</td>
                  <td>-</td>
                  <td>-</td>
                  <td>-</td>
                  <td>-</td>
                </tr>
              )}
              {files.map((f) => (
                <tr
                  key={f.name}
                  className={selectedName === f.name ? "selected" : ""}
                  onDoubleClick={() => handleRowDoubleClick(f)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, file: f });
                  }}
                >
                  <td
                    className={
                      [f.isDir ? "dir" : "", isSymlink(f.mode) ? "link" : ""]
                        .filter(Boolean)
                        .join(" ")
                    }
                    onClick={() => handleNameClick(f)}
                  >
                    <span className="file-icon">
                      {f.isDir ? (
                        <Folder size={14} strokeWidth={1.8} />
                      ) : (
                        <FileText size={14} strokeWidth={1.8} />
                      )}
                    </span>
                    {renaming === f.name ? (
                      <input
                        className="rename-input"
                        autoFocus
                        value={renameDraft}
                        placeholder={f.name}
                        style={{
                          width: `${Math.min(
                            Math.max(textWidth(renameDraft) + 2, 10),
                            40
                          )}ch`,
                        }}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onFocus={(e) => e.target.select()}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                        onContextMenu={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            commitRename(f.name);
                          } else if (e.key === "Escape") {
                            cancelRename();
                          }
                        }}
                        onBlur={() => commitRename(f.name)}
                      />
                    ) : (
                      f.name
                    )}
                  </td>
                  <td>{f.isDir ? "-" : formatSize(f.size)}</td>
                  <td>{formatDate(f.modifiedMs)}</td>
                  <td>{f.owner}</td>
                  <td>{f.group}</td>
                  <td className="perm">{permissionText(f.mode)}</td>
                </tr>
              ))}
              {files.length === 0 && !loading && (
                <tr>
                  <td colSpan={6} className="empty-hint">
                    空目录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {dragOver && (
        <div className="drop-overlay">
          <Upload size={28} strokeWidth={1.5} />
          <p>松开上传到当前目录</p>
        </div>
      )}
      {contextMenu && (
        <>
          <div
            className="ctx-backdrop"
            onClick={closeContextMenu}
            onContextMenu={(e) => {
              e.preventDefault();
              closeContextMenu();
            }}
          />
          <div
            className="ctx-menu"
            style={{
              left: Math.min(contextMenu.x, window.innerWidth - 170),
              top: Math.min(contextMenu.y, window.innerHeight - 160),
            }}
          >
            {contextMenu.file.isDir && (
              <button
                className="ctx-item"
                onClick={() => {
                  const f = contextMenu.file;
                  closeContextMenu();
                  enter(f);
                }}
              >
                <FolderOpen size={14} strokeWidth={1.8} />
                打开
              </button>
            )}
            {!contextMenu.file.isDir && (
              <button
                className="ctx-item"
                onClick={() => {
                  const f = contextMenu.file;
                  closeContextMenu();
                  downloadFile(f);
                }}
              >
                <Download size={14} strokeWidth={1.8} />
                下载
              </button>
            )}
            <button
              className="ctx-item"
              onClick={() => {
                const f = contextMenu.file;
                closeContextMenu();
                startRename(f.name);
              }}
            >
              <Pencil size={14} strokeWidth={1.8} />
              重命名
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                const f = contextMenu.file;
                closeContextMenu();
                copyPath(f);
              }}
            >
              <Copy size={14} strokeWidth={1.8} />
              复制路径
            </button>
            <button
              className="ctx-item danger"
              onClick={() => {
                const f = contextMenu.file;
                closeContextMenu();
                removeFile(f);
              }}
            >
              <Trash2 size={14} strokeWidth={1.8} />
              删除
            </button>
          </div>
        </>
      )}
    </div>
  );
}
