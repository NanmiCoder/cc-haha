# Claude Code Channel System Documentation

> Complete technical analysis of remote Agent control via IM platforms

---

## Documentation

### [01-channel-system.md](./01-channel-system.md) — Channel System Architecture

A deep dive into the design and implementation of Claude Code's Channel system from a source code perspective, covering:

- **What is a Channel**: Core concepts of IM integration, MCP protocol foundations
- **Architecture Overview**: End-to-end message flow, component relationships
- **Message Protocol**: Inbound notifications, XML wrapping, outbound tool calls
- **Six-Layer Access Control**: Capability → Runtime gate → OAuth → Org policy → Session allowlist → Plugin approval
- **Permission Relay System**: Remote tool execution approval, 5-letter request IDs, multi-source racing
- **Plugin Architecture**: Channel manifest declarations, user config flow, scoped naming
- **UI Components**: Terminal message rendering, status notices, developer warning dialogs
- **Security Design**: XML injection prevention, marketplace verification, trust boundary analysis

**Target audience**: Developers, architects, and plugin authors interested in AI Agent IM integration architecture

---

## Illustrations

All illustrations use dark background (#1a1a2e) with Anthropic brand copper-orange (#D97757) accent color.

| Image | Description | Document |
|-------|-------------|----------|
| `01-channel-overview.png` | Channel system architecture overview | Architecture |
| `02-message-flow.png` | End-to-end message flow: IM → Agent → IM | Architecture |
| `03-access-control.png` | Six-layer access control gates | Architecture |
| `04-permission-relay.png` | Permission relay system flow | Architecture |

---

## Quick Start

### Users

1. Read the [Channel System Architecture](./01-channel-system.md)
2. Learn how to start IM integration with `--channels`
3. Understand how different platforms (Telegram, Feishu, Discord) connect

### Plugin Developers

1. Read the [Plugin Architecture](./01-channel-system.md#7-plugin-channel-architecture) section
2. Understand the `plugin.json` Channel declaration format
3. Implement the MCP Server `notifications/claude/channel` protocol
4. Key source files:
   - `src/services/mcp/channelNotification.ts` — Core gating and message wrapping
   - `src/services/mcp/channelPermissions.ts` — Permission relay system
   - `src/services/mcp/channelAllowlist.ts` — Allowlist management
   - `src/utils/plugins/mcpPluginIntegration.ts` — Plugin MCP integration
   - `src/utils/plugins/schemas.ts` — Plugin manifest Channel schema

---

## Core Concepts Reference

| Concept | Description |
|---------|-------------|
| **Channel** | An MCP Server declaring `claude/channel` capability that can push IM messages to the Agent |
| **Channel Entry** | Parsed `--channels` argument entry, either plugin or server kind |
| **Channel Gate** | Six-layer access control gate deciding whether to register notification handlers |
| **Permission Relay** | Mechanism for forwarding tool execution approval prompts to IM platforms |
| **Channel Plugin** | A plugin declaring `channels` field in its `plugin.json` |
| **Scoped Name** | Plugin server name with scope prefix: `plugin:{pluginName}:{serverName}` |
| **Short Request ID** | 5-letter permission request identifier generated via FNV-1a hash |
| **Channel Tag** | `<channel>` XML tag wrapping IM message content and metadata |
| **Dev Channels** | Channels loaded via `--dangerously-load-development-channels` for local development |
| **tengu_harbor** | GrowthBook runtime feature flag controlling the Channel system master switch |

---

## Related Resources

- [Claude Code Haha Home](/en/)
- [Agent Framework Deep Dive](/en/agent/03-agent-framework)
- [Skills System Documentation](/en/skills/01-usage-guide)
- [GitHub Issues](https://github.com/NanmiCoder/cc-haha/issues)
