---
title: Install and Run
nav_title: Install and Run
description: Run the CLI from source - install dependencies, configure a provider, launch from any directory.
order: 0
---

# Install and Run

The CLI is the core of Claude Code Haha — every desktop session runs one underneath. If you only want the graphical app, installing that is enough; see [Download and install](../start/install.md). The steps below are for people who want a terminal workflow, `--print` automation, or a source checkout to read and contribute to.

The CLI runs from source only. There is no separate installer for it.

## Get the source

Install [Git](https://git-scm.com/downloads) and [Bun](https://bun.sh) first, then:

```bash
git clone https://github.com/NanmiCoder/cc-haha.git
cd cc-haha
bun install
```

## Configure a model provider

```bash
cp .env.example .env
```

Edit `.env` with at least one working authentication method, base URL, and model. A minimal Anthropic-compatible setup looks like this:

```ini
ANTHROPIC_AUTH_TOKEN=sk-example
ANTHROPIC_BASE_URL=https://provider.example.com/anthropic
ANTHROPIC_MODEL=provider-model
```

See [Environment variables](./env.md) for what each variable means, how the authentication headers differ, and how to configure Azure and other protocols. If you already configured a provider in the desktop app, the CLI reuses it and you do not need a `.env` at all.

Never commit a real API key, and never paste one into an issue, a screenshot, or a diagnostics bundle.

## Start and verify

macOS, Linux, or Git Bash:

```bash
./bin/claude-haha
./bin/claude-haha -p "Summarize the directory structure of this project"
```

Windows PowerShell or cmd:

```powershell
bun --env-file=.env ./src/entrypoints/cli.tsx
```

Once you see streaming output and tool calls, the provider, the project directory, and the CLI are connected.

## Run from any directory

`./bin/claude-haha` only works inside the checkout. Put it on your `PATH` and you can type `claude-haha` in any project directory — the CLI treats the current working directory as the project root.

On macOS and Linux, add this to `~/.bashrc` or `~/.zshrc`:

```bash
# Option 1: add to PATH (recommended)
export PATH="$HOME/path/to/claude-code-haha/bin:$PATH"

# Option 2: alias
alias claude-haha="$HOME/path/to/claude-code-haha/bin/claude-haha"
```

Reload the shell config:

```bash
source ~/.zshrc  # or source ~/.bashrc
```

On Windows, add the same `PATH` line to `~/.bashrc` under Git Bash:

```bash
export PATH="$HOME/path/to/claude-code-haha/bin:$PATH"
```

To verify, start it from a different directory and ask what the current directory is:

```bash
cd ~/your-other-project
claude-haha
```

### Windows with a WSL toolchain

If `claude-haha` runs on Windows or Git Bash while Node, Python, uv, and bun live inside WSL, call them through WSL explicitly:

```bash
wsl -e bash -lc 'node --version && python3 --version'
```

When the CLI detects a `wsl` / `wsl.exe` invocation, it sets `MSYS2_ARG_CONV_EXCL=*` so Git Bash does not rewrite WSL paths such as `/home/...` into `C:/Program Files/Git/home/...`.

To route Bash tool commands through WSL by default, set this before startup:

```bash
export CLAUDE_CODE_SHELL_PREFIX='wsl -e bash -lc'
```

Computer Use still controls Windows desktop apps, so CLI tools inside WSL do not need an entry in `computer-use-config.json`. If you only need the WSL toolchain and no desktop control, pass `--no-computer-use` or turn it off under Settings → Computer Use.

## Next steps

- [Command reference](./reference.md): flags, headless mode, and recovery mode
- [Environment variables](./env.md): the full list of authentication, model, and runtime variables
- [Architecture overview](../internals/index.md): how the CLI, server, desktop shell, and adapters divide the work
- [Contributing and quality gates](../internals/contributing.md): what to run before opening a PR
