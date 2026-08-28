# ConchTerm CI/CD 指南

本文档记录本项目的两条 GitHub Actions 流水线：日常 CI 检查与多平台发布。包含流水线结构说明、日常操作手册、故障排查方法，以及搭建过程中的核心概念与实战记录。

## 一、总览

| 流水线 | 文件 | 触发条件 | 作用 | 参考耗时 |
|---|---|---|---|---|
| CI | `.github/workflows/ci.yml` | push 到 main / 任何 PR / 手动触发 | 前端构建 + Rust 格式/lint/编译检查 | 约 1.5 分钟（缓存热） |
| Release | `.github/workflows/release.yml` | 推送 `v*` 格式的 tag | 三平台构建安装包，上传到 GitHub Draft Release | 约 12-25 分钟 |

## 二、CI 流水线详解

### 结构

CI 拆成两个并行 job，分别盯项目的两半：

| Job | 运行环境 | 步骤 | 拦截的问题 |
|---|---|---|---|
| Frontend build | ubuntu-latest | `npm ci` → `npm run build`（即 `tsc && vite build`） | TypeScript 类型错误、前端打包失败 |
| Rust check | windows-latest | 装 stable 工具链（含 rustfmt/clippy 组件） → rust-cache → `cargo fmt --check` → `cargo clippy -- -D warnings` | 格式不合规、代码坏味道、编译错误 |

两个 job 并行执行，互不阻塞；一个红了另一个照跑，方便立刻定位问题在前端还是后端。

Rust job 选 windows-latest 的原因：与开发环境一致，且 Tauri 在 Linux runner 上编译需要额外安装 webkit 系统依赖。

注意：流水线里没有单独的 `cargo check`。clippy 包含完整的编译验证，编译不过 clippy 同样失败，单独跑 check 属于重复劳动。

### 质量门禁

- `cargo fmt --check`：只检查不改写代码格式。零编译成本、秒级返回，放在最前面体现"快速失败"原则。对标前端的 Prettier。
- `cargo clippy -- -D warnings`：Rust 官方 lint 工具，内置数百条规则检查"能编译但写法可疑"的代码。`-D warnings` 把警告升级为错误，是 CI 拦截生效的关键。对标前端的 ESLint。

### 缓存

- `actions/setup-node` 的 `cache: npm`：缓存 npm 下载目录。
- `Swatinem/rust-cache@v2`：缓存 `src-tauri/target` 编译产物。必须指定 `workspaces: src-tauri`，因为 action 默认只找仓库根目录的 Cargo.toml。

实测效果（Rust job）：

| 场景 | 耗时 |
|---|---|
| 冷缓存（首次或 Cargo.lock 变更后） | 3m03s |
| 热缓存（仅源码变更） | 1m22s |

缓存只存依赖树的编译产物；自己写的代码每次都会真实重编译，这是正确行为。冷启动的那一次运行负责生成缓存，之后才享受加速。

## 三、Release 流水线详解

### 结构

```yaml
on:
  push:
    tags: ['v*']          # 推 v 开头的 tag 才触发，与 CI 的分支触发互补

permissions:
  contents: write         # 默认 GITHUB_TOKEN 只读；创建 Release 必须显式申请写权限
```

核心是 matrix 构建：一份 job 定义 × 三个平台，GitHub 自动复制成三个并行 job。

| 平台 | runner | 额外步骤 | 产物 |
|---|---|---|---|
| Windows | windows-latest | 无 | `.msi`、`-setup.exe`（NSIS） |
| macOS | macos-latest（Apple Silicon） | 无 | `.dmg`、`.app.tar.gz` |
| Linux | ubuntu-22.04 | `apt-get install` webkit 等 | `.AppImage`、`.deb`、`.rpm` |

关键设计：

- `fail-fast: false`：某个平台失败不连坐，其他平台照常出包。
- Ubuntu 用 22.04 而非 latest：glibc 向前不向后兼容，在较旧系统上编译的二进制能运行于更新系统，反之不行。
- Ubuntu job 里的 `if: matrix.settings.platform == 'ubuntu-22.04'` 条件步骤：只有 Linux 需要装 `libwebkit2gtk-4.1-dev` 等系统依赖。
- `releaseDraft: true`：构建产物上传到 GitHub Draft Release（草稿），由人工检查后手动点 Publish。这是持续交付（Continuous Delivery）的"留给人的按钮"；若改为全自动发布则是持续部署（Continuous Deployment）。桌面软件通常止步于交付。

## 四、操作手册

### 日常开发

1. 正常写代码、提交。
2. 推送到 main 或开 PR，CI 自动运行。
3. 本地推送前可预检（与 CI 完全相同的检查）：

```powershell
cd src-tauri
cargo fmt --check
cargo clippy -- -D warnings
cd ..
npm run build
```

### 手动触发 CI

仓库 Actions 页 → 左侧选 CI → Run workflow 按钮 → 选 main → 确认。

### 发布新版本

前置：确认 main 分支代码已通过 CI；未完成的功能不进 tag。

1. 改版本号。以 `src-tauri/tauri.conf.json` 的 `version` 为权威（Release 产物文件名取自这里），同时同步 `src-tauri/Cargo.toml` 与 `package.json`，三处保持一致。
2. 提交并推送：

```powershell
git add .
git commit -m "chore: bump version to 0.2.0"
git push
```

3. 打 tag 并推送（顺序很重要：tag 必须指向包含 release.yml 和新版本号的提交）：

```powershell
git tag v0.2.0
git push origin v0.2.0
```

4. 到 Actions 页观察 Release 流水线，三个平台并行构建，整体约 12-25 分钟。
5. 全绿后到 Releases 页，检查 Draft Release 中的产物清单。
6. 确认无误，点 Publish 正式发布。

### 查看结果

- **Actions 页**：每次运行的完整日志，job → step 逐层展开。
- **Releases 页**：历史版本与各平台安装包下载。

## 五、故障排查手册

### 排查思路

运行变红时按三层定位：先看哪个 job 红（前端还是后端）→ 再看哪个 step 红（工具链安装、fmt、clippy 还是构建）→ 最后展开 step 日志找第一个 error。

### 常见失败模式

| 现象 | 原因 | 处理 |
|---|---|---|
| `Cargo fmt` step 秒红 | 本地改了代码但格式修复没提交；或从未跑过 `cargo fmt` | 本地 `cargo fmt` 后把格式变更一并提交 |
| `Cargo clippy` 红并提示 lint 名 | 代码存在 clippy 认定的坏味道 | 按 clippy 提示修复；确属误报可加 `#[allow(clippy::xxx)]` 并注释原因 |
| clippy 报编译错误（E0432 等） | 依赖升级后 API 变动或代码本身写错 | 按编译器提示修复 |
| 缓存未生效、Rust job 仍然全量耗时 | 首次运行或 Cargo.lock 变更导致缓存键变化 | 属正常现象，本次运行会生成新缓存 |

### 实战案例（本项目真实踩坑记录）

1. **格式修复没进提交**：`git add` 只加了 workflow 文件，`lib.rs`/`ssh.rs` 的格式化改动留在本地，远端 `cargo fmt --check` 量的是旧代码，直接红。教训：修复代码的提交要包含修复本身。
2. **clippy 抓到真问题**：`ssh.rs` 中 match 分支内嵌套 `if`，clippy 建议合并为 match guard（`collapsible_match` 规则）。合并前需确认语义等价：guard 失败时会落到后续分支，必须保证后续分支无副作用。
3. **`-j` 参数位置**：`cargo clippy -- -D warnings -j 2` 中 `-j` 被转发给编译器报"Unrecognized option"。`--` 之后的参数都传给编译器，cargo 自己的参数要写在 `--` 之前。
4. **本地编译 OOM**：Windows 上全并行编译可能报 `页面文件太小 (os error 1455)` 或 `out of memory`。用 `-j 2` 限制并行度即可，不影响 CI（GitHub runner 内存充足）。

### 语义修改的核对清单

改 match 结构、加 match guard 这类"看起来等价"的重构，推送前自查三点：

1. guard 失败后落入的分支是否有副作用；
2. 变量是否被重复消费（如 `to_vec()` 后再使用）；
3. 是否有完全用条件模拟分支的替代写法更不易错。

## 六、核心概念

- **CI 与 CD 的分界**：CI 的产出是"裁决"（绿/红），CD 的产出是"产品"（安装包/镜像）。CI 回答"代码合不合格"，CD 回答"合格的代码怎么交到用户手里"。
- **交付与部署**：持续交付（Delivery）自动把产品做好挂好，发布键留给人；持续部署（Deployment）连发布键都自动化。桌面软件一般取交付。
- **Runner 是一次性的**：每条流水线跑在全新的虚拟机上，跑完即销毁。一切可复用的东西（依赖、编译产物）必须显式声明缓存。
- **并行与 matrix**：无依赖关系的 job 并行执行，总耗时取决于最慢者；matrix 用一份定义派生多份环境（多平台/多版本）。
- **权限最小化**：`GITHUB_TOKEN` 默认只读，需要写操作（如创建 Release）时在 workflow 里显式声明 `permissions`。任何密钥走 Secrets，绝不进代码和日志。
- **tag 驱动发布**：tag 是不可变指针，指向哪个提交就构建哪个提交，天然保证"发布产物与代码版本一一对应"。

## 七、实测数据（v0.1.0 首次发布）

CI（push 触发，01b5cc7）：

| Job | 冷缓存 | 热缓存 |
|---|---|---|
| Rust check | 3m03s | 1m22s |
| Frontend build | 19s | 16s |

Release（tag v0.1.0，三平台并行）：

| 平台 | 耗时 |
|---|---|
| macOS (Apple Silicon) | 4m11s |
| Ubuntu 22.04 | 7m59s |
| Windows | 12m28s |

产物共 7 个：`.msi`、`-setup.exe`、`.dmg`、`.app.tar.gz`、`.AppImage`、`.deb`、`.rpm`。

## 八、已知问题与进阶路线

已知问题：

- 安装包未做代码签名，Windows/macOS 用户安装时会出现"未知发布者"警告。

已解决：

- ~~GitHub 提示 Node.js 20 deprecated~~：`actions/checkout`、`actions/setup-node` 已升级至 v7（运行于 Node 24）。

进阶路线（阶段五候选）：

1. 代码签名证书接入 GitHub Secrets，流水线自动签名；
2. PR 触发 release 构建，合并前验证"能打包"；
3. main 分支 nightly 构建；
4. Release 发布后自动通知。
