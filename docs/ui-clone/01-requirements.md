# Claude Code Desktop App — Product Requirements Document (PRD)

## 1. Project overview

### 1.1 Goal

Replicate the core desktop GUI features of the Claude Code Desktop App. Focus on four modules: **AI chat interaction**, **session management**, **scheduled tasks** and **Agent Teams visualization**.

### 1.2 Replication tech stack

- **Front-end framework**: React 18 + TypeScript
- **UI rendering**: standard browser DOM (replacing Ink terminal rendering)
- **Desktop container**: Electron or Tauri
- **Styling**: TailwindCSS v4
- **State management**: Zustand

### 1.3 Core principles

- **CLI/UI data interoperability**: the UI reads and writes exactly the same JSONL/JSON files as the CLI
- **Non-invasive**: do not modify the original CLI source code
- **Focus on the core**: only chat + sessions + scheduled tasks + Agent Teams; no Search/Dispatch/Customize

---

## 2. Page list

| ID | Page | Description | Priority |
|------|------|------|--------|
| P1 | Top title bar | macOS window controls + Code tab | P0 |
| P2 | Left sidebar | New session + Scheduled + project picker + session list | P0 |
| P3 | Bottom status bar | User info + repository info | P1 |
| P4 | Code empty state | Mascot + input box | P0 |
| P5 | Code active session | Message list + input area + tool calls + Agent Teams panel | P0 |
| P6 | Permission mode picker | Ask/Auto/Plan/Bypass dropdown | P0 |
| P7 | Model picker | Model list + Effort level | P0 |
| P8 | Scheduled tasks page | Task list + empty state | P1 |
| P9 | New scheduled task modal | Form for creating a scheduled task | P1 |

**Removed**: Search page, Dispatch page, Customize settings page (settings are done directly in the input box controls)

---

## 3. Functional requirements

### 3.1 Top title bar (P1)

- R-001: macOS traffic-light buttons (close/minimize/full screen)
- R-002: Back/forward navigation arrows
- R-003: `Code` tab centered (Chat/Cowork slots reserved but not implemented yet)
- R-004: Title bar can be dragged to move the window

---

### 3.2 Left sidebar (P2)

#### Navigation menu

- R-005: Show two navigation items, `+ New session` and `Scheduled`
- R-006: Clicking a navigation item switches the main content area
- R-007: The current item is highlighted

#### Project picker

- R-008: `All projects ▾` dropdown picker
- R-009: Choose a specific project to filter the session list

#### Session list

- R-010: Grouped by time (Today / Previous 7 Days / Older)
- R-011: Each item shows the session title (summary of the first message or a custom title)
- R-012: The selected session is highlighted with a dot on the left
- R-013: Supports search filtering
- R-014: Context menu: rename, delete
- R-015: Clicking switches to that session

**Data model**:
```typescript
type Session = {
  id: string              // UUID v4
  title: string           // summary of the first message or customTitle
  createdAt: Date
  modifiedAt: Date
  messageCount: number
  projectPath: string     // project directory (sanitized)
}
```

---

### 3.3 Bottom status bar (P3)

- R-016: User avatar + user name + subscription tier (e.g. `Max plan`)
- R-017: Git repository name + branch name
- R-018: worktree checkbox
- R-019: Local / Remote mode toggle

---

### 3.4 Code empty state (P4)

- R-020: Centered Clawd mascot (a pixel-art orange critter)
- R-021: Input box at the bottom, rounded, with placeholder text
- R-022: `+` button (add attachments/context)
- R-023: Permission mode picker (bottom left)
- R-024: Model picker (bottom right)
- R-025: Microphone icon (voice input, right side)

---

### 3.5 Code active session (P5) — the core page

#### 3.5.1 Session title bar

- R-026: The session title can be clicked to edit
- R-027: `▷ Preview ▾` button (top right)

#### 3.5.2 Message list

- R-028: User messages — right-aligned warm-colored bubbles
- R-029: AI text — left-aligned, Markdown rich text
- R-030: AI thinking — collapsible gray block
- R-031: Tool calls — collapsible block showing tool name + summary
- R-032: System messages — centered gray
- R-033: Collapsed sections — `▸ Initialized your session`, containing a list of sub-tools
- R-034: Context compaction divider
- R-035: "N new messages" jump prompt

**Message types**:
```typescript
type MessageType =
  | 'user_text'          | 'user_image'
  | 'assistant_text'     | 'assistant_thinking'  | 'assistant_tool_use'
  | 'user_tool_result'   | 'system_text'         | 'system_error'
  | 'grouped_tool_use'   | 'collapsed_section'   | 'compact_boundary'
```

#### 3.5.3 Agent Teams visualization

**Description**: when Agent Teams are created in a conversation, the UI needs to show the live working state of each team member, equivalent to the CLI experience of switching between members' transcripts with Shift+Up/Down.

- R-036: Bottom team status bar — shows the active team name + member count
- R-037: Member tag list — each teammate is a clickable tag (name + color + status indicator)
- R-038: Clicking a member tag → switches to that member's transcript view
- R-039: Member transcript view — a separate message list showing that agent's full conversation
- R-040: Member status indicator — `running` (blinking dot) / `completed` (green check) / `failed` (red cross)
- R-041: Back to Leader view button
- R-042: Background task notification — when a teammate finishes, a `<task-notification>` message appears in the Leader view

**Data model**:
```typescript
type TeamContext = {
  teamName: string
  isLeader: boolean
  teammates: Record<string, {
    name: string
    agentType?: string
    status: 'running' | 'completed' | 'failed' | 'idle'
    color: AgentColor   // red | blue | green | yellow | purple | orange | pink | cyan
    messageCount: number
  }>
}

// View state
expandedView: 'none' | 'tasks' | 'teammates'
viewingAgentTaskId?: string  // the teammate transcript currently being viewed
```

**Interaction flow**:
```
Leader view (default)
  ├─ AI calls TeamCreate in the conversation → the team status bar appears at the bottom
  ├─ Team members start working → each tag shows running
  ├─ Click a member tag → switch to that member's transcript
  │   ├─ Show that agent's own message stream
  │   ├─ Live updates (tool calls, text output)
  │   └─ Click "← Back to Leader" to return
  ├─ A member finishes → tag becomes completed + Leader receives a task-notification
  └─ All members finish → Leader synthesizes the results
```

**Source references**:
- `src/state/AppStateStore.ts` — `expandedView`, `viewingAgentTaskId`, `teamContext`
- `src/components/TeammateViewHeader.tsx` — header for switching teammate views
- `src/components/CoordinatorAgentStatus.tsx` — coordinator status panel
- `src/components/tasks/BackgroundTaskStatus.tsx` — background task status
- `src/state/selectors.ts` — `getViewedTeammateTask()`, `getActiveAgentForInput()`

#### 3.5.4 Tool call display

- R-043: Single tool call — collapsible block (tool name + arguments + result)
- R-044: Agent subtask — `Agent  description` format, with the agent's color
- R-045: Bash command — highlighted command text + expandable output
- R-046: File edit — structured diff (green additions / red deletions)
- R-047: Grouped tool calls — consecutive calls of the same tool merged into one group

#### 3.5.5 Live status

- R-048: `✦ Crafting...` shimmer animation + dynamic verb
- R-049: Timer + token count
- R-050: Stop generation button

#### 3.5.6 Bottom input area

- R-051: Multi-line text input, auto-expanding
- R-052: `+` to add attachments
- R-053: Permission mode indicator
- R-054: Model picker
- R-055: Stop button (while the AI is running)

---

### 3.6 Permission mode picker (P6)

- R-056: Dropdown with 4 options
- R-057: Each item shows icon + name + description
- R-058: ✓ on the selected item
- R-059: Switching takes effect immediately

| Option | Icon | Description |
|------|------|------|
| Ask permissions | ⚙ | Always ask before making changes |
| Auto accept edits | `</>` | Automatically accept all file edits |
| Plan mode | 📋 | Create a plan before making changes |
| Bypass permissions | ⚠ | Accepts all permissions |

---

### 3.7 Model picker (P7)

- R-060: Model list (top) + Effort level (bottom, separated by a divider)
- R-061: Model — name + description + ✓ when selected
- R-062: Effort — Low / Medium / High / Max + ✓ when selected

| Model | Description |
|------|------|
| Opus 4.7 | Most capable for ambitious work |
| Opus 4.7 1M | Most capable for ambitious work |
| Sonnet 4.6 | Most efficient for everyday tasks |
| Haiku 4.5 | Fastest for quick answers |

---

### 3.8 Scheduled tasks page (P8)

- R-063: Page title `Scheduled tasks`
- R-064: Empty state: clock icon + `No scheduled tasks yet.`
- R-065: `+ New task` button (top right)
- R-066: Task list: name + description + frequency + next run
- R-067: Each item supports edit and delete

---

### 3.9 New scheduled task modal (P9)

- R-068: Info banner: `Local tasks only run while your computer is awake.`
- R-069: Name (required) + Description (required)
- R-070: Multi-line Prompt input
- R-071: Permissions + Model pickers
- R-072: Select folder + worktree checkbox
- R-073: Frequency dropdown + Time picker
- R-074: Cancel / Create task buttons

---

## 4. Interaction components

### 4.1 Permission request dialog

- R-075: Bash command — show the command
- R-076: File edit — show the diff
- R-077: File write — show the path
- R-078: Action buttons: Allow / Deny / Always allow / Always deny

### 4.2 Markdown rendering

- R-079: Headings, lists, bold/italic
- R-080: Code block syntax highlighting
- R-081: Tables
- R-082: Clickable file paths

### 4.3 Diff display

- R-083: Added lines green / deleted lines red
- R-084: Line numbers + file path header
- R-085: Word-level diff highlighting

### 4.4 Notifications

- R-086: Toast notifications (success/error/warning)
- R-087: Auto-dismiss + queue

### 4.5 Generic dialog

- R-088: Title + content + buttons
- R-089: ESC to close

---

## 5. Data models

### 5.1 Global state (AppState)

```typescript
type AppState = {
  // model
  mainLoopModel: string | null
  effort: 'low' | 'medium' | 'high' | 'max'
  permissionMode: PermissionMode

  // view
  expandedView: 'none' | 'tasks' | 'teammates'
  viewingAgentTaskId?: string

  // tasks
  tasks: Record<string, TaskState>
  foregroundedTaskId?: string

  // team
  teamContext?: TeamContext

  // notifications
  notifications: { current: Notification | null; queue: Notification[] }
}
```

### 5.2 Message model

```typescript
type Message = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: ContentBlock[]
  timestamp: number
  model?: string
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: any }
  | { type: 'thinking'; thinking: string }
```

---

## 6. Navigation model

State-driven (not URL routing):

```
Sidebar: + New session → Code empty state
         Scheduled → scheduled tasks page
         Session list item → Code active session
                      ↓
                      expandedView = 'teammates' → Agent Teams panel
                      viewingAgentTaskId → switch to a teammate's transcript
```

---

## 7. Implementation roadmap

### Phase 1: Foundation
1. Project scaffolding + theme system
2. Design system components (Dialog, Select, Button)
3. App shell layout (title bar + sidebar + status bar)
4. Global state management

### Phase 2: Core chat
5. Code empty state
6. Input area (text + pickers)
7. Message list (user + AI text)
8. Permission / model pickers
9. Loading states

### Phase 3: Advanced rendering
10. Markdown + code highlighting
11. Tool call display
12. Diff display
13. Permission request dialog

### Phase 4: Agent Teams
14. Team status bar + member tags
15. Teammate transcript view switching
16. Background task notifications

### Phase 5: Scheduled tasks
17. Scheduled page + new task modal

---

## 8. Key source index

| Feature | Path |
|------|------|
| Global state | `src/state/AppStateStore.ts` |
| Main screen | `src/screens/REPL.tsx` |
| Layout | `src/components/FullscreenLayout.tsx` |
| Input | `src/components/PromptInput/PromptInput.tsx` |
| Messages | `src/components/Message.tsx`, `src/components/messages/` |
| Permission types | `src/types/permissions.ts` |
| Model picker | `src/components/ModelPicker.tsx` |
| Theme | `src/utils/theme.ts` |
| Scheduled tasks | `src/utils/cronTasks.ts` |
| Agent Teams | `src/components/TeammateViewHeader.tsx`, `src/components/CoordinatorAgentStatus.tsx` |
| Background tasks | `src/components/tasks/BackgroundTaskStatus.tsx` |
| Diff | `src/components/StructuredDiff.tsx` |
| Session management | `src/components/LogSelector.tsx` |
| Server API | `src/server/` |
