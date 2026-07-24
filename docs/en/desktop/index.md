# Desktop App

Claude Code Haha Desktop is the Electron-based workbench for local coding sessions. It combines chat, projects, workspace review, terminals, providers, Skills, Agents, background activity, scheduled tasks, IM adapters, and optional H5 access in one application.

This guide describes the current Desktop experience. For exact changes between releases, see [GitHub Releases](https://github.com/NanmiCoder/cc-haha/releases).

## Start here

- [Quick Start](./01-quick-start.md) — install the app, connect a provider, open a project, and send the first message
- [Feature Guide](./03-features.md) — sessions, workspace tools, Skills, Agents, pets, activity, search, and diagnostics
- [Installation](./04-installation.md) — platform packages, first-launch prompts, Web UI, and headless Linux
- [FAQ](./05-FAQ.md) — provider, data, startup, update, and recovery questions
- [H5 Access](./06-h5-access.md) — optional browser access from a trusted LAN or reverse proxy
- [Desktop Pets](./pets.md) — enable a companion, follow active tasks, customize its appearance, and import your own pet
- [IM Integrations](../im/) — connect WeChat, DingTalk, WhatsApp, Telegram, or Feishu

## Typical workflow

1. Install the package for your operating system.
2. Complete first-run setup and choose where local data should be stored.
3. Sign in with Claude, OpenAI, or Grok, or add a Custom provider.
4. Create a session and select a project directory, branch, or isolated Worktree.
5. Review tool calls, file changes, previews, tasks, and SubAgent activity while the session runs.
6. Use Diagnostics when a provider, local index, sidecar, or desktop runtime needs attention.

## Important boundaries

- Desktop data stays local unless a configured provider or integration needs to send it to an external service.
- H5 is not a public SaaS login system. It exposes the local service to anyone who has the configured URL and token.
- IM adapters deny access unless a user is explicitly allowlisted or paired.
- Desktop pets are an Electron feature and do not run in H5.
- Model availability, context size, and reasoning effort still depend on the selected account and provider.
