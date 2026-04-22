# Desktop Quick Start

## Start the desktop Web UI

### One-command startup

From the project root, run:

```bash
./bin/claude-haha-desktop
```

If `bin/` is already on your PATH, you can also run:

```bash
claude-haha-desktop
```

This will:

- start the local API server on `127.0.0.1:3456`
- start the desktop frontend on `127.0.0.1:2024`
- open the browser automatically

### Manual startup

If you need to debug the startup sequence manually:

```bash
# backend
SERVER_PORT=3456 bun run src/server/index.ts

# frontend
cd desktop
bun run dev --host 127.0.0.1 --port 2024
```

Then open `http://127.0.0.1:2024`.

## Next steps

- See [Installation & Build](./04-installation.md) for platform notes
- See the Chinese desktop docs for the full UI walkthrough and architecture details
