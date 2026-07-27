---
title: Architecture Overview
nav_title: Architecture
description: How the five layers divide the work, how one message flows through them, and which page to read for the change you want to make.
order: 0
---

# Architecture Overview

Claude Code Haha looks like one desktop app, but it is five pieces of code that each run on their own. Before reading source or opening a PR, get the boundaries straight — every other page in this section lives inside one of them.

```text
desktop/src/          Frontend — React + Zustand. Draws the UI, touches no native capability.
desktop/electron/     Desktop shell — Electron main process: windows, updates, terminals, native preview.
src/server/           Local server — REST + WebSocket on Bun.serve, shared by desktop and phone.
src/                  CLI core — agent loop, tool system, permissions, memory, skills.
adapters/             IM bridges — one sidecar per platform, all wired back to the same sessions.
```

Three facts are worth holding onto:

- **The CLI core is the only thing that executes.** Every desktop session makes the server spawn a CLI subprocess; every button in the frontend eventually becomes a message sent to it.
- **The local server is the only entry point.** Desktop, mobile H5, and IM adapters share one REST and WebSocket surface — they differ only in how much they are trusted.
- **Electron is the current desktop path.** `desktop/src-tauri/` keeps packaging assets and historical code as a rollback option; it is not the runtime.

## How the CLI core is layered

![The layered structure of the CLI core](../../images/01-overall-architecture.png)

After bootstrap, the entry layer splits in two. On the left is the path that carries one request to completion: terminal UI, query engine, tool system, subagents. On the right are the cross-cutting capabilities that path calls into: state management, skills and plugins, and the service layer holding MCP, OAuth, and memory. The desktop app replaces the terminal UI box and reuses everything else as-is.

## What happens to one message

![The lifecycle of a single request](../../images/02-request-lifecycle.png)

Input is parsed, context is assembled, and the request goes to the model. The moment a tool call appears in the stream, it passes a permission check before it runs; the result is folded back into the context and the next turn starts, until the model stops asking for tools. The tool cards and permission prompts you see in the desktop app are two nodes of this path, rendered.

## How tools and permissions relate

![The tool system and its permission gate](../../images/03-tool-system.png)

Every tool registers in one registry, grouped by capability: files, shell, system, subagents, external integrations, and communication. The fixed pipeline underneath is what actually defines the safety boundary — any call passes argument validation and the permission gate before it reaches the sandbox. Adding a tool to the registry is easy; deciding which side of that gate it belongs on is the real work.

## I want to change X — where do I start

| What you want to touch | Start here |
|---|---|
| Windows, tray, auto-update, embedded terminal, native preview | [Desktop architecture](./desktop.md) |
| REST endpoints, WebSocket events, auth, provider proxy | [Local server and API](./server.md) |
| You cannot find which directory a feature lives in | [Project structure](./structure.md) |
| Subagent behavior, built-in agents, Agent Teams | [Multi-agent usage guide](./agent.md) |
| Spawn paths, tool pool filtering, the background task engine | [Multi-agent internals](./agent-internals.md) |
| The agent loop, system prompts, context compression | [Agent framework deep dive](./agent-framework.md) |
| Writing skills, source precedence, activation | [Skills usage guide](./skills.md) |
| Skill discovery, injection, fork execution | [Skills internals](./skills-internals.md) |
| Where memories live and when they are written | [Memory system usage guide](./memory.md) |
| Memory injection, extraction, retrieval, team sync | [Memory system internals](./memory-internals.md) |
| Background memory consolidation | [AutoDream memory consolidation](./autodream.md) |
| Screen control tools, authorization, coordinate mapping | [Computer Use architecture](./computer-use.md) |
| IM message protocol, access control, permission relay | [Channel system](./channel.md) |
| What to run before a PR, and the release process | [Contributing and quality gates](./contributing.md) |
| Running the CLI in a terminal or from a script | [CLI install and run](../cli/index.md) |

Product features are covered elsewhere — start from [Get started](../start/index.md) and [Desktop features](../desktop/index.md).
