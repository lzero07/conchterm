# Repository Guidelines

## Project Structure & Module Organization

ShellTool is a Tauri 2 desktop SSH client: React + TypeScript frontend, Rust backend.

- `src/` — frontend source: `App.tsx` (layout and tab state), `components/` (TerminalView, ServerForm, FileBrowser), `api.ts` (Tauri invoke wrappers), `storage.ts` (localStorage persistence).
- `src-tauri/src/` — backend source: `ssh.rs` (SSH/SFTP sessions over russh), `main.rs` and `lib.rs` (app entry and command registration).
- `src-tauri/icons/` and `public/` — static assets.
- `index.html`, `vite.config.ts`, `tsconfig.json` — Vite/TypeScript configuration.

## Build, Test, and Development Commands

- `npm install` — install frontend dependencies (Node.js 18+).
- `npm run tauri dev` — run the desktop app with hot reload (requires Rust stable and, on Windows, MSVC Build Tools).
- `npm run build` — type-check with `tsc` and bundle the frontend with Vite.
- `npm run tauri build` — package the desktop installer (MSI/NSIS).
- `cargo check` — fast Rust-only compile check from `src-tauri/`.

## Coding Style & Naming Conventions

- TypeScript: 2-space indent, double quotes, strict mode with `noUnusedLocals` and `noUnusedParameters`. Name components in PascalCase (`TerminalView.tsx`), utilities in camelCase (`storage.ts`).
- Rust: standard `rustfmt` style; run `cargo fmt` in `src-tauri/` before committing. Use `snake_case` for functions and modules, `PascalCase` for types.
- Comments in existing code are in Chinese; follow the surrounding style.

## Testing Guidelines

No test framework is configured yet. At minimum run `npm run build` (includes type checking) and `cargo check` before submitting changes. If adding tests, prefer Vitest for frontend logic and `cargo test` for Rust modules; name frontend files `*.test.tsx` or `*.test.ts`.

## Commit & Pull Request Guidelines

History follows conventional commits, e.g. `feat: ShellTool MVP - SSH 终端 + SFTP 文件浏览器`. Use `feat:`, `fix:`, or `chore:` prefixes with a concise summary.

Pull requests should include a short description of what changed and why, linked issues when applicable, and screenshots or screen recordings for UI changes. Note any new Tauri permissions or Rust dependencies added.

## Security Notes

Credentials are stored in localStorage and passed to Rust over Tauri IPC. Never log passwords, private keys, or session secrets; avoid introducing new persistence paths for secrets without discussing storage first.
