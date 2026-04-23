# Claude Code Memory System — Implementation Details

> From system prompt injection to background auto-extraction, dissecting every technical detail of the memory system.

<p align="center">
<a href="#1-overall-architecture">Architecture</a> · <a href="#2-path-resolution-system">Path Resolution</a> · <a href="#3-system-prompt-injection">Prompt Injection</a> · <a href="#4-automatic-memory-extraction">Auto-Extraction</a> · <a href="#5-intelligent-memory-retrieval">Intelligent Retrieval</a> · <a href="#6-memory-scanning-in-detail">Memory Scanning</a> · <a href="#7-agent-memory">Agent Memory</a> · <a href="#8-team-memory-sync">Team Sync</a> · <a href="#9-key-constants-quick-reference">Constants</a> · <a href="#10-data-flow-overview">Data Flow</a>
</p>

![Implementation Architecture Overview](./images/05-architecture-overview.png)

---

## 1. Overall Architecture

The memory system is powered by 5 core modules working in concert:

| Module | Source Location | Responsibility |
|--------|----------------|----------------|
| **Path Resolution** | `src/memdir/paths.ts` | Computes memory storage directory, handles overrides and security validation |
| **Prompt Construction** | `src/memdir/memdir.ts` | Injects memory instructions into the system prompt |
| **Memory Scanning** | `src/memdir/memoryScan.ts` | Scans directories, parses frontmatter, sorts entries |
| **Intelligent Retrieval** | `src/memdir/findRelevantMemories.ts` | Uses Sonnet to select memories relevant to the current query |
| **Auto-Extraction** | `src/services/extractMemories/` | Background forked agent that extracts memories from conversations |

Auxiliary modules:

| Module | Source Location | Responsibility |
|--------|----------------|----------------|
| **AutoDream** | `src/services/autoDream/` | Background memory consolidation ("dreaming"); see [03-autodream.md](./03-autodream.md) |
| **Type Definitions** | `src/memdir/memoryTypes.ts` | Taxonomy and prompt templates for the four memory types |
| **Freshness** | `src/memdir/memoryAge.ts` | Calculates memory age, generates stale warnings |
| **File Detection** | `src/utils/memoryFileDetection.ts` | Determines whether a path belongs to the memory system |
| **Agent Memory** | `src/tools/AgentTool/agentMemory.ts` | Three-level memory directories exclusive to sub-agents |
| **Team Sync** | `src/services/teamMemorySync/` | Remote upload/download of memories |

---

## 2. Path Resolution System

![Path Resolution Flow](./images/06-path-resolution.png)

### Core Function: `getAutoMemPath()`

```
Path resolution priority (highest to lowest):

1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE  <- Cowork environment variable (full path)
2. settings.json -> autoMemoryDirectory <- User setting (supports ~/ expansion)
3. {memoryBase}/projects/{sanitized-git-root}/memory/  <- Default computed path
```

**Key source** `src/memdir/paths.ts:223`:

```typescript
export const getAutoMemPath = memoize(
  (): string => {
    const override = getAutoMemPathOverride() ?? getAutoMemPathSetting()
    if (override) return override
    const projectsDir = join(getMemoryBaseDir(), 'projects')
    return join(projectsDir, sanitizePath(getAutoMemBase()), AUTO_MEM_DIRNAME) + sep
  },
  () => getProjectRoot(),  // Cache key = project root
)
```

### Path Security Validation

`validateMemoryPath()` rejects dangerous paths:

| Rejected Path | Reason |
|---------------|--------|
| `../foo` | Relative path, CWD-dependent |
| `/` or `/a` | Root path or too-short path |
| `C:\` | Windows drive root |
| `\\server\share` | UNC network path |
| Contains `\0` | Null byte, can truncate in system calls |

**Security restriction**: Project-level `.claude/settings.json` is **not allowed** to set `autoMemoryDirectory`, preventing malicious repositories from gaining write access to sensitive directories like `~/.ssh`.

### Enable Conditions

The `isAutoMemoryEnabled()` check chain:

```
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1  -> Disabled
CLAUDE_CODE_SIMPLE (--bare)        -> Disabled
Remote mode without REMOTE_MEMORY_DIR -> Disabled
settings.json autoMemoryEnabled    -> Follows setting
Default                            -> Enabled
```

---

## 3. System Prompt Injection

![Prompt Injection Flow](./images/07-prompt-injection.png)

### Entry Point: `loadMemoryPrompt()`

This is the interface between the memory system and the system prompt. It is called once at startup (cached via `systemPromptSection`).

```
loadMemoryPrompt()
  |-- KAIROS mode?    -> buildAssistantDailyLogPrompt()  [log append mode]
  |-- TEAMMEM enabled? -> buildCombinedMemoryPrompt()    [personal + team dual directory]
  |-- Normal mode     -> buildMemoryLines()               [single directory]
  |-- Disabled        -> return null
```

### Prompt Structure Built by `buildMemoryLines()`

```
# auto memory

You have a persistent file-based memory system located at `{memoryDir}`...

## Types of memory          <- Definitions and examples for all four types
## What NOT to save         <- Exclusion rules
## How to save memories     <- Two-step saving process
## When to access memories  <- When to consult
## Before recommending      <- Verify before citing
## Memory and other forms   <- Distinction from Plan/Task

## MEMORY.md                <- Index content (or "currently empty")
```

### MEMORY.md Truncation Strategy

`truncateEntrypointContent()` applies dual limits:

```typescript
// First truncate by line count
if (lineCount > 200) -> Truncate to 200 lines

// Then truncate by byte size (handles extra-long lines)
if (bytes > 25,000) -> Truncate at last newline character

// Append warning
"WARNING: MEMORY.md is {reason}. Only part of it was loaded."
```

### Automatic Directory Creation

`ensureMemoryDirExists()` ensures the directory exists when loading the prompt:
- Recursively creates with `mkdir` (handles the entire parent chain)
- Swallows `EEXIST` (idempotent)
- Genuine permission errors are only logged, not thrown (the Write tool will surface the real error)

The prompt explicitly tells the model the directory already exists, avoiding wasted turns on `ls` or `mkdir`.

---

## 4. Automatic Memory Extraction

![Auto-Extraction Flow](./images/08-auto-extraction.png)

### Trigger Timing

Triggered in `handleStopHooks` when the model produces a final response (no tool calls).

**Key source**: `src/services/extractMemories/extractMemories.ts`

### Complete Extraction Flow

```
1. Model finishes response (no tool_use)
   |
2. executeExtractMemories() is called
   |
3. Guard checks:
   - Is this the main agent? (sub-agents don't extract)
   - Feature gate enabled?
   - Auto-memory enabled?
   - Not in remote mode?
   - No parallel extraction in progress?
   |
4. Frequency control:
   turnsSinceLastExtraction++
   if < tengu_bramble_lintel -> skip
   |
5. Mutual exclusion check:
   Main agent wrote memory itself? -> skip, advance cursor
   |
6. Scan existing memory directory (scanMemoryFiles)
   Generate manifest (formatMemoryManifest)
   |
7. Build extraction prompt (buildExtractAutoOnlyPrompt)
   |
8. Run forked agent (runForkedAgent)
   - Shares parent session's prompt cache
   - Max 5 turns
   - Restricted tool permissions
   |
9. Extract written file paths
   Advance cursor to latest message
   |
10. Notify user: "Memory updated in ..."
```

### Forked Agent

Auto-extraction uses `runForkedAgent` -- a perfect fork of the main session:

- **Shared prompt cache**: Avoids duplicate API cache creation costs
- **Isolated execution**: Does not affect the main session's message history
- **Restricted tools**: Only allows Read, Grep, Glob, read-only Bash, and Edit/Write within the memory directory
- **No transcript recording**: Prevents race conditions with the main thread

### Tool Permissions (`createAutoMemCanUseTool`)

```
Allowed: Read, Grep, Glob (unrestricted)
Allowed: Bash (read-only commands only: ls, find, grep, cat, stat...)
Allowed: Edit/Write (only within auto-memory directory)
Denied: MCP, Agent, non-read-only Bash, other write operations
```

### Mutual Exclusion Mechanism

The main agent and the extraction agent are **mutually exclusive**:

```typescript
function hasMemoryWritesSince(messages, sinceUuid): boolean {
  // Scan all assistant messages after sinceUuid
  // If any Edit/Write tool_use targets the auto-memory directory
  // -> return true (skip extraction, advance cursor)
}
```

This prevents duplicate saves: when the main agent has already written a memory, the background extraction is skipped.

### Merge Mechanism

If a previous extraction is still running:
1. The new context is queued (`pendingContext`)
2. After the old extraction completes, a **tail extraction** is immediately launched
3. The tail extraction only processes messages added between the two calls

---

## 5. Intelligent Memory Retrieval

![Memory Retrieval Flow](./images/09-memory-retrieval.png)

### How It Works

Each time the user sends a query, `findRelevantMemories()` is triggered:

```
1. scanMemoryFiles(memoryDir)
   - Recursively reads all .md files (excludes MEMORY.md)
   - Parses frontmatter (first 30 lines)
   - Sorts by modification time in descending order
   - Max 200 files
   |
2. Filter out previously surfaced memories (alreadySurfaced)
   |
3. Format manifest (formatMemoryManifest)
   - [type] filename (ISO timestamp): description
   |
4. Sonnet model selection (sideQuery)
   - System prompt: You are a memory selector...
   - User message: Query + Available memories + Recently used tools
   - Output: JSON { selected_memories: string[] }
   - Max 5 selections
   |
5. Return selected memories as { path, mtimeMs }
```

### Sonnet Selector Prompt

```
You are selecting memories useful for Claude Code to handle the user's query.
You'll receive the user's query and a list of available memory files (with filenames and descriptions).

Return at most 5 memory filenames that are clearly useful.
- If uncertain whether something is useful, don't select it
- If nothing is clearly useful, return an empty list
- If a list of recently used tools is provided, don't select usage docs for those tools
  (but DO select warnings/gotchas/known issues about those tools)
```

### Freshness Warning

Selected memories are injected into the context with freshness information:

```typescript
function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d <= 1) return ''  // Today/yesterday: no warning
  return `This memory is ${d} days old. Memories are point-in-time observations...
          Verify against current code before asserting as fact.`
}
```

---

## 6. Memory Scanning in Detail

### `scanMemoryFiles()`

**Key design**: Single-pass (read-then-sort) to avoid double stat system calls.

```typescript
async function scanMemoryFiles(memoryDir, signal): Promise<MemoryHeader[]> {
  const entries = await readdir(memoryDir, { recursive: true })
  const mdFiles = entries.filter(f => f.endsWith('.md') && basename(f) !== 'MEMORY.md')

  // Read all files' frontmatter in parallel (first 30 lines)
  const headerResults = await Promise.allSettled(
    mdFiles.map(async (relativePath) => {
      const { content, mtimeMs } = await readFileInRange(filePath, 0, 30)
      const { frontmatter } = parseFrontmatter(content)
      return { filename, filePath, mtimeMs, description, type }
    })
  )

  // Filter successful results, sort by time descending, take first 200
  return fulfilled.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 200)
}
```

### `formatMemoryManifest()`

Generates a manifest consumed by Sonnet or the extraction agent:

```
- [feedback] testing_policy.md (2026-03-15T10:30:00.000Z): Integration tests use real DB
- [user] role.md (2026-03-14T08:00:00.000Z): Data scientist, focused on logging
- [project] freeze.md (2026-03-10T15:00:00.000Z): Merge freeze starting 3/5
```

---

## 7. Agent Memory

![Agent Memory Three-Level Scoping](./images/10-agent-memory.png)

Sub-agents (launched via the Agent tool) have an independent three-level memory system:

| Scope | Path | Description |
|-------|------|-------------|
| **user** | `~/.claude/agent-memory/{agentType}/` | Global user-level |
| **project** | `.claude/agent-memory/{agentType}/` | Project-level (committed to VCS) |
| **local** | `.claude/agent-memory-local/{agentType}/` | Local-level (not committed) |

Differences from main memory:
- No MEMORY.md index step (`skipIndex = true`)
- Files can be written directly without the two-step process
- Each agent type is isolated (explorer, planner, etc. each have their own directory)

---

## 8. Team Memory Sync

When the `TEAMMEM` feature flag is enabled:

### Directory Structure

```
~/.claude/projects/{hash}/memory/
├── MEMORY.md           <- Personal memory index
├── user_*.md           <- Personal memories
└── team/               <- Team shared directory
    ├── MEMORY.md       <- Team memory index
    └── *.md            <- Team memories
```

### Sync API

```
GET  /api/claude_code/team_memory?repo={owner/repo}  <- Pull
PUT  /api/claude_code/team_memory?repo={owner/repo}  <- Push
```

### Sync Semantics

- **Pull**: Server content overwrites local files
- **Push**: Only uploads keys with different content hashes (delta upload)
- **Deletes don't propagate**: Local deletions do not delete remote entries
- **Limits**: Single file max 250KB, upload body max 200KB (batched)

### Team vs. Personal Routing Rules

In `memoryTypes.ts`, each type has a `<scope>` directive:

| Type | Default Scope |
|------|---------------|
| user | Always personal |
| feedback | Personal by default; project-level conventions go to team |
| project | Leans toward team |
| reference | Usually team |

---

## 9. Key Constants Quick Reference

```typescript
// Index file
ENTRYPOINT_NAME = 'MEMORY.md'
MAX_ENTRYPOINT_LINES = 200
MAX_ENTRYPOINT_BYTES = 25_000

// Scanning
MAX_MEMORY_FILES = 200
FRONTMATTER_MAX_LINES = 30

// Path
AUTO_MEM_DIRNAME = 'memory'

// Extraction
maxTurns = 5  // Forked agent max 5 turns

// Retrieval
Max 5 relevant memories returned
```

---

## 10. Data Flow Overview

```
┌─────────────────────────────────────────────────────┐
│                  Session Startup                     │
│                                                      │
│  loadMemoryPrompt()                                  │
│    -> ensureMemoryDirExists()                        │
│    -> buildMemoryLines() + MEMORY.md content         │
│    -> Inject into system prompt                      │
└────────────────────────┬────────────────────────────┘
                         |
┌─────────────────────────────────────────────────────┐
│                    User Query                        │
│                                                      │
│  findRelevantMemories()                              │
│    -> scanMemoryFiles() [scan + frontmatter]         │
│    -> Sonnet selects up to 5 relevant memories       │
│    -> Inject into conversation context               │
│       + freshness warnings                           │
└────────────────────────┬────────────────────────────┘
                         |
┌─────────────────────────────────────────────────────┐
│                  Claude's Response                    │
│                                                      │
│  Model may write memories directly                   │
│  (following system prompt guidance)                  │
│  Or not -> triggers background extraction            │
└────────────────────────┬────────────────────────────┘
                         |
┌─────────────────────────────────────────────────────┐
│            Background Auto-Extraction                │
│                                                      │
│  executeExtractMemories()                            │
│    -> Mutual exclusion check                         │
│       (main agent already wrote? skip)               │
│    -> Build extraction prompt + memory manifest      │
│    -> runForkedAgent()                               │
│       [shared cache, restricted tools, 5 turns]      │
│    -> Write new memory files + update MEMORY.md      │
│    -> Notify user                                    │
└────────────────────────┬────────────────────────────┘
                         |
┌─────────────────────────────────────────────────────┐
│       Background Memory Consolidation (AutoDream)    │
│                                                      │
│  executeAutoDream()                                  │
│  [triggers every 24h + 5 sessions]                   │
│    -> Five-gate check                                │
│       (toggle/time/throttle/session/lock)            │
│    -> buildConsolidationPrompt()                     │
│    -> runForkedAgent()                               │
│       [read-only Bash, memory-dir writes only]       │
│    -> Four phases:                                   │
│       Orient -> Gather -> Consolidate -> Prune       │
│    -> Merge duplicates / fix stale / compress index  │
│    -> Notify user: "Improved N memories"             │
│                                                      │
│  See 03-autodream.md for details                     │
└─────────────────────────────────────────────────────┘
```
