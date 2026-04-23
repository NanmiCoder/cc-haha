# Quick Start

## 1. Install Bun

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# macOS (Homebrew)
brew install bun

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

> On minimal Linux images, if you see `unzip is required`, run `apt update && apt install -y unzip` first.

## 2. Install Dependencies and Configure

```bash
bun install
cp .env.example .env
# Edit .env with your API key
```

See [Environment Variables](./env-vars.md) for the full reference.

## 3. Start

### macOS / Linux

```bash
./bin/claude-haha                          # Interactive TUI mode
./bin/claude-haha -p "your prompt here"    # Headless mode
./bin/claude-haha --help                   # Show all options
```

### Windows

> **Prerequisite**: [Git for Windows](https://git-scm.com/download/win) must be installed.

```powershell
# PowerShell / cmd — call Bun directly
bun --env-file=.env ./src/entrypoints/cli.tsx

# Or run inside Git Bash
./bin/claude-haha
```

## 4. Global Usage (Optional)

Add `bin/` to your PATH to run from any directory. See [Global Usage Guide](./global-usage.md):

```bash
export PATH="$HOME/path/to/claude-code-haha/bin:$PATH"
```

## 5. Recovery Mode

If the Ink TUI has issues, use the fallback Recovery CLI mode:

```bash
CLAUDE_CODE_FORCE_RECOVERY_CLI=1 ./bin/claude-haha
```
