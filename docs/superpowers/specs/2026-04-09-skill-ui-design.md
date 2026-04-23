# Skills UI Feature Design

## Overview

Port the CLI `/skills` listing to the Desktop Web APP, adding a full Skills browser with file tree navigation and content preview in the Settings page.

## Architecture

```
Desktop UI (React)          Server (Bun.serve)           Filesystem
┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
│ Settings Page    │       │ GET /api/skills  │       │ ~/.claude/skills/│
│  └─ Skills Tab   │──────▶│   → list meta    │──────▶│ ./.claude/skills/│
│     ├─ SkillList │       │                  │       │ plugins cache/   │
│     └─ SkillDetail       │ GET /api/skills/ │       │ bundled skills/  │
│        ├─ FileTree│──────▶│   detail?s=&n=  │──────▶│                  │
│        └─ Viewer │       │   → tree + files │       │                  │
└──────────────────┘       └──────────────────┘       └──────────────────┘
```

## Data Models

### SkillMeta (list item)

```typescript
type SkillSource = 'userSettings' | 'projectSettings' | 'policySettings'
                 | 'plugin' | 'mcp' | 'bundled'

type SkillMeta = {
  name: string              // unique name (plugin format: "plugin:skill")
  displayName?: string      // custom display name from frontmatter
  description: string
  source: SkillSource
  userInvocable: boolean
  version?: string
  contentLength: number     // char count for token estimation
  pluginName?: string       // plugin name when source is 'plugin'
  hasDirectory: boolean     // whether the skill has a browsable directory
}
```

### FileTreeNode

```typescript
type FileTreeNode = {
  name: string              // file/dir name
  path: string              // relative to skill root
  type: 'file' | 'directory'
  children?: FileTreeNode[] // present for directories
}
```

### SkillFile

```typescript
type SkillFile = {
  path: string              // relative path
  content: string           // file content
  language: string          // language id (md, ts, json, yaml, sh, etc.)
}
```

### SkillDetail (detail view)

```typescript
type SkillDetail = {
  meta: SkillMeta
  tree: FileTreeNode[]      // directory tree
  files: SkillFile[]        // all file contents, loaded at once
  skillRoot: string         // absolute path (display only)
}
```

## Server API

### `GET /api/skills`

Returns metadata list of all installed skills.

**Response:**
```json
{
  "skills": [
    {
      "name": "my-skill",
      "displayName": "My Skill",
      "description": "Does something useful",
      "source": "userSettings",
      "userInvocable": true,
      "contentLength": 1234,
      "hasDirectory": true
    }
  ]
}
```

**Implementation:** Reuse `loadAllCommands()` from `src/commands.ts`, filter for `type === 'prompt'` commands with skill-related `loadedFrom` values. Extract metadata without loading full content.

### `GET /api/skills/detail?source={source}&name={name}`

Returns full skill data including file tree and all file contents.

**Response:**
```json
{
  "detail": {
    "meta": { ... },
    "tree": [
      { "name": "SKILL.md", "path": "SKILL.md", "type": "file" },
      {
        "name": "examples",
        "path": "examples",
        "type": "directory",
        "children": [
          { "name": "demo.ts", "path": "examples/demo.ts", "type": "file" }
        ]
      }
    ],
    "files": [
      { "path": "SKILL.md", "content": "---\nname: ...\n---\n# ...", "language": "md" },
      { "path": "examples/demo.ts", "content": "...", "language": "ts" }
    ],
    "skillRoot": "/Users/x/.claude/skills/my-skill"
  }
}
```

**Implementation:**
1. Find matching skill by source + name from loaded commands
2. Get `skillRoot` from the command object
3. Recursively walk the directory, skip `node_modules`, `.git`, hidden dirs
4. Read all files (max 100KB per file, max 50 files total as safety limit)
5. Detect language from file extension
6. For MCP skills (no directory): return empty tree, single virtual file with the skill's prompt content

### File: `src/server/api/skills.ts`

New file following the pattern of `src/server/api/status.ts`.

### Router registration: `src/server/router.ts`

Add `case 'skills': return handleSkillsApi(req, url, segments)`.

## Desktop UI

### Settings Tab Addition

Add a 5th tab "Skills" (icon: `auto_awesome`) to `desktop/src/pages/Settings.tsx`.

```
type SettingsTab = 'providers' | 'permissions' | 'general' | 'adapters' | 'skills'
```

### Skill List View (`SkillList.tsx`)

- Grouped by source (User, Project, Plugin, MCP, Bundled)
- Each group: collapsible header with count
- Each item: name, description (truncated), source badge
- Click → navigate to detail view
- Loading state + empty state

### Skill Detail View (`SkillDetail.tsx`)

Two-panel layout:
- **Left panel (w-[220px]):** File tree with expand/collapse
- **Right panel (flex-1):** File content viewer
- **Header:** Back button, skill name, description, source badge, token estimate
- Default selected file: SKILL.md

### File Tree Component (`FileTree.tsx`)

- Recursive tree with indent
- Directory expand/collapse (default: all expanded)
- File icons based on extension
- Click file → show in right panel
- Active file highlight

### File Viewer (`FileViewer.tsx`)

- For `.md` files: Use existing `MarkdownRenderer`
- For code files: Use existing `CodeViewer` with language detection
- File path header with copy button
- Scrollable content area

### Language Detection

Map file extension to language:
```typescript
const LANG_MAP: Record<string, string> = {
  md: 'markdown', ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', json: 'json',
  yaml: 'yaml', yml: 'yaml', sh: 'bash', bash: 'bash',
  py: 'python', toml: 'toml', css: 'css', html: 'html',
}
```

## State Management

### `desktop/src/stores/skillStore.ts`

```typescript
type SkillStoreState = {
  skills: SkillMeta[]
  selectedSkill: SkillDetail | null
  isLoading: boolean
  isDetailLoading: boolean
  error: string | null

  fetchSkills: () => Promise<void>
  fetchSkillDetail: (source: string, name: string) => Promise<void>
  clearSelection: () => void
}
```

### `desktop/src/api/skills.ts`

```typescript
export const skillsApi = {
  list: () => api.get<{ skills: SkillMeta[] }>('/api/skills'),
  detail: (source: string, name: string) =>
    api.get<{ detail: SkillDetail }>(`/api/skills/detail?source=${encodeURIComponent(source)}&name=${encodeURIComponent(name)}`),
}
```

### `desktop/src/types/skill.ts`

All type definitions from Data Models section.

## i18n

Add to both `en.ts` and `zh.ts`:

```typescript
'settings.tab.skills': 'Skills' / '技能',
'settings.skills.title': 'Installed Skills' / '已安装技能',
'settings.skills.description': 'Skills extend Claude...' / '技能扩展 Claude...',
'settings.skills.empty': 'No skills installed' / '暂无已安装技能',
'settings.skills.back': 'Back to list' / '返回列表',
'settings.skills.tokens': '~{count} tokens',
'settings.skills.files': '{count} files' / '{count} 个文件',
'settings.skills.source.userSettings': 'User' / '用户',
'settings.skills.source.projectSettings': 'Project' / '项目',
'settings.skills.source.plugin': 'Plugin' / '插件',
'settings.skills.source.mcp': 'MCP',
'settings.skills.source.bundled': 'Built-in' / '内置',
```

## Files to Create/Modify

### New files (7):
1. `src/server/api/skills.ts` — Server API handler
2. `desktop/src/types/skill.ts` — Type definitions
3. `desktop/src/api/skills.ts` — API client
4. `desktop/src/stores/skillStore.ts` — Zustand store
5. `desktop/src/components/skills/SkillList.tsx` — Skill list component
6. `desktop/src/components/skills/SkillDetail.tsx` — Detail view (FileTree + FileViewer inline)

### Modified files (4):
7. `src/server/router.ts` — Add skills route
8. `desktop/src/pages/Settings.tsx` — Add Skills tab
9. `desktop/src/i18n/locales/en.ts` — English translations
10. `desktop/src/i18n/locales/zh.ts` — Chinese translations

## Design Decisions

1. **One detail request loads all files** — Single skill directories are small (typically <50KB total), so loading all at once avoids per-file request overhead.
2. **Reuse existing components** — `MarkdownRenderer` for .md files, `CodeViewer` for code. No new rendering dependencies.
3. **source + name as identifier** — Skills can have duplicate names across sources, so both are needed.
4. **Server-side skill loading** — Reuse `loadAllCommands()` which already handles all 6 sources with deduplication and caching.
5. **Safety limits** — Max 50 files, 100KB per file to prevent issues with massive plugin directories.
6. **FileTree + FileViewer inline in SkillDetail** — No need for separate components given the simplicity; keeps code collocated.
