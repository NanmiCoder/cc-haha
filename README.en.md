# Claude Code Haha

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-horizontal-dark.png">
    <img src="docs/images/logo-horizontal.png" alt="Claude Code Haha" width="480">
  </picture>
</p>

<div align="center">

[![GitHub Stars](https://img.shields.io/github/stars/NanmiCoder/cc-haha?style=social)](https://github.com/NanmiCoder/cc-haha/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/NanmiCoder/cc-haha?style=social)](https://github.com/NanmiCoder/cc-haha/network/members)
[![GitHub Issues](https://img.shields.io/github/issues/NanmiCoder/cc-haha)](https://github.com/NanmiCoder/cc-haha/issues)
[![GitHub Pull Requests](https://img.shields.io/github/issues-pr/NanmiCoder/cc-haha)](https://github.com/NanmiCoder/cc-haha/pulls)
[![License](https://img.shields.io/github/license/NanmiCoder/cc-haha)](https://github.com/NanmiCoder/cc-haha/blob/main/LICENSE)
[![中文](https://img.shields.io/badge/🇨🇳_中文-Available-green)](README.md)
[![English](https://img.shields.io/badge/🇺🇸_English-当前-blue)](README.en.md)
[![Docs](https://img.shields.io/badge/📖_Documentation-Visit-FF7A00)](https://claudecode-haha.relakkesyang.org)

</div>

A Claude Code build repaired from the source leaked from Anthropic's npm registry on 2026-03-31. Claude Code Haha is now primarily a **desktop Claude Code workspace** for macOS, Windows, and Linux: sessions, projects, branch / Worktree launch, workspace changes and diff review, permission approval, model setup, Computer Use, H5 remote access, IM integration, and scheduled tasks in one app.

<p align="center">
  <a href="#desktop-preview">Desktop Preview</a> · <a href="#install-the-desktop-app">Install</a> · <a href="#desktop-highlights">Highlights</a> · <a href="#sponsorship--partnership">Sponsorship</a> · <a href="#more-documentation">More Docs</a>
</p>

---

## Desktop Preview

The Claude Code Haha desktop app brings sessions, multi-project navigation, branch / Worktree controls, file changes, diff review, permission approval, model setup, and remote access into one graphical workspace for daily development beyond the terminal.

v0.5.0 shipped a full UI redesign — six colour themes that can follow your system's light/dark setting. All four shots below are from a real v0.5.0 build.

<p align="center">
  <a href="https://github.com/NanmiCoder/cc-haha/releases"><img src="https://img.shields.io/badge/⬇_Download_Desktop-macOS_%7C_Windows_%7C_Linux-FF7A00?style=for-the-badge" alt="Download Desktop"></a>
  &nbsp;
  <a href="docs/en/start/install.md"><img src="https://img.shields.io/badge/📖_Install_Guide-Guide-gray?style=for-the-badge" alt="Install Guide"></a>
</p>

<table>
  <tr>
    <td align="center" width="50%"><img src="docs/images/app/session-main.webp" alt="Desktop session view"><br><b>Session, tool calls & inline diff</b></td>
    <td align="center" width="50%"><img src="docs/images/app/workspace-diff.webp" alt="Workspace diff review"><br><b>Review every edit, file by file</b></td>
  </tr>
  <tr>
    <td align="center" width="50%"><img src="docs/images/app/session-dark.webp" alt="Session view in the dark theme"><br><b>Six themes, optionally following the system</b></td>
    <td align="center" width="50%"><img src="docs/images/app/skill-market.webp" alt="Skill marketplace"><br><b>Skill marketplace with source and safety labels</b></td>
  </tr>
</table>

---

## Install the Desktop App

1. Download the macOS / Windows / Linux desktop installer from [Releases](https://github.com/NanmiCoder/cc-haha/releases).
2. On first launch, configure your model provider, API key, and default model in Settings.
3. Public macOS releases require signing and notarization. Draft or unsigned temporary builds may still need one-time manual approval. Unsigned Windows installers may show SmartScreen; click "More info" -> "Run anyway". See the [desktop installation guide](docs/en/start/install.md).

## Run the CLI from Source

For users who want to debug the underlying CLI, server, or local development flow:

```bash
bun install
cp .env.example .env
./bin/claude-haha
```

See [environment variables](docs/en/cli/env.md) and [CLI setup](docs/en/cli/index.md) for more configuration options.

---

## Desktop Highlights

- **Multi-session workspace**: tabs, project switching, terminal entry, and session history in one place, with a resizable sidebar.
- **Branch / Worktree launch**: choose a repository branch and decide whether to use the current working tree or an isolated Worktree.
- **Review edits file by file**: the workspace lists this turn's changes; open any file for a syntax-highlighted diff, or undo the whole turn.
- **Five permission modes**: from "ask every time" to "skip permissions" — risky commands, tool calls, and follow-up questions are all approved in the GUI.
- **Bring your own model**: sign in to Claude, ChatGPT, or Grok; use presets for DeepSeek, Kimi, Zhipu GLM and others; or point it at LM Studio and Ollama running locally.
- **Six colour themes**: white, paper, warm classic, celadon, ink night, and ink blue — optionally following your system's light/dark setting.
- **Skill marketplace**: discover, preview, and install third-party skills from ClawHub / SkillHub, with source and safety status shown up front.
- **Session activity panel**: track task progress, background tasks, SubAgents, and sources in one side panel.
- **Computer Use**: let the agent take screenshots, click, type, and control desktop apps after authorization.
- **Desktop pets**: Dada, Huhu, Bubu, and Huihui change what they do with the task at hand — or raise one of your own (off by default).
- **H5 remote access**: scan a QR code to continue the session in your phone browser; locking the screen won't kill a running task.
- **IM integration**: chat, switch projects, and approve actions through Telegram / Feishu / WeChat / DingTalk / WhatsApp.
- **Scheduled tasks and usage stats**: run planned tasks in their own sessions and track local token usage trends.

---

## More Documentation

Full documentation site: <https://claudecode-haha.relakkesyang.org>

| Section | Documents |
|------|------|
| **Getting started** | [What this is](docs/en/start/index.md) · [Download and install](docs/en/start/install.md) · [Connect a model provider](docs/en/start/models.md) · [Your first session](docs/en/start/first-session.md) · [Troubleshooting](docs/en/start/troubleshooting.md) |
| **Desktop features** | [Feature overview](docs/en/desktop/index.md) · [Computer Use](docs/en/desktop/computer-use.md) · [Desktop pets](docs/en/desktop/pets.md) · [Phone H5 and IM relay](docs/en/desktop/remote.md) |
| **IM integrations** | [Overview and pairing](docs/en/im/index.md) · [Feishu](docs/en/im/feishu.md) · [Telegram](docs/en/im/telegram.md) · [WeChat](docs/en/im/wechat.md) · [DingTalk](docs/en/im/dingtalk.md) · [WhatsApp](docs/en/im/whatsapp.md) |
| **CLI** | [Install and run](docs/en/cli/index.md) · [Command reference](docs/en/cli/reference.md) · [Environment variables](docs/en/cli/env.md) |
| **Internals** | [Multi-agent system](docs/en/internals/agent.md) · [Skills system](docs/en/internals/skills.md) · [Memory system](docs/en/internals/memory.md) · [Computer Use architecture](docs/en/internals/computer-use.md) · [Local server and API](docs/en/internals/server.md) · [Channel system](docs/en/internals/channel.md) · [Project structure](docs/en/internals/structure.md) · [Contributing and quality gates](docs/en/internals/contributing.md) |

---

## Sponsorship & Partnership

This project is maintained in the author's spare time. Corporate or individual sponsorships are welcome to support ongoing development. Custom features, integrations, and business partnerships are also open for discussion.

<table>
  <thead>
    <tr>
      <th width="220">Sponsor</th>
      <th align="left">Description</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center" valign="middle">
        <a href="https://jiekou.ai/referral?invited_code=OBNU3K">
          <img src="docs/images/sponsors/jiekou-logo.svg" width="72" alt="JieKou AI"><br>
          <strong>接口AI</strong>
        </a>
      </td>
      <td valign="middle">
        Thanks to <a href="https://jiekou.ai/referral?invited_code=OBNU3K">JieKou AI</a> for sponsoring this project. JieKou AI provides official model resources with stable, high-performance API access. Subscription bundles are priced at 20% off the official rate; new users who register through <a href="https://jiekou.ai/referral?invited_code=OBNU3K">this link</a> and bind GitHub can claim a $3 coupon.
      </td>
    </tr>
    <tr>
      <td align="center" valign="middle">
        <a href="https://www.shengsuanyun.com/?from=CH_LEJ88KWR">
          <img src="docs/images/sponsors/shengsuanyun-logo.svg" width="180" alt="ShengSuanYun">
        </a>
      </td>
      <td valign="middle">
        Thanks to <a href="https://www.shengsuanyun.com/?from=CH_LEJ88KWR">ShengSuanYun</a> for sponsoring this project. ShengSuanYun is an industrial-grade AI task parallel execution platform for AI Native Teams, aggregating Claude, ChatGPT, Gemini, and other LLM, image, and video model capacity through direct, non-reverse-engineered access. Its platform SLA reaches 99.7%, with <a href="https://watch.shengsuanyun.com/status/shengsuanyun">service status</a> available online. It also supports dedicated enterprise gateways, cost and permission controls, smart routing, security protection, BYOK, usage-based billing, upcoming tokens plans, and invoicing. New users registering through <a href="https://www.shengsuanyun.com/?from=CH_LEJ88KWR">this link</a> can receive 10 yuan in model credits plus a 10% first top-up bonus.
      </td>
    </tr>
    <tr>
      <td align="center" valign="middle">
        <a href="https://teamorouter.com/?utm_source=cc_haha&utm_medium=referral&utm_campaign=ai_directory">
          <img src="docs/images/sponsors/teamorouter-logo.svg" width="180" alt="TeamoRouter">
        </a>
      </td>
      <td valign="middle">
        Thanks to <a href="https://teamorouter.com/?utm_source=cc_haha&utm_medium=referral&utm_campaign=ai_directory">TeamoRouter</a> for sponsoring this project. TeamoRouter is an enterprise-grade Agentic LLM gateway for developers, AI teams, and businesses. Without any subscription, it lets you use Claude Code, Codex, Gemini CLI, and other popular AI agents through a single unified API, with API pricing at discounts of up to 90%. It aggregates hundreds of official model providers and trusted infrastructure partners — including OpenAI, Anthropic, Vertex, Azure, and AWS Bedrock — each verified for 100% Agent protocol compatibility, cache performance, and request traceability, delivering near-official TTFT, a 99.6% SLA, throughput up to 5,000 QPM, and industry-leading cache hit rates rather than reverse-engineered endpoints. It also offers centralized billing, team management, BYOK, smart routing, usage analytics, and dedicated support, and Teamo Desktop lets you use these AI agents with one-click setup. New users who register through <a href="https://teamorouter.com/?utm_source=cc_haha&utm_medium=referral&utm_campaign=ai_directory">this link</a> receive 10% off their first top-up.
      </td>
    </tr>
  </tbody>
</table>

📧 **Contact**: relakkes@gmail.com

---

## ☕ Buy Me a Coffee

If this project helps you, consider buying me a coffee — every bit of support keeps this project going ❤️

<table>
<tr>
<td align="center" width="33%">
<img src="docs/images/donate/wechat_pay.jpeg" width="250" alt="WeChat Pay"><br>
<b>WeChat Pay</b>
</td>
<td align="center" width="33%">
<img src="docs/images/donate/zfb_pay.png" width="250" alt="Alipay"><br>
<b>Alipay</b>
</td>
<td align="center" width="33%">
<a href="https://buymeacoffee.com/relakkes" target="_blank">
<img src="docs/images/donate/bmc_button.png" width="250" alt="Buy Me a Coffee">
</a><br>
<b>Buy Me a Coffee</b>
</td>
</tr>
</table>

---

## Tech Stack

| Category | Technology |
|------|------|
| Language | TypeScript |
| Desktop app | Electron |
| Desktop UI | React + Vite |
| Local runtime | [Bun](https://bun.sh) |
| Terminal UI | React + [Ink](https://github.com/vadimdemedes/ink) |
| CLI parsing | Commander.js |
| API | Anthropic SDK |
| Protocols | MCP, LSP |

## Thanks

Thanks to the following open-source projects and community practices for reference and inspiration:

- [React](https://github.com/facebook/react): frontend engineering and component-based UI ecosystem.
- [Electron](https://github.com/electron/electron): cross-platform desktop app capabilities and engineering practices.
- [cc-switch](https://github.com/farion1231/cc-switch): reference for model provider configuration.

---

## ⭐ Star History

If this project helps you, please support it with a ⭐ Star so more people can discover Claude Code Haha.

<a href="https://www.star-history.com/#NanmiCoder/cc-haha&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=NanmiCoder/cc-haha&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=NanmiCoder/cc-haha&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=NanmiCoder/cc-haha&type=Date" />
  </picture>
</a>

---

## Disclaimer

This repository is based on the Claude Code source leaked from the Anthropic npm registry on 2026-03-31. All original source code copyrights belong to [Anthropic](https://www.anthropic.com). It is provided for learning and research purposes only.
