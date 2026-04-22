# Desktop Architecture

The desktop stack is split into three main layers:

- `desktop/src/` — React frontend
- `desktop/src-tauri/` — Tauri host layer
- `src/server/` — local API and session server

For now, the most relevant entrypoint for browser-based desktop development is the launcher command:

```bash
./bin/claude-haha-desktop
```

It starts the local server and frontend together for development.
