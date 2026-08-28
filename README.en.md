# ConchTerm

[简体中文](./README.md) | English

ConchTerm is a cross-platform desktop SSH client built with Tauri 2 +
Rust + React + TypeScript, aiming to rival XShell / MobaXterm / FinalShell.
The React frontend handles UI and interaction, while the Rust backend
implements SSH and SFTP via russh. The two communicate over Tauri IPC.

## Features

- **SSH terminal**: password and private key (PEM) authentication, rendered
  with xterm.js with 256-color support
- **Multi-tab**: open multiple terminals at once; tabs for the same server
  share a single TCP connection
- **Server management**: add / edit / delete connection profiles, persisted
  in localStorage
- **Remote file browser**: SFTP-based directory listing, folder creation,
  rename, and delete
- **Dual-view sidebar**: switch between "Servers" and "Files" panels, with
  a drag-adjustable width
- **CJK-friendly rendering**: full-width character display widths are
  handled so terminal tables stay aligned
- **Smooth long output**: terminal output streams through a binary channel,
  bypassing JSON serialization
- **Keepalive**: SSH-level keepalive every 30 seconds keeps idle sessions
  alive

## Architecture

```
┌─────────────────── Frontend (WebView) ───────────────────┐
│  App.tsx        Layout, sidebar, and tab state            │
│  TerminalView   xterm.js ↔ ipc::Channel binary stream     │
│  FileBrowser    SFTP file panel                           │
│  ServerForm     Connection profile form                   │
│  storage.ts     localStorage persistence for profiles     │
└──────────────┬──────────────────────┬────────────────────┘
       invoke / Channel         invoke (JSON)
┌──────────────▼──────────────────────▼────────────────────┐
│  ssh.rs  (Rust backend)                                   │
│  ├─ russh          SSH protocol, auth, PTY, data stream   │
│  ├─ russh-sftp     SFTP subsystem (separate TCP conn)     │
│  └─ SessionMap     Global session table (Tauri State)     │
└───────────────────────────────────────────────────────────┘
```

**Key design notes**:

- Terminal output is pushed to the frontend as binary via
  `tauri::ipc::Channel<Vec<u8>>`; xterm.js writes the `Uint8Array` directly,
  so large outputs stay smooth
- Keyboard input is sent as raw bytes via `invoke("ssh_write")`; terminal
  resize events are debounced before syncing the remote PTY size
- SFTP uses a separate TCP connection: some servers (`MaxSessions 1`)
  refuse multiple session channels on one connection
- The session table lives in `State<SessionMap>`; closing a terminal tab
  explicitly disconnects the remote session

## Getting Started

**Prerequisites**

- Node.js 18+
- Rust stable (MSVC toolchain on Windows)
- Visual Studio Build Tools (C++ workload) on Windows

```bash
# Install frontend dependencies
npm install

# Start development mode (hot reload)
npm run tauri dev

# Type-check and build the frontend
npm run build

# Rust-only compile check (run inside src-tauri/)
cargo check

# Package the desktop installer (msi / nsis on Windows)
npm run tauri build
```

## Project Structure

```
conchterm/
├── src/                      # Frontend source (React + TypeScript)
│   ├── App.tsx               # App layout and terminal tab state
│   ├── api.ts                # Tauri invoke wrappers and types
│   ├── storage.ts            # localStorage persistence for profiles
│   ├── main.tsx              # React entry point
│   └── components/
│       ├── TerminalView.tsx  # Single SSH terminal (xterm.js)
│       ├── ServerForm.tsx    # Add / edit server profile form
│       └── FileBrowser.tsx   # SFTP remote file panel
├── src-tauri/                # Rust backend
│   ├── src/
│   │   ├── ssh.rs            # SSH/SFTP session management (auth, PTY)
│   │   ├── lib.rs            # App entry and command registration
│   │   └── main.rs           # Windows entry point
│   ├── icons/                # App icons
│   └── tauri.conf.json       # Tauri configuration
├── index.html
├── vite.config.ts            # Vite configuration
└── tsconfig.json             # TypeScript configuration
```

## Security Notes

- Server profiles (including passwords, private keys, and passphrases) are
  currently stored in localStorage and passed to the Rust side over Tauri IPC
- The current MVP **trusts all host keys**; known_hosts verification and a
  first-connect fingerprint prompt are not yet implemented
- Never print passwords, private keys, or other secrets in code or logs
- A future release plans to migrate credentials to the OS credential
  manager (e.g., Windows Credential Manager) with encryption

## Testing

No automated test framework is configured yet. At minimum, run before
submitting changes:

```bash
npm run build    # tsc type-check + Vite frontend build
cargo check      # Rust compile check (run inside src-tauri/)
```

When adding tests, prefer Vitest for frontend logic
(`*.test.tsx` / `*.test.ts`) and `cargo test` for Rust modules.

## Roadmap

- [ ] SFTP upload / download (progress bar, resumable transfers)
- [ ] known_hosts host key verification + first-connect fingerprint prompt
- [ ] Migrate credentials to OS credential manager with encryption
- [ ] Connection monitoring panel (CPU / memory / network charts,
      FinalShell style)
- [ ] Quick command snippets
- [ ] Terminal theme / font settings
- [ ] Jump hosts (ProxyJump) and port forwarding

## Contributing

Issues and pull requests are welcome. When submitting a PR, please:

- Follow conventional commit style, e.g., `feat: ...`, `fix: ...`
- Include a short description of what changed and why
- Attach screenshots or screen recordings for UI changes
- Note any new Tauri permissions or Rust dependencies
