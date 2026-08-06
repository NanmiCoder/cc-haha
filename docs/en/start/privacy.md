---
title: Privacy and network access
nav_title: Privacy
description: What Claude Code Haha stores locally, when it uses the network, and how to remove its data.
order: 6
---

# Privacy and network access

Claude Code Haha is a local-first, open-source development tool. The project itself does not operate a cloud backend that receives session content. The application is not fully offline: when you choose a model provider, MCP server, messaging integration, or update feature, relevant data is sent to the third-party service you selected or configured.

## Data stored locally

The application stores sessions, workspace records, provider configuration, skills, agents, memory, UI settings, and logs on your device. Primary user data lives under `~/.claude`; some desktop state is managed in the operating system's application-data directory. Authentication tokens and API keys are kept locally, but are sent to the selected service when needed to authenticate a request.

## When the application uses the network

Depending on the features you enable, the application may send the following information:

- **Model and OAuth services:** Prompts, attachments, selected code context, tool results, model parameters, and authentication information are sent to the model or account provider you choose.
- **MCP servers and external tools:** Configured MCP servers, search, image generation, and other tools receive the input required to perform the requested operation.
- **Messaging and remote access:** If you enable Telegram, Feishu, WeChat, DingTalk, WhatsApp, or remote H5 access, selected session content, messages, and connection metadata pass through the relevant platform or a relay you configure.
- **Updates:** The application contacts GitHub Releases to check versions and, when requested, download installers.
- **Web links:** Opening documentation, login pages, or other links causes the browser to connect directly to the destination site.
- **Upstream runtime traffic:** The bundled upstream agent runtime may contact diagnostic, analytics, or feature-flag services depending on the provider and configuration. Set `DISABLE_TELEMETRY=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` to reduce or disable nonessential traffic.

Each third-party service processes the data it receives under its own privacy policy. Review the provider's terms before use, and do not send secrets, personal information, or private code to a service you do not trust.

## What the project maintainers do not do

The project maintainers do not sell user data or place advertising based on personal data in the application. The maintainers do not receive locally stored sessions or configuration unless you choose to include them in an issue, discussion, log, or security report.

## Removing data

Uninstalling the application does not automatically delete sessions and configuration under `~/.claude`. To remove local data completely, first back up anything you want to keep, then manually delete `~/.claude` and the Claude Code Haha data in your operating system's application-data directory. To remove data already sent to a third-party service, follow that provider's process.

## Contact

For privacy or security questions, contact the maintainer through a [private GitHub security advisory](https://github.com/NanmiCoder/cc-haha/security/advisories/new) or at [relakkes@gmail.com](mailto:relakkes@gmail.com).

Last updated: August 5, 2026.
