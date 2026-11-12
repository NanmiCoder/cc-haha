# Claude Code Haha Desktop

Desktop client built on Tauri 2 + React.

## Development

```bash
bun install
bun run tauri dev
```

## Build

```bash
# macOS (Apple Silicon)
./scripts/build-macos-arm64.sh

# Windows (x64, MSI only)
.\scripts\build-windows-x64.ps1
```

Build output goes to the `build-artifacts/` directory; file names explicitly include platform, architecture, and package type.

## FAQ

### macOS says the app "is damaged and can't be opened"

```bash
xattr -cr /Applications/Claude\ Code\ Haha.app
```
