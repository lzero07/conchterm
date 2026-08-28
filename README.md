# ShellTool

简体中文 | [English](./README.en.md)

ShellTool 是一个使用 Tauri 2 + Rust + React + TypeScript 开发的跨平台桌面
SSH 客户端，目标对标 XShell / MobaXterm / FinalShell。前端负责界面与交互，
Rust 后端通过 russh 实现 SSH 与 SFTP 协议，二者通过 Tauri IPC 通信。

## 功能特性

- **SSH 终端**：支持密码与私钥（PEM）认证，xterm.js 渲染，支持 256 色
- **多标签页**：同时打开多个终端，同一服务器复用同一条 TCP 连接
- **服务器管理**：新增 / 编辑 / 删除连接配置，通过 localStorage 持久化
- **远程文件浏览器**：基于 SFTP 的目录浏览、新建目录、重命名、删除
- **双视图侧栏**：「服务器」与「文件」两个面板自由切换，支持拖拽调宽
- **中英文混排优化**：终端对 CJK 全角字符做显示宽度处理，表格不错位
- **长输出不卡顿**：终端输出走二进制字节流通道，不经过 JSON 序列化
- **连接保活**：SSH 层每 30 秒发送 keepalive，闲置连接不掉线

## 技术架构

```
┌───────────────── 前端 (WebView) ─────────────────┐
│  App.tsx        布局、侧栏与标签页状态              │
│  TerminalView   xterm.js ↔ ipc::Channel 字节流     │
│  FileBrowser    SFTP 文件面板                      │
│  ServerForm     连接配置表单                        │
│  storage.ts     服务器配置的 localStorage 持久化     │
└──────────────┬─────────────────┬─────────────────┘
       invoke / Channel      invoke (JSON)
┌──────────────▼─────────────────▼─────────────────┐
│  ssh.rs  (Rust 后端)                               │
│  ├─ russh          SSH 协议、认证、PTY、数据流       │
│  ├─ russh-sftp     SFTP 子系统（独立 TCP 连接）      │
│  └─ SessionMap     全局会话表 (Tauri State)         │
└───────────────────────────────────────────────────┘
```

**关键设计**：

- 终端输出通过 `tauri::ipc::Channel<Vec<u8>>` 以二进制推送给前端，
  xterm.js 直接写入 `Uint8Array`，大输出不卡顿
- 键盘输入由前端 `invoke("ssh_write")` 直传字节；窗口尺寸变化经防抖后
  同步远端 PTY 大小
- SFTP 使用独立 TCP 连接：部分服务器（`MaxSessions 1`）拒绝在同一连接上
  多开 session 通道
- 会话表为 `State<SessionMap>`，关闭终端标签页时主动断开远端会话

## 快速开始

**环境要求**

- Node.js 18+
- Rust stable（Windows 上需要 MSVC toolchain）
- Windows 需要 Visual Studio Build Tools（C++ 工作负载）

```bash
# 安装前端依赖
npm install

# 启动开发模式（热更新）
npm run tauri dev

# 类型检查 + 构建前端
npm run build

# Rust 编译检查（在 src-tauri/ 目录下）
cargo check

# 打包桌面安装程序（Windows 下生成 msi / nsis）
npm run tauri build
```

## 项目结构

```
shelltool/
├── src/                      # 前端源码 (React + TypeScript)
│   ├── App.tsx               # 应用布局与终端标签页状态
│   ├── api.ts                # Tauri invoke 命令封装与类型
│   ├── storage.ts            # 服务器配置的 localStorage 持久化
│   ├── main.tsx              # React 入口
│   └── components/
│       ├── TerminalView.tsx  # 单个 SSH 终端（xterm.js）
│       ├── ServerForm.tsx    # 新增 / 编辑服务器配置表单
│       └── FileBrowser.tsx   # SFTP 远程文件面板
├── src-tauri/                # Rust 后端
│   ├── src/
│   │   ├── ssh.rs            # SSH/SFTP 会话管理（连接、认证、PTY）
│   │   ├── lib.rs            # 应用入口与命令注册
│   │   └── main.rs           # Windows 入口
│   ├── icons/                # 应用图标
│   └── tauri.conf.json       # Tauri 配置
├── index.html
├── vite.config.ts            # Vite 配置
└── tsconfig.json             # TypeScript 配置
```

## 安全说明

- 服务器连接配置（含密码、私钥、passphrase）目前保存在浏览器
  localStorage 中，通过 Tauri IPC 传递给 Rust 端
- 当前 MVP 版本**信任所有主机密钥**，尚未实现 known_hosts 校验与
  首次连接指纹确认
- 请勿在代码或日志中打印密码、私钥等敏感信息
- 后续计划将凭据迁移至操作系统凭据管理器（如 Windows Credential
  Manager）加密存储

## 测试

项目暂未配置自动化测试框架。提交前请至少运行：

```bash
npm run build    # 包含 tsc 类型检查 + Vite 前端构建
cargo check      # Rust 编译检查（在 src-tauri/ 目录下执行）
```

新增测试建议：前端逻辑使用 Vitest（文件命名为 `*.test.tsx` / `*.test.ts`），
Rust 模块使用 `cargo test`。

## 路线图

- [ ] SFTP 上传 / 下载（进度条、断点续传）
- [ ] known_hosts 主机密钥校验 + 首次连接指纹确认弹窗
- [ ] 密码迁移到 OS 凭据管理器加密存储
- [ ] 连接监控面板（CPU / 内存 / 网络图表，FinalShell 风格）
- [ ] 快捷命令片段
- [ ] 终端主题 / 字体设置
- [ ] 跳板机（ProxyJump）、端口转发

## 参与贡献

欢迎提交 Issue 与 Pull Request。提交 PR 时请：

- 使用 conventional commits 风格的提交信息，如 `feat: ...`、`fix: ...`
- 提供简短的变更说明与原因
- UI 变更请附截图或录屏
- 如新增了 Tauri 权限或 Rust 依赖，请在 PR 中注明
