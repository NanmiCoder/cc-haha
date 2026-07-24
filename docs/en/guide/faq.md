# FAQ and Support

## What is the fastest way to get help?

First, confirm that you are using [GitHub Releases Latest](https://github.com/NanmiCoder/cc-haha/releases/latest), then retry the shortest sequence that reproduces the problem reliably.

If the Desktop app still opens:

1. Go to **Settings → Diagnostics**.
2. Select **Copy Issue Report**.
3. Search [GitHub Issues](https://github.com/NanmiCoder/cc-haha/issues) for the same problem, and create a new issue only if there is no duplicate.
4. Paste the report and add the reproduction steps, expected result, and actual result.

If the report is not enough, you can also select **Export Bundle**. Issue reports and bundles attempt to omit chat content, file content, complete environment variables, and API keys. They can still contain private metadata such as local paths or provider hostnames, so **review everything before sharing it**.

Include:

- The Claude Code Haha version
- Operating system, CPU architecture, and installer type
- Provider type and API format, but never the API key
- The shortest reproduction steps and complete error text
- Whether the problem occurs in Desktop, H5, or the CLI

If the app cannot start, provide the installer version, a screenshot of the system error, and the last visible action before the failure. Do not delete or overwrite `~/.claude` as a troubleshooting shortcut.

## Providers and OAuth

### Do OpenAI-compatible services always require LiteLLM?

No. A Custom Provider in the Desktop app supports:

- Anthropic Messages (native)
- OpenAI Chat Completions (local proxy translation)
- OpenAI Responses API (local proxy translation)

Consider an external gateway such as LiteLLM only when the upstream service uses a protocol or custom fields that the app does not support.

### A custom provider returns 401 or “API Key invalid”

Edit the provider under **Settings → Providers**, then check:

1. The base URL is the API root required by the provider, without a missing or duplicated path.
2. The API format matches the real upstream endpoint.
3. The authentication strategy is correct. Some Anthropic-compatible services use a Bearer token, while the official Anthropic API uses `x-api-key`.
4. The main model ID exists and the current credential can access it.
5. Select **Test Connection**. Resolve the first connectivity failure before the second proxy-translation result shown for OpenAI formats.

Do not expose URL query credentials, tokens, or API keys in screenshots, issues, or diagnostic attachments.

### Claude, ChatGPT, or Grok sign-in does not complete

- Keep Claude Code Haha running while the sign-in flow is open.
- Allow the system browser to open the authorization page and complete authorization with the intended account.
- Confirm that the system clock is correct and that a proxy, firewall, or browser extension is not blocking the provider page or local OAuth callback.
- If the browser reports success but the app does not update, return to **Settings → Providers** and start the sign-in flow again.

If it still fails, copy an Issue Report and state whether the browser did not open, the authorization page failed, or the callback did not return to the app. Never share an OAuth code, access token, or browser cookie.

### The connection test succeeds, but chat still fails

Confirm that the current task selected the new Provider and model; saving a Provider does not necessarily select it for every task. Also check that the account supports the configured main and role-model mappings.

Create a new task and retry with a short plain-text message. If it still fails, copy an Issue Report from Diagnostics. A successful connection test proves basic endpoint, authentication, and translation behavior; it does not verify every model capability, tool call, or long-context combination.

## Installation and Updates

### macOS says the app cannot be verified, is damaged, or will not open

Confirm that the installer came from the [official Latest Release](https://github.com/NanmiCoder/cc-haha/releases/latest) and that you selected the correct Intel or Apple Silicon architecture. A signed and notarized public release should normally show only the standard download-source confirmation.

Older, draft, or temporary unsigned builds may need extra approval. See the [Desktop installation guide](/en/desktop/04-installation#macos). Do not bypass system security prompts for packages from unknown mirrors.

### Windows shows SmartScreen

Confirm that the installer came from the official Release. An unsigned Windows installer may trigger SmartScreen. Expand “More info,” verify the file name and source, and then decide whether to run it.

Quit Claude Code Haha completely before an in-place update. If the installer reports that a process is still running, close the relevant window and background process before retrying. Do not delete the user configuration directory first.

### A Linux AppImage does not start

Make it executable:

```bash
chmod +x Claude-Code-Haha-<version>-linux-<architecture>.AppImage
```

Some distributions also require FUSE. See the [Desktop installation guide](/en/desktop/04-installation#linux) for distribution-specific instructions.

## H5 Access

### A phone or another computer cannot connect to H5

Check each item in order:

1. **H5 Access** is enabled in the Desktop app.
2. You are using the Server URL currently shown in Settings or encoded in the current QR code, not an old LAN address.
3. The client has the current H5 token.
4. Both devices are on networks that can reach each other, and the system firewall allows the configured port.
5. A reverse proxy forwards both HTTP and WebSocket traffic and uses an allowed origin.

H5 is a remote entry point to the current Desktop service, not the complete Desktop environment. Terminals, native previews, pet windows, and some system capabilities remain Desktop-only.

See [H5 access](/en/desktop/06-h5-access) for deployment and security details.

## Git Branches and Worktrees

### Creating an isolated worktree fails

Common causes include:

- The selected directory is not a Git repository
- The branch does not exist or is already checked out by another worktree
- Uncommitted changes prevent the requested Git operation from running safely
- The target worktree path already exists or is not writable

Read the exact error shown in the app. You can use the current working tree, select a different branch, or handle the existing Git changes safely before retrying. Do not automatically delete an existing directory or discard uncommitted changes to make a worktree.

### Should I use the current working tree or an isolated worktree?

- **Current working tree**: continue work that already exists in the selected directory.
- **Isolated worktree**: run a parallel task or keep a branch separate from the current checkout.

If the current directory contains important uncommitted changes, inspect the Git status and make a backup before choosing.

## Computer Use

### Computer Use is unavailable or cannot control an app

Open **Settings → Computer Use** and confirm:

- The global feature switch is enabled
- Python and dependency checks pass
- Required macOS or Windows system permissions are granted
- The target app is in the list of apps allowed for control
- The current session's permission request was explicitly approved

After granting a system permission, reopen Claude Code Haha or the target app. Computer Use is not currently supported on Linux. A successful Desktop installation does not mean that Computer Use is fully configured.

If Settings still shows an error, copy an Issue Report and include the status shown on that page. Avoid uploading a full-screen screenshot that exposes content from other apps.

## CLI

### `bun install` or the CLI fails to start

Confirm that the shell is in the repository root and that Bun is current enough for the project:

```bash
bun --version
bun install
./bin/claude-haha --help
```

If the error mentions a missing Bun built-in such as `bun:bundle`, upgrade Bun. See [Get Started in 3 Minutes](./quick-start.md#option-2-run-the-cli-from-source) for installation and the [CLI reference](./cli-reference.md) for commands.
