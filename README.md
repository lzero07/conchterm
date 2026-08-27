# ShellTool

一个使用 Tauri 2 + Rust + React + TypeScript 开发的桌面 SSH 客户端，
目标对标 XShell / MobaXterm / FinalShell。

## 当前功能（MVP）

- ✅ SSH 终端：密码 / 私钥认证，xterm.js 渲染（256 色）
- ✅ 多标签页终端，同一服务器复用 TCP 连接
- ✅ 服务器管理：新增/编辑/删除连接配置（localStorage 持久化）
- ✅ 远端文件浏览器：SFTP 目录列表、新建目录、重命名、删除
- ✅ 左侧边栏「服务器 / 文件」双视图切换

## 技术架构

```
┌─────────────── 前端 (WebView) ───────────────┐
│  App.tsx        布局与标签页状态               │
│  TerminalView   xterm.js ↔ ipc::Channel 字节流 │
│  FileBrowser    SFTP 文件面板                  │
│  ServerForm     连接配置表单                    │
└──────────────┬───────────────┬───────────────┘
        invoke / Channel    invoke (JSON)
┌──────────────▼───────────────▼───────────────┐
│  ssh.rs  (Rust)                               │
│  ├─ russh          SSH 协议、认证、PTY、数据流    │
│  ├─ russh-sftp     SFTP 子系统                 │
│  └─ SessionMap     全局会话表 (Tauri State)     │
└───────────────────────────────────────────────┘
```

**关键设计**：
- 终端输出走 `tauri::ipc::Channel<Vec<u8>>` 二进制流（不走 JSON 序列化，大输出不卡顿）
- 键盘输入 `invoke("ssh_write")` 直传字节；resize 防抖后同步远端 PTY 尺寸
- 会话表为 `State<SessionMap>`，断开 Tab 时主动 `disconnect`

## 开发

```bash
npm install            # 安装前端依赖
npm run tauri dev      # 启动开发模式（热更新）
npm run tauri build    # 打包安装程序 (msi/nsis)
```

前置要求：
- Rust (stable, MSVC toolchain on Windows)
- Node.js 18+
- Visual Studio Build Tools (C++ workload) —— Windows

## 路线图

- [ ] SFTP 上传/下载（进度条、断点续传）
- [ ] known_hosts 主机密钥校验 + 首次连接指纹确认弹窗
- [ ] 密码迁移到 OS 凭据管理器（Windows Credential Manager）加密存储
- [ ] 连接监控面板（CPU/内存/网络图表，FinalShell 风格）
- [ ] 快捷命令片段
- [ ] 终端主题 / 字体设置
- [ ] 跳板机（ProxyJump）、端口转发
