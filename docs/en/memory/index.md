# Claude Code Memory System Documentation

> Complete usage guide and technical implementation documentation for the memory system

---

## Documentation Index

### [01-usage-guide.md](./01-usage-guide.md) — Usage Guide

A comprehensive user-facing manual covering:

- **Four memory types**: User (user profile), Feedback (behavioral feedback), Project (project context), Reference (external references)
- **Four trigger methods**: Automatic extraction, explicit requests, `/memory` command, `/remember` command
- **Storage format**: YAML frontmatter + Markdown content
- **Management operations**: Forgetting, ignoring, manual editing, disabling, custom directories
- **Lifecycle**: From learning to injection, freshness management

**Target audience**: All Claude Code users

---

### [02-implementation.md](./02-implementation.md) — Implementation Details

A deep technical analysis for developers, covering:

- **5 core modules**: Path resolution, prompt construction, memory scanning, intelligent retrieval, automatic extraction
- **Path resolution system**: Priority chain, security validation, enable conditions
- **System prompt injection**: `loadMemoryPrompt()` -> `buildMemoryLines()`, MEMORY.md truncation strategy
- **Automatic memory extraction**: Forked agent, mutual exclusion mechanism, tool permissions, merge mechanism
- **Intelligent retrieval**: `scanMemoryFiles()` -> Sonnet selection -> freshness warnings
- **Agent memory**: Three-level scoping (user/project/local)
- **Team memory sync**: Pull/Push API, merge semantics
- **Complete data flow**: From session startup to context injection

**Target audience**: Contributors, architects, developers who want a deep understanding of the implementation

---

### [03-autodream.md](./03-autodream.md) — AutoDream Memory Consolidation

Claude's "dreaming" mechanism -- a deep dive into background silent memory consolidation, covering:

- **Core concept**: Like how the human brain organizes memories during sleep, periodically reviewing multiple sessions to consolidate knowledge
- **Five-gate check**: Feature toggle -> Time gate (24h) -> Scan throttle (10min) -> Session gate (5 sessions) -> Lock gate
- **Four-phase process**: Orient -> Gather -> Consolidate -> Prune
- **Security restrictions**: Read-only Bash, write operations limited to memory directory, PID lock file mutual exclusion
- **UI presentation**: Bottom "dreaming" label, Shift+Down detail dialog, completion notification
- **Configuration control**: settings.json local toggle + GrowthBook remote feature flag
- **Comparison with extractMemories**: Taking notes during the day vs. organizing the notebook while sleeping

**Target audience**: Contributors, architects, developers interested in Claude's automated memory management

---

## Illustrations

All illustrations use a dark background (#1a1a2e) + Anthropic brand copper-orange (#D97757) style, consistent with the official Claude Code documentation.

| Image | Description | Size |
|-------|-------------|------|
| `01-memory-overview.png` | Memory system overview -- four-layer architecture (trigger/type/storage/retrieval) | 632 KB |
| `02-memory-types.png` | Four memory types -- 2x2 grid showing User/Feedback/Project/Reference | 507 KB |
| `03-memory-trigger.png` | Memory trigger flow -- four paths from conversation to storage | 474 KB |
| `04-memory-lifecycle.png` | Memory lifecycle -- complete cycle flow + freshness checks | 1.0 MB |
| `05-architecture-overview.png` | Implementation architecture overview -- 5 core modules + auxiliary modules | 3.5 MB |
| `06-path-resolution.png` | Path resolution flow -- three-level priority + security validation | 1.0 MB |
| `07-prompt-injection.png` | Prompt injection flow -- loadMemoryPrompt dispatch logic | 1.1 MB |
| `08-auto-extraction.png` | Auto-extraction flow -- forked agent complete process | 1.2 MB |
| `09-memory-retrieval.png` | Intelligent retrieval flow -- Sonnet selection + freshness management | 816 KB |
| `10-agent-memory.png` | Agent memory scoping -- three-level nested structure | 523 KB |
| `11-autodream-overview.png` | AutoDream overview -- dreaming mechanism core architecture and human sleep analogy | 777 KB |
| `12-autodream-trigger.png` | AutoDream trigger flow -- five-gate check chain | 493 KB |
| `13-autodream-phases.png` | AutoDream four phases -- Orient/Gather/Consolidate/Prune | 602 KB |

---

## Quick Start

### For Users

1. Read the [Usage Guide](./01-usage-guide.md)
2. Learn about the four memory types and trigger methods
3. Try the `/memory` and `/remember` commands

### For Developers

1. Read the [Implementation Details](./02-implementation.md)
2. Explore the source code:
   - `src/memdir/paths.ts` -- Path resolution
   - `src/memdir/memdir.ts` -- Prompt construction
   - `src/memdir/memoryScan.ts` -- Memory scanning
   - `src/memdir/findRelevantMemories.ts` -- Intelligent retrieval
   - `src/services/extractMemories/` -- Automatic extraction
3. Understand the data flow and module interactions

---

## Core Concepts Quick Reference

| Concept | Description |
|---------|-------------|
| **MEMORY.md** | Index file, always loaded into context (max 200 lines / 25KB) |
| **Topic files** | `*.md` files containing frontmatter + content |
| **Auto-extraction** | Runs in the background after each response; a forked agent analyzes the conversation |
| **AutoDream** | Triggers after 24h + 5 sessions; consolidates/deduplicates/prunes all memories in the background |
| **Intelligent retrieval** | Sonnet model selects up to 5 relevant memories from the entire collection |
| **Freshness** | <=1 day: no warning; >1 day: stale warning attached |
| **Forked agent** | Shares prompt cache, restricted tool permissions, max 5 turns |
| **Three-level scoping** | Agent memory: user (global) > project (project-level) > local (local-level) |

---

## Related Resources

- [Claude Code Haha Home](/en/)
- [Memory system source code](https://github.com/NanmiCoder/cc-haha/tree/main/src/memdir/)
- [Auto-extraction service](https://github.com/NanmiCoder/cc-haha/tree/main/src/services/extractMemories/)
- [AutoDream service](https://github.com/NanmiCoder/cc-haha/tree/main/src/services/autoDream/)
- [DreamTask](https://github.com/NanmiCoder/cc-haha/tree/main/src/tasks/DreamTask/)
- [GitHub Issues](https://github.com/NanmiCoder/cc-haha/issues)
