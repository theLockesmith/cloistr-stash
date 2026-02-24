# Cloistr Drive Desktop App

## Overview

Native desktop application for Cloistr Drive built with **Tauri** (Rust + WebView). Provides native file system integration, background sync, and system tray access.

## Why Tauri?

| Aspect | Tauri | Electron |
|--------|-------|----------|
| Bundle size | ~10 MB | ~150 MB |
| Memory usage | ~50 MB | ~200 MB |
| Backend | Rust | Node.js |
| Security | Strong sandbox | Weaker |
| WebView | System native | Bundled Chromium |

**Decision:** Tauri provides smaller bundles, lower resource usage, and better security - important for an encryption-focused app.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Tauri Desktop App                         │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                 Frontend (WebView)                      │ │
│  │                                                         │ │
│  │   Existing cloistr-drive web UI                        │ │
│  │   (HTML/CSS/JS, crypto.js, keys.js, etc.)              │ │
│  │                                                         │ │
│  │   + Desktop-specific features:                         │ │
│  │     • Sync folder picker                               │ │
│  │     • Native file drag-drop                            │ │
│  │     • Bandwidth settings UI                            │ │
│  │                                                         │ │
│  └──────────────────────┬──────────────────────────────────┘ │
│                         │ Tauri IPC                          │
│  ┌──────────────────────▼──────────────────────────────────┐ │
│  │                  Backend (Rust)                          │ │
│  │                                                          │ │
│  │   • File system watcher (notify crate)                  │ │
│  │   • Sync engine                                         │ │
│  │   • System tray management                              │ │
│  │   • Auto-updater                                        │ │
│  │   • Native dialogs                                      │ │
│  │   • Secure key storage (keyring)                        │ │
│  │   • Background daemon                                   │ │
│  │                                                          │ │
│  └──────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Project Structure

```
cloistr-drive-desktop/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json       # Tauri configuration
│   ├── src/
│   │   ├── main.rs           # Entry point
│   │   ├── commands.rs       # IPC command handlers
│   │   ├── sync/
│   │   │   ├── mod.rs
│   │   │   ├── watcher.rs    # File system watcher
│   │   │   ├── engine.rs     # Sync logic
│   │   │   └── queue.rs      # Upload/download queue
│   │   ├── tray.rs           # System tray
│   │   ├── keyring.rs        # Secure key storage
│   │   └── updater.rs        # Auto-updates
│   └── icons/                # App icons
├── src/                      # Frontend (symlink to web/ or copy)
│   └── ...                   # Existing web UI
├── package.json
└── README.md
```

## Features

### Phase 1: Basic Desktop App
- [ ] Wrap existing web UI in Tauri window
- [ ] System tray with basic menu (Open, Quit)
- [ ] Native window controls (minimize to tray)
- [ ] App icon and branding
- [ ] Build for Linux, macOS, Windows

### Phase 2: Sync Folder
- [ ] Choose local sync folder
- [ ] File system watcher (detect changes)
- [ ] Upload new/modified files
- [ ] Download remote files to sync folder
- [ ] Sync status indicator (tray icon states)
- [ ] Conflict detection and resolution

### Phase 3: Background Sync
- [ ] Run as background daemon
- [ ] Auto-start on login
- [ ] Bandwidth throttling
- [ ] Pause/resume sync
- [ ] Sync queue management

### Phase 4: Native Integration
- [ ] "Open with" file handler
- [ ] Context menu integration (right-click → Upload to Cloistr)
- [ ] Native notifications
- [ ] Secure keyring storage for session
- [ ] Auto-updater

### Phase 5: Advanced Features
- [ ] Selective sync (choose folders)
- [ ] LAN sync (direct device-to-device)
- [ ] Virtual drive (FUSE on Linux/macOS, WinFSP on Windows)
- [ ] Smart sync (download on demand)

## Sync Engine Design

### State Machine

```
┌─────────┐     file changed      ┌──────────┐
│  IDLE   │ ───────────────────► │ PENDING  │
└─────────┘                       └──────────┘
     ▲                                 │
     │                                 │ queue not full
     │         ┌──────────┐            ▼
     └─────────│ COMPLETE │ ◄──── ┌──────────┐
               └──────────┘       │ SYNCING  │
                    ▲             └──────────┘
                    │                  │
                    │   error          │
                    │   ┌──────────┐   │
                    └───│  RETRY   │◄──┘
                        └──────────┘
```

### Conflict Resolution

When both local and remote files change:

1. **Last-write-wins** (default) - Most recent timestamp wins
2. **Keep both** - Rename local to `filename (conflict).ext`
3. **Ask user** - Show conflict resolution dialog

### File Ignore Patterns

Default ignores (configurable):
```
.git/
.DS_Store
Thumbs.db
*.tmp
*.swp
~$*
```

## IPC Commands

Commands exposed from Rust to JavaScript:

```rust
#[tauri::command]
fn set_sync_folder(path: String) -> Result<(), String>

#[tauri::command]
fn get_sync_status() -> SyncStatus

#[tauri::command]
fn pause_sync() -> Result<(), String>

#[tauri::command]
fn resume_sync() -> Result<(), String>

#[tauri::command]
fn get_sync_queue() -> Vec<QueueItem>

#[tauri::command]
fn open_file_native(path: String) -> Result<(), String>

#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String>

#[tauri::command]
fn get_keyring_session() -> Option<String>

#[tauri::command]
fn set_keyring_session(session: String) -> Result<(), String>
```

## Configuration

Stored in platform-specific config directory:
- Linux: `~/.config/cloistr-drive/`
- macOS: `~/Library/Application Support/com.cloistr.drive/`
- Windows: `%APPDATA%\cloistr-drive\`

```json
{
  "sync_folder": "/home/user/Cloistr",
  "auto_start": true,
  "bandwidth_limit_up": 0,
  "bandwidth_limit_down": 0,
  "conflict_resolution": "last-write-wins",
  "ignore_patterns": [".git/", "*.tmp"],
  "notifications_enabled": true,
  "minimize_to_tray": true
}
```

## Build & Distribution

### Development

```bash
# Install Tauri CLI
cargo install tauri-cli

# Install dependencies
cd cloistr-drive-desktop
npm install

# Run in development
cargo tauri dev
```

### Production Build

```bash
# Build for current platform
cargo tauri build

# Output locations:
# Linux:   src-tauri/target/release/bundle/deb/
#          src-tauri/target/release/bundle/appimage/
# macOS:   src-tauri/target/release/bundle/dmg/
# Windows: src-tauri/target/release/bundle/msi/
```

### CI/CD

GitHub Actions workflow for multi-platform builds:
- Linux: AppImage, .deb
- macOS: .dmg (signed + notarized)
- Windows: .msi (signed)

Auto-publish to GitHub Releases with auto-updater integration.

## Dependencies

### Rust (src-tauri/Cargo.toml)

```toml
[dependencies]
tauri = { version = "1.5", features = ["system-tray", "updater", "dialog"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
notify = "6.0"           # File system watcher
keyring = "2.0"          # Secure credential storage
tokio = { version = "1", features = ["full"] }
reqwest = "0.11"         # HTTP client for API
```

### JavaScript (package.json)

```json
{
  "dependencies": {
    "@tauri-apps/api": "^1.5.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^1.5.0"
  }
}
```

## Security Considerations

1. **Key storage**: Use OS keyring (Keychain, libsecret, Credential Manager)
2. **IPC validation**: Validate all commands from frontend
3. **File access**: Restrict to sync folder only
4. **Auto-updates**: Signed updates only, verify signatures
5. **No telemetry**: Privacy-first, no tracking

## Timeline Estimate

| Phase | Scope |
|-------|-------|
| Phase 1 | Basic Tauri wrapper |
| Phase 2 | Sync folder with upload/download |
| Phase 3 | Background daemon, auto-start |
| Phase 4 | Native OS integration |
| Phase 5 | Advanced features (virtual drive) |

## Resources

- [Tauri Documentation](https://tauri.app/v1/guides/)
- [Tauri GitHub](https://github.com/tauri-apps/tauri)
- [notify crate](https://docs.rs/notify/latest/notify/) - File system events
- [keyring crate](https://docs.rs/keyring/latest/keyring/) - Secure storage
