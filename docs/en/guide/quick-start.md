# Get Started in 3 Minutes

Claude Code Haha has two ways to run. Install the **Desktop app** for everyday development. Run the **CLI from source** only when you need a terminal workflow, scripting, or local development.

| Option | Best for | What you need |
|--------|----------|---------------|
| **Desktop (recommended)** | Managing projects, sessions, worktrees, code diffs, and permission reviews | The installer for your platform; **Bun is not required** |
| **CLI** | Terminal users, `--print` automation, and contributors | Git, Bun, and access to a model provider |

## Option 1: Install the Desktop App

### 1. Download the current stable release

Open [GitHub Releases Latest](https://github.com/NanmiCoder/cc-haha/releases/latest), then select the installer for your operating system and CPU:

- macOS on Apple Silicon (M-series): `mac-arm64.dmg`
- macOS on Intel: `mac-x64.dmg`
- Windows: `win-x64.exe` or `win-arm64.exe`
- Linux: the matching `.AppImage` or `.deb`

See the [Desktop installation guide](/en/desktop/04-installation) for platform-specific installation prompts.

### 2. Configure a model provider

Launch the app and open **Settings → Providers**.

The shortest path is to select an official option and follow its on-screen connection or sign-in flow:

- **Claude Official**
- **ChatGPT Official**: sign in with a ChatGPT account through OAuth
- **Grok Official**: sign in with an xAI account through OAuth

These official options do not require you to paste an API key. You can also select **Add Provider**, choose a built-in preset or Custom, and enter the API key, base URL, API format, and model mapping.

Before saving a custom provider, select **Test Connection**. When the test succeeds, make the provider the default. The app can translate OpenAI Chat Completions and OpenAI Responses requests through its built-in local proxy, so LiteLLM is not required by default.

See [Third-party models and custom providers](./third-party-models.md) for configuration details.

### 3. Create your first task

Select `+` in the sidebar:

1. Choose a local project directory.
2. If it is a Git repository, choose the branch to use.
3. Decide whether to use the current working tree or create an isolated worktree.

The current working tree shares any uncommitted changes already in that directory. An isolated worktree is better for parallel tasks or changes that should not affect your current checkout.

### 4. Confirm the model and permissions

Before sending the first message, confirm the Provider, model, and effort. For a first run, keep **Default** permission mode: the app will ask before sensitive tools or commands run.

Use automatic approval or bypass modes only when you understand their impact. See [Desktop quick start](/en/desktop/01-quick-start#5-choose-a-permission-mode) for the permission modes.

### 5. Send the first message

Start with a small, verifiable request:

```text
Inspect this project in read-only mode. Explain how to start it and what its main directories do. Do not modify files.
```

If you see a streaming response, tool calls, and permission requests, the Desktop app, provider, and project directory are connected.

## Option 2: Run the CLI from Source

### 1. Clone the repository and install Bun

Install [Git](https://git-scm.com/downloads) and [Bun](https://bun.sh), then run:

```bash
git clone https://github.com/NanmiCoder/cc-haha.git
cd cc-haha
bun install
```

### 2. Configure a model provider

```bash
cp .env.example .env
```

Edit `.env` with at least one valid authentication method, base URL, and model. See [Environment variables](./env-vars.md) for the variable definitions and authentication-header differences.

Never commit a real API key to Git or expose it in an issue, screenshot, or diagnostic attachment.

### 3. Start and verify

On macOS, Linux, or Git Bash:

```bash
./bin/claude-haha
./bin/claude-haha -p "Summarize the current project structure"
```

On Windows PowerShell or Command Prompt:

```powershell
bun --env-file=.env ./src/entrypoints/cli.tsx
```

See the [CLI reference](./cli-reference.md) for command options, headless mode, recovery mode, and global usage.

## Next Steps

- [Desktop quick start](/en/desktop/01-quick-start): sessions, permissions, attachments, and workspace actions
- [Third-party models and custom providers](./third-party-models.md): providers, API formats, and model mapping
- [FAQ](./faq.md): installation, OAuth, H5, worktree, and Computer Use troubleshooting
- [Global usage](./global-usage.md): start the CLI from any directory
