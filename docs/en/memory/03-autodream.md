# Claude Code Memory System — AutoDream Memory Consolidation

> Claude "dreams" -- silently reviewing recent sessions in the background to consolidate, update, and prune memories, much like the human brain organizes memories during sleep.

<p align="center">
<a href="#1-what-is-autodream">AutoDream</a> · <a href="#2-trigger-conditions">Trigger Conditions</a> · <a href="#3-four-phase-consolidation-process">Consolidation Process</a> · <a href="#4-security-restrictions">Security</a> · <a href="#5-ui-presentation">UI</a> · <a href="#6-configuration-and-toggles">Configuration</a> · <a href="#7-relationship-with-extractmemories">Comparison</a> · <a href="#8-source-code-navigation">Source Code</a>
</p>

![AutoDream Overview](./images/11-autodream-overview.png)

---

## 1. What Is AutoDream?

AutoDream is Claude Code's **background memory consolidation mechanism**, internally codenamed **"Dream: Memory Consolidation"**.

Core metaphor:

| Human | Claude Code |
|-------|-------------|
| Jotting down notes throughout the day | `extractMemories` -- extracts new memories after each conversation |
| Organizing the notebook while sleeping | `autoDream` -- periodically reviews multiple sessions to consolidate all memories |

When you're inactive (default interval: 24 hours with 5 accumulated sessions), Claude silently launches a **"dreaming" sub-agent** (forked subagent) in the background. It reviews all recent session transcripts and consolidates scattered memories into structured, deduplicated, up-to-date persistent knowledge.

**Key source**: `src/services/autoDream/autoDream.ts`

```typescript
// Background memory consolidation. Fires the /dream prompt as a forked
// subagent when time-gate passes AND enough sessions have accumulated.
```

---

## 2. Trigger Conditions

![AutoDream Trigger Flow](./images/12-autodream-trigger.png)

AutoDream uses a **five-gate** mechanism, checking in order of increasing cost:

### Gate Chain

| # | Gate | Description | Cost |
|---|------|-------------|------|
| 1 | **Feature toggle** | `isAutoDreamEnabled()` + not KAIROS + not remote mode + autoMemory enabled | Memory read |
| 2 | **Time gate** | At least `minHours` since last consolidation (default 24h) | 1 stat call |
| 3 | **Scan throttle** | At least 10 minutes since last scan before rescanning | Timestamp comparison |
| 4 | **Session gate** | At least `minSessions` new sessions since last consolidation (default 5, excluding current) | Directory scan |
| 5 | **Lock gate** | No other process currently dreaming (PID lock file) | stat + read |

**Key source** `src/services/autoDream/autoDream.ts:63-66`:

```typescript
const DEFAULTS: AutoDreamConfig = {
  minHours: 24,      // At least 24 hours since last consolidation
  minSessions: 5,    // At least 5 sessions accumulated in the interim
}
```

### Scan Throttle

When the time gate passes but the session gate doesn't, the lock file's mtime remains unchanged, causing the time gate to pass on every subsequent turn. To avoid frequent directory scans, a **10-minute scan throttle** is in place:

```typescript
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000
```

### Execution Entry Point

AutoDream is triggered during the stop hook phase after each AI response (fire-and-forget, does not block the main thread):

**Key source** `src/query/stopHooks.ts:154-156`:

```typescript
if (!toolUseContext.agentId) {
  void executeAutoDream(stopHookContext, toolUseContext.appendSystemMessage)
}
```

### Blocking Conditions

AutoDream will not trigger in the following situations:

- **KAIROS mode**: Uses a separate disk-skill dream
- **Remote mode**: `getIsRemoteMode() === true`
- **autoMemory not enabled**
- **`--bare` / SIMPLE mode**
- **Inside a sub-agent**: Only the main agent triggers it

---

## 3. Four-Phase Consolidation Process

![AutoDream Four Phases](./images/13-autodream-phases.png)

Once all gates pass, AutoDream launches a **forked sub-agent** that operates according to the 4-phase prompt defined in `consolidationPrompt.ts`:

### Phase 1 -- Orient

```
- ls the memory directory, see existing files
- Read MEMORY.md index, understand the current knowledge structure
- Browse existing topic files to avoid creating duplicates
- If logs/ or sessions/ subdirectories exist, check recent entries
```

### Phase 2 -- Gather Recent Signal

Collects information in order of priority (highest first):

1. **Daily logs** -- `logs/YYYY/MM/YYYY-MM-DD.md` (append-stream logs)
2. **Drifted memories** -- Old facts that contradict the current codebase state
3. **Session transcript search** -- Narrow-scope `grep` searches in JSONL transcript files

```
Don't exhaustively read transcript files. Only look for content you already suspect is important.
```

### Phase 3 -- Consolidate

- **Merge** new signals into existing topic files (rather than creating new near-duplicate files)
- **Convert** relative dates to absolute dates ("yesterday" -> "2026-04-03")
- **Delete** old facts that have been superseded

### Phase 4 -- Prune and Index

- Update `MEMORY.md`, keeping it within the line limit and <= 25KB
- Remove pointers to outdated memories
- Compress verbose entries (index lines >200 characters have their content moved into topic files)
- Add pointers to important memories
- Resolve conflicts (when two files disagree, fix the incorrect one)

**Key source**: `src/services/autoDream/consolidationPrompt.ts:10-64`

---

## 4. Security Restrictions

The AutoDream sub-agent operates under strict tool permission constraints:

### Bash: Read-Only Only

```
Allowed: ls, find, grep, cat, stat, wc, head, tail
Denied: All write, redirect, or state-modifying commands
```

### File Operations: Memory Directory Only

`createAutoMemCanUseTool()` is the permission function shared by both `extractMemories` and `autoDream`:

```
Allowed: Read / Grep / Glob -- unrestricted
Allowed: Edit / Write -- only within the auto-memory directory
Denied: MCP / Agent / non-read-only Bash / other write operations
```

**Key source**: `src/services/extractMemories/extractMemories.ts:167-171`

### Lock File Mechanism

Uses a `.consolidate-lock` file for process-level mutual exclusion:

| Mechanism | Description |
|-----------|-------------|
| **Lock content** | PID of the holder |
| **Timestamp** | Lock file mtime = time of last consolidation |
| **Expiry** | Held for more than 1 hour is considered expired (prevents PID reuse issues) |
| **Contention** | Two processes write simultaneously -> last writer wins, loser exits on re-read |
| **Rollback** | On failure, mtime is rolled back to the pre-acquisition value so the next attempt is unaffected |
| **Crash recovery** | Stale mtime + dead PID -> next process reclaims the lock |

**Key source**: `src/services/autoDream/consolidationLock.ts`

---

## 5. UI Presentation

### Bottom Status Bar

When AutoDream is running, the bottom status bar displays a **"dreaming"** label:

```typescript
// src/tasks/pillLabel.ts:61-62
case 'dream':
  return 'dreaming'
```

### Task Detail Dialog

Users can press `Shift+Down` to open the background task dialog and view real-time dream progress:

- **DreamDetailDialog** component displays:
  - Number of sessions being reviewed
  - Current phase: `starting` (analyzing) -> `updating` (modifying memory files)
  - Latest assistant text response and tool call count
  - List of file paths touched

- **Users can press `x` to terminate** an ongoing dream (triggers abort + lock rollback)

### Completion Notification

After the dream completes, if files were modified, an inline notification appears in the main session:

```typescript
appendSystemMessage({
  ...createMemorySavedMessage(dreamState.filesTouched),
  verb: 'Improved',
})
```

**Key source**:
- `src/tasks/DreamTask/DreamTask.ts` -- Task state management
- `src/components/tasks/DreamDetailDialog.tsx` -- UI component

---

## 6. Configuration and Toggles

### settings.json

```json
{
  "autoDreamEnabled": true
}
```

- **When explicitly set**: Uses the user's value directly
- **When not set**: Controlled by the remote GrowthBook feature flag `tengu_onyx_plover`

**Key source** `src/services/autoDream/config.ts:13-21`:

```typescript
export function isAutoDreamEnabled(): boolean {
  const setting = getInitialSettings().autoDreamEnabled
  if (setting !== undefined) return setting
  const gb = getFeatureValue_CACHED_MAY_BE_STALE<{ enabled?: unknown } | null>(
    'tengu_onyx_plover', null,
  )
  return gb?.enabled === true
}
```

### Remote Configuration Parameters

The `tengu_onyx_plover` feature flag can configure:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | -- | Master feature toggle |
| `minHours` | number | 24 | Minimum interval (hours) |
| `minSessions` | number | 5 | Minimum session count |

### Manual Trigger: `/dream`

In addition to automatic triggering, users can manually trigger memory consolidation via the `/dream` command. Manual triggers call `recordConsolidation()` to update the lock file timestamp.

---

## 7. Relationship with extractMemories

| Dimension | extractMemories | autoDream |
|-----------|----------------|-----------|
| **Trigger frequency** | After each conversation turn | Every 24h + 5 sessions |
| **Trigger location** | `stopHooks.ts` L149 | `stopHooks.ts` L155 |
| **Processing scope** | Recent messages from the current conversation | Historical transcripts from multiple sessions |
| **Goal** | Extract new memories | Consolidate/deduplicate/prune existing memories |
| **Human analogy** | Jotting down notes during the day | Organizing the notebook while sleeping |
| **Shared component** | `createAutoMemCanUseTool` | `createAutoMemCanUseTool` |
| **Forked agent** | Max 5 turns | No turn limit |
| **Transcript** | Not recorded (`skipTranscript`) | Not recorded (`skipTranscript`) |

### Collaboration Flow

```
After each conversation turn
    |
extractMemories -> Extract new memory fragments -> Write *.md + MEMORY.md
    |
(After accumulating 24h + 5 sessions)
    |
autoDream -> Review all memories + session transcripts
    |
Merge duplicates / Fix stale data / Delete conflicts / Compress index
    |
MEMORY.md and topic files refreshed
```

---

## 8. Source Code Navigation

| File | Responsibility |
|------|----------------|
| `src/services/autoDream/autoDream.ts` | Main logic: gate checks, launch forked agent, progress monitoring |
| `src/services/autoDream/config.ts` | Toggle control: settings.json or GrowthBook |
| `src/services/autoDream/consolidationPrompt.ts` | Dream prompt: 4-phase consolidation workflow |
| `src/services/autoDream/consolidationLock.ts` | Lock file mechanism: concurrency prevention, timestamps, rollback |
| `src/tasks/DreamTask/DreamTask.ts` | UI task registration: state management, termination, rollback |
| `src/tasks/pillLabel.ts` | Bottom status bar label: "dreaming" |
| `src/components/tasks/DreamDetailDialog.tsx` | Dream detail dialog UI |
| `src/query/stopHooks.ts` | Execution entry point: triggers after each response |
| `src/utils/backgroundHousekeeping.ts` | Initialization entry point: `initAutoDream()` |
| `src/services/extractMemories/extractMemories.ts` | Shared `createAutoMemCanUseTool` |

---

## 9. Analytics Events

AutoDream records its operational state through the following events:

| Event | Timing | Attached Data |
|-------|--------|---------------|
| `tengu_auto_dream_fired` | Dream started | `hours_since`, `sessions_since` |
| `tengu_auto_dream_completed` | Dream completed | `cache_read`, `cache_created`, `output`, `sessions_reviewed` |
| `tengu_auto_dream_failed` | Dream failed | -- |
