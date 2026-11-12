# Claude Code Desktop App — UI design spec

> This document is meant for generating design mockups. It covers the full color scheme, layout dimensions, component specs and page interaction logic.
> It can be used directly by AI design tools or as a designer reference.

---

## 1. Design style overview

### 1.1 Overall style

- **Design language**: modern minimal, warm tones, Notion/Linear-like
- **Background**: mainly white/off-white, not pure white (leaning warm)
- **Corner radius**: large radii (8-12px), larger for cards and inputs (12-16px)
- **Shadows**: subtle, only on floating layers and dropdowns
- **Font**: system font stack (-apple-system, SF Pro, Segoe UI, Inter)
- **Icon style**: line icons, 1.5px stroke, round caps
- **Brand color**: orange `rgb(215,119,87)` — Claude brand orange

### 1.2 Mascot (Clawd)

- A pixel-art critter (something like a little crab/alien)
- Body color: `rgb(215,119,87)` (Claude orange)
- 8-bit pixel style, roughly 64x64px
- Two black square eyes
- Four short legs
- Background: transparent or `rgb(0,0,0)` (clawd_background)

---

## 2. Color scheme

### 2.1 Light theme (default theme, used in the screenshots)

#### Brand and core colors

| Token | Value | Usage |
|-------|------|------|
| `claude` | `rgb(215,119,87)` | Brand orange, primary color, mascot color |
| `claudeShimmer` | `rgb(245,149,117)` | Light brand orange, shimmer animation |
| `permission` | `rgb(87,105,247)` | Permission blue, permission mode marker |
| `permissionShimmer` | `rgb(137,155,255)` | Light permission blue |
| `autoAccept` | `rgb(135,0,255)` | Auto-accept purple, Auto mode marker |
| `planMode` | `rgb(0,102,102)` | Plan mode teal, Plan mode marker |
| `fastMode` | `rgb(255,106,0)` | Fast mode orange |

#### Text colors

| Token | Value | Usage |
|-------|------|------|
| `text` | `rgb(0,0,0)` | Primary text (black) |
| `inverseText` | `rgb(255,255,255)` | Inverse text (white) |
| `inactive` | `rgb(102,102,102)` | Inactive text (dark gray) |
| `subtle` | `rgb(175,175,175)` | Secondary text (light gray) |
| `suggestion` | `rgb(87,105,247)` | Suggestion text (blue-purple) |

#### Semantic colors

| Token | Value | Usage |
|-------|------|------|
| `success` | `rgb(44,122,57)` | Success (green) |
| `error` | `rgb(171,43,63)` | Error (red) |
| `warning` | `rgb(150,108,30)` | Warning (amber) |
| `merged` | `rgb(135,0,255)` | Merged (purple) |

#### Diff colors

| Token | Value | Usage |
|-------|------|------|
| `diffAdded` | `rgb(105,219,124)` | Added line background (light green) |
| `diffRemoved` | `rgb(255,168,180)` | Removed line background (light red) |
| `diffAddedDimmed` | `rgb(199,225,203)` | Dimmed added line (very light green) |
| `diffRemovedDimmed` | `rgb(253,210,216)` | Dimmed removed line (very light red) |
| `diffAddedWord` | `rgb(47,157,68)` | Added word (medium green) |
| `diffRemovedWord` | `rgb(209,69,75)` | Removed word (medium red) |

#### Background colors

| Token | Value | Usage |
|-------|------|------|
| `userMessageBackground` | `rgb(240,240,240)` | User message bubble background |
| `userMessageBackgroundHover` | `rgb(252,252,252)` | User message hover |
| `messageActionsBackground` | `rgb(232,236,244)` | Message action bar background |
| `bashMessageBackgroundColor` | `rgb(250,245,250)` | Bash command background |
| `memoryBackgroundColor` | `rgb(230,245,250)` | Memory block background |
| `selectionBg` | `rgb(180,213,255)` | Text selection background |

#### Border colors

| Token | Value | Usage |
|-------|------|------|
| `promptBorder` | `rgb(153,153,153)` | Input border |
| `promptBorderShimmer` | `rgb(183,183,183)` | Input border shimmer |
| `bashBorder` | `rgb(255,0,135)` | Bash block border (pink) |

#### Agent colors

| Token | Value |
|-------|------|
| `red` | `rgb(220,38,38)` |
| `blue` | `rgb(37,99,235)` |
| `green` | `rgb(22,163,74)` |
| `yellow` | `rgb(202,138,4)` |
| `purple` | `rgb(147,51,234)` |
| `orange` | `rgb(234,88,12)` |
| `pink` | `rgb(219,39,119)` |
| `cyan` | `rgb(8,145,178)` |

#### Other

| Token | Value | Usage |
|-------|------|------|
| `rate_limit_fill` | `rgb(87,105,247)` | Rate limit progress bar fill |
| `rate_limit_empty` | `rgb(39,47,111)` | Rate limit progress bar empty |
| `briefLabelYou` | `rgb(37,99,235)` | User label blue |
| `briefLabelClaude` | `rgb(215,119,87)` | Claude label orange |

---

### 2.2 Dark theme

#### Brand and core colors

| Token | Value | Usage |
|-------|------|------|
| `claude` | `rgb(215,119,87)` | Brand orange (same as Light) |
| `claudeShimmer` | `rgb(235,159,127)` | Light brand orange |
| `permission` | `rgb(177,185,249)` | Permission blue-purple |
| `autoAccept` | `rgb(175,135,255)` | Auto-accept purple |
| `planMode` | `rgb(72,150,140)` | Plan mode teal-green |
| `fastMode` | `rgb(255,120,20)` | Fast mode orange |

#### Text colors

| Token | Value |
|-------|------|
| `text` | `rgb(255,255,255)` |
| `inverseText` | `rgb(0,0,0)` |
| `inactive` | `rgb(153,153,153)` |
| `subtle` | `rgb(80,80,80)` |
| `suggestion` | `rgb(177,185,249)` |

#### Semantic colors

| Token | Value |
|-------|------|
| `success` | `rgb(78,186,101)` |
| `error` | `rgb(255,107,128)` |
| `warning` | `rgb(255,193,7)` |

#### Background colors

| Token | Value |
|-------|------|
| `userMessageBackground` | `rgb(55,55,55)` |
| `userMessageBackgroundHover` | `rgb(70,70,70)` |
| `messageActionsBackground` | `rgb(44,50,62)` |
| `bashMessageBackgroundColor` | `rgb(65,60,65)` |
| `memoryBackgroundColor` | `rgb(55,65,70)` |
| `selectionBg` | `rgb(38,79,120)` |

#### Diff colors

| Token | Value |
|-------|------|
| `diffAdded` | `rgb(34,92,43)` |
| `diffRemoved` | `rgb(122,41,54)` |
| `diffAddedWord` | `rgb(56,166,96)` |
| `diffRemovedWord` | `rgb(179,89,107)` |

---

### 2.3 App UI surface colors (extracted from screenshots)

Light theme UI surface colors used in the screenshots:

| Area | Color | Notes |
|------|------|------|
| App background | `#FFFFFF` | Pure white |
| Sidebar background | `#FAF9F7` | Warm white / off-white |
| Sidebar selected item | `#F0EDE8` | Warm gray |
| Nav item hover | `#F5F3EF` | Very light warm gray |
| Main content background | `#FFFFFF` | Pure white |
| Input background | `#FFFFFF` | Pure white |
| Input border | `#E5E3DE` | Light gray |
| Input radius | `16px` | Large radius |
| Divider | `#E5E3DE` | Light gray |
| Status bar background | `#FAF9F7` | Warm white |
| Button background (primary) | `#3D3D3D` | Dark gray / black |
| Button text (primary) | `#FFFFFF` | White |
| Button background (secondary) | `#FFFFFF` | White |
| Button border (secondary) | `#E5E3DE` | Light gray |
| Dropdown background | `#FFFFFF` | White |
| Dropdown shadow | `0 4px 12px rgba(0,0,0,0.1)` | Subtle shadow |
| User message bubble | `#F5F0E8` | Warm beige |
| Info banner background | `#F5F3EF` | Light warm gray |

---

## 3. Typography

### 3.1 Font stack

```css
--font-family-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif;
--font-family-mono: "SF Mono", "JetBrains Mono", "Fira Code", Menlo, Monaco, "Courier New", monospace;
```

### 3.2 Type scale

| Level | Size | Line height | Weight | Usage |
|------|------|------|------|------|
| H1 | 24px | 32px | 700 (Bold) | Page titles (e.g. "Scheduled tasks") |
| H2 | 18px | 24px | 600 (SemiBold) | Section titles |
| H3 | 16px | 22px | 600 | Dialog titles, component titles |
| Body | 14px | 20px | 400 (Regular) | Body text |
| Small | 13px | 18px | 400 | Secondary text, timestamps |
| Caption | 12px | 16px | 400 | Labels, descriptions, hint text |
| Tiny | 11px | 14px | 500 (Medium) | Badges, status labels |
| Code | 13px | 18px | 400 | Text in code blocks |

### 3.3 Text color levels

| Level | Light value | Dark value | Usage |
|------|-----------|----------|------|
| Primary | `#000000` | `#FFFFFF` | Titles, body |
| Secondary | `#666666` | `#999999` | Secondary information |
| Tertiary | `#AFAFAF` | `#505050` | Placeholders, disabled |
| Accent | `rgb(87,105,247)` | `rgb(177,185,249)` | Links, emphasis |
| Brand | `rgb(215,119,87)` | `rgb(215,119,87)` | Brand elements |

---

## 4. Layout

### 4.1 Overall layout

```
┌───────────────────────────────────────────────────────────┐
│                    Title Bar (40px)                        │
├─────────────┬─────────────────────────────────────────────┤
│             │                                             │
│  Sidebar    │         Main Content Area                   │
│  (280px)    │         (flex: 1)                           │
│             │                                             │
│             │                                             │
│             │                                             │
│             │                                             │
│             │                                             │
│             │                                             │
│             │                                             │
├─────────────┴─────────────────────────────────────────────┤
│                  Status Bar (36px)                         │
└───────────────────────────────────────────────────────────┘
```

| Area | Size | Notes |
|------|------|------|
| Title Bar | 40px tall | Fixed, does not scroll |
| Sidebar | 280px wide | Fixed width, resizable (min 240px, max 400px) |
| Main Content | flex: 1 | Fills the remaining space |
| Status Bar | 36px tall | Fixed, always at the bottom |
| Minimum window size | 900 x 600px | |
| Recommended window size | 1280 x 800px | |

### 4.2 Spacing system

| Token | Value | Usage |
|-------|-----|------|
| `space-1` | 4px | Minimum spacing |
| `space-2` | 8px | Compact spacing |
| `space-3` | 12px | Standard spacing |
| `space-4` | 16px | Comfortable spacing |
| `space-5` | 20px | Block spacing |
| `space-6` | 24px | Large block spacing |
| `space-8` | 32px | Section spacing |
| `space-10` | 40px | Page margin |

### 4.3 Corner radius

| Element | Radius |
|------|------|
| Button | 8px |
| Input | 12px |
| Chat input | 16px |
| Card/panel | 12px |
| Dropdown | 12px |
| Modal | 16px |
| Avatar | 50% (circle) |
| Badge | 4px |
| Tooltip | 8px |

---

## 5. Component specs

### 5.1 Title Bar

```
┌─────────────────────────────────────────────────────┐
│ ● ● ●   ← →   │     Chat    Cowork   [Code]  │    │
└─────────────────────────────────────────────────────┘
```

| Element | Spec |
|------|------|
| Height | 40px |
| Background | White `#FFFFFF` |
| Bottom divider | 1px solid `#E5E3DE` |
| Traffic lights | 12px left offset, vertically centered |
| Traffic light size | 12px circles, 8px apart |
| Nav arrows | 20px, gray `#666666`, darker on hover |
| Tabs | Centered |
| Tab font size | 14px, weight 500 |
| Active tab | Background `#F0EDE8`, radius 8px, padding 6px 12px |
| Inactive tab | No background, color `#666666` |
| Tab gap | 4px |

---

### 5.2 Sidebar

```
┌──────────────┐
│ + New session │ ← nav item
│ ⏰ Scheduled  │
│              │
│ All projects ▾│ ← project filter
│ ─────────────│
│ Today        │ ← time group heading
│  ○ Session 1 │ ← session item
│  ● Session 2 │ ← selected item
│              │
│ Previous 7d  │
│  ○ Session 3 │
└──────────────┘
```

| Element | Spec |
|------|------|
| Width | 280px |
| Background | `#FAF9F7` (warm white) |
| Right divider | 1px solid `#E5E3DE` |
| Padding | 12px top/bottom, 12px left/right |
| Nav item height | 36px |
| Nav item padding | 8px 12px |
| Nav item font size | 14px |
| Nav item icon | 18px, 10px from the text |
| Nav item hover | Background `#F5F3EF`, radius 8px |
| Nav item selected | Background `#F0EDE8`, weight 500 |
| Project filter height | 32px |
| Group heading | 12px, weight 600, color `#999999`, uppercase |
| Group heading top margin | 16px |
| Session item height | 36px |
| Session item padding | 8px 12px 8px 20px |
| Selected indicator | 4px round dot on the left, color `#000000` |
| Selected background | `#F0EDE8` |

---

### 5.3 Status Bar

```
┌──────────────────────────────────────────────────────────────┐
│ [N] nanmi  │  ⬇ ⇅  │  🐙 Repo/name  🔀 main  □worktree  Local▾ │
│ Max plan   │       │                                          │
└──────────────────────────────────────────────────────────────┘
```

| Element | Spec |
|------|------|
| Height | 36px |
| Background | `#FAF9F7` |
| Top divider | 1px solid `#E5E3DE` |
| Padding | 0 12px |
| User avatar | 28px circle |
| User name font | 13px, weight 500 |
| Subscription label | 11px, color `#999999` |
| Repository name | 13px, with GitHub icon |
| Branch name | 13px, with branch icon |
| Worktree checkbox | 14px |
| Local/Remote | 13px dropdown with ▾ |
| Separator | 1px solid `#E5E3DE`, vertical |

---

### 5.4 Chat input

```
┌─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐
│                                                      │
│  🐙 (Clawd mascot)                                   │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │ Find a small todo in the codebase and do it    │  │
│  │                                                │  │
│  │ ┌─────────────────┐           ┌──────────────┐│  │
│  │ │+ ⚙ Ask perms ▾  │           │Opus 4.7 1M ▾ 🎤││
│  │ └─────────────────┘           └──────────────┘│  │
│  └────────────────────────────────────────────────┘  │
└─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘
```

| Element | Spec |
|------|------|
| Input outer margin | Horizontal auto (centered), max width 720px |
| Input radius | 16px |
| Input border | 1px solid `#E5E3DE` |
| Input focus border | 1px solid `#999999` |
| Input padding | 16px 16px 48px 16px |
| Placeholder color | `#AFAFAF` |
| Placeholder font size | 14px |
| Bottom toolbar height | 36px |
| Bottom toolbar padding | 0 8px |
| `+` button | 24px, radius 6px, hover background `#F5F3EF` |
| Permission picker | 13px, left-aligned |
| Permission icon | 16px |
| Model picker | 13px, right-aligned |
| Microphone icon | 20px, far right |

---

### 5.5 Permission mode dropdown

```
┌──────────────────────────────────────┐
│ ⚙ Ask permissions               ✓   │
│   Always ask before making changes   │
│──────────────────────────────────────│
│ </> Auto accept edits                │
│   Automatically accept all file edits│
│──────────────────────────────────────│
│ 📋 Plan mode                         │
│   Create a plan before making changes│
│──────────────────────────────────────│
│ ⚠ Bypass permissions                │
│   Accepts all permissions            │
└──────────────────────────────────────┘
```

| Element | Spec |
|------|------|
| Width | 320px |
| Background | `#FFFFFF` |
| Radius | 12px |
| Shadow | `0 4px 16px rgba(0,0,0,0.12)` |
| Border | 1px solid `#E5E3DE` |
| Option height | 56px |
| Option padding | 12px 16px |
| Option title | 14px, weight 500, color `#000000` |
| Option description | 12px, color `#999999` |
| Option icon | 18px, left |
| ✓ mark | Right, color `#000000` |
| Divider between options | 1px solid `#F0EDE8` |
| Option hover | Background `#F5F3EF` |

---

### 5.6 Model picker dropdown

```
┌──────────────────────────────────┐
│ Opus 4.7                         │
│  Most capable for ambitious work │
│──────────────────────────────────│
│ Opus 4.7 1M                  ✓   │
│  Most capable for ambitious work │
│──────────────────────────────────│
│ Sonnet 4.6                       │
│  Most efficient for everyday...  │
│──────────────────────────────────│
│ Haiku 4.5                        │
│  Fastest for quick answers       │
│══════════════════════════════════│
│ Effort                           │
│──────────────────────────────────│
│ Low                              │
│ Medium                       ✓   │
│ High                             │
│ Max                              │
└──────────────────────────────────┘
```

| Element | Spec |
|------|------|
| Width | 300px |
| Background | `#FFFFFF` |
| Radius | 12px |
| Shadow | `0 4px 16px rgba(0,0,0,0.12)` |
| Model item height | 52px |
| Model name font | 14px, weight 500 |
| Model description font | 12px, color `#999999` |
| Divider (models/Effort) | 1px solid `#E5E3DE` |
| "Effort" label | 12px, weight 600, color `#999999` |
| Effort item height | 36px |
| Effort font size | 14px |
| ✓ mark | Right, color `#000000` |

---

### 5.7 Message bubbles

#### User message

```
                              ┌──────────────────────┐
                              │ Analyze this project │
                              └──────────────────────┘
```

| Property | Spec |
|------|------|
| Alignment | Right |
| Background | `#F5F0E8` (warm beige) |
| Radius | 16px (top-left 16px, top-right 4px, bottom-right 16px, bottom-left 16px) |
| Max width | 70% of the container |
| Font size | 14px |
| Text color | `#000000` |
| Padding | 10px 14px |
| margin-bottom | 12px |

#### AI reply message

| Property | Spec |
|------|------|
| Alignment | Left |
| Background | None (transparent) |
| Max width | 100% |
| Font size | 14px |
| Text color | `#000000` |
| Padding | 0 16px |
| margin-bottom | 16px |
| Markdown | Standard Markdown rendering |

---

### 5.8 Collapsed sections

```
┌──────────────────────────────────────────────────┐
│ ▸ Initialized your session                       │
│     Ran a hook on session startup                │
│     { "hookSpecificOutput": { ...               │
│                                                  │
│ ▸ Explore config and infrastructure              │
│ │   Agent  Explore overall project structure     │
│ │   Bash · 3 tool calls                          │
│ │   Agent  Explore core business code            │
│ │   Bash · 2 tool calls                          │
│ │   Agent  Explore config and infrastructure     │
└──────────────────────────────────────────────────┘
```

| Element | Spec |
|------|------|
| Section title | 14px, weight 500 |
| Toggle icon | ▸ (collapsed) / ▾ (expanded), 12px |
| Left rule | 2px wide, color `#E5E3DE` |
| Child indent | 24px |
| `Agent` label | 12px, weight 500, background `#F0EDE8`, radius 4px, padding 2px 6px |
| `Bash · N tool calls` label | 12px, color `#666666` |
| Child spacing | 4px |
| Section spacing | 8px |

---

### 5.9 Loading state

```
  ✦ Crafting...                    13s · ↓ 531 tokens
```

| Element | Spec |
|------|------|
| ✦ icon | 16px, color `rgb(215,119,87)`, shimmer animation |
| Status text | 14px, color `rgb(215,119,87)`, weight 500 |
| Timer | 13px, color `#999999` |
| Token count | 13px, color `#999999` |
| Shimmer period | 1.5s ease-in-out |

---

### 5.10 Agent Teams panel

When Agent Teams are created in a conversation, a team status bar and member tags appear below the message list.

```
┌──────────────────────────────────────────────────────────┐
│ [message list...]                                        │
│                                                          │
│ ▸ Team: ui-backend-dev (3 members)                      │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ ● session-dev    ● config-dev     ○ features-dev     │ │
│ │   running          completed        running          │ │
│ └──────────────────────────────────────────────────────┘ │
│                                                          │
│ ─────── Viewing: session-dev transcript ──────────      │
│                                                          │
│  [that member's own message stream]                      │
│  > Reading sessionStorage.ts...                          │
│  Agent  Explore session storage                          │
│  Bash · 2 tool calls                                     │
│                                                          │
│  [← Back to Leader]                                      │
└──────────────────────────────────────────────────────────┘
```

| Element | Spec |
|------|------|
| Team status bar height | 32px |
| Team status bar background | `#F5F3EF` |
| Team name | 13px, weight 600 |
| Member count | 13px, color `#999999` |
| Member tag container | flex row, gap 8px, padding 8px 12px |
| Member tag | Radius 6px, padding 4px 10px, 12px, weight 500 |
| Member tag background (default) | `#F0EDE8` |
| Member tag background (selected) | Agent color (15% opacity) |
| Member tag border (selected) | 2px solid agent color |
| Status indicator | 6px dot on the left |
| Running indicator | Color `rgb(202,138,4)` (yellow), blinking |
| Completed indicator | Color `rgb(44,122,57)` (green), solid |
| Failed indicator | Color `rgb(171,43,63)` (red), solid |
| Idle indicator | Color `#CCCCCC` (gray), hollow |
| Divider ("Viewing...") | 1px solid `#E5E3DE`, 8px margin top and bottom |
| "Viewing" label | 12px, color `#999999`, centered |
| Back button | 13px, color `rgb(87,105,247)`, left-aligned, cursor pointer |
| Teammate transcript | Same rendering rules as the main message list |

**Agent color assignment** (from `src/utils/theme.ts`):

| Color name | Light value | Used for tag border and background |
|--------|-----------|---------------------|
| red | `rgb(220,38,38)` | 1st agent |
| blue | `rgb(37,99,235)` | 2nd agent |
| green | `rgb(22,163,74)` | 3rd agent |
| yellow | `rgb(202,138,4)` | 4th agent |
| purple | `rgb(147,51,234)` | 5th agent |
| orange | `rgb(234,88,12)` | 6th agent |
| pink | `rgb(219,39,119)` | 7th agent |
| cyan | `rgb(8,145,178)` | 8th agent |

---

### 5.11 Scheduled page

```
┌──────────────────────────────────────────┐
│  Scheduled tasks              [+ New task]│
│                                          │
│  Run tasks on a schedule or whenever     │
│  you need them. Type /schedule in any    │
│  existing session to set one up.         │
│                                          │
│              ┌─────┐                     │
│              │ ⏰  │                     │
│              └─────┘                     │
│         No scheduled tasks yet.          │
└──────────────────────────────────────────┘
```

| Element | Spec |
|------|------|
| Page padding | 32px 40px |
| Title font | 24px, weight 700 |
| Description font | 14px, color `#666666` |
| Empty state icon | 48px, centered |
| Empty state text | 14px, color `#999999`, centered |
| `+ New task` button | Background `#3D3D3D`, color `#FFFFFF`, radius 8px, padding 8px 16px |

---

### 5.12 New Scheduled Task modal

```
┌──────────────────────────────────────────────┐
│  New scheduled task                          │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │ ℹ Local tasks only run while your    │    │
│  │   computer is awake.                 │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  Name *                                      │
│  ┌──────────────────────────────────────┐    │
│  │ daily-code-review                    │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  Description *                               │
│  ┌──────────────────────────────────────┐    │
│  │ Review yesterday's commits...        │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │ Look at the commits from the last    │    │
│  │ 24 hours. Summarize what changed,    │    │
│  │ call out any risky patterns...       │    │
│  │                                      │    │
│  │ ⚙ Ask permissions ▾   Opus 4.7 1M ▾ │    │
│  │ [📁 Select folder]        □worktree  │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  Frequency                                   │
│  ┌──────────────────────────────────────┐    │
│  │ Daily                            ▾   │    │
│  └──────────────────────────────────────┘    │
│  ┌─────────┐                                 │
│  │  09:00  │                                 │
│  └─────────┘                                 │
│  Scheduled tasks use a randomized delay...   │
│                                              │
│           [Cancel]  [Create task]             │
└──────────────────────────────────────────────┘
```

| Element | Spec |
|------|------|
| Modal width | 560px |
| Modal radius | 16px |
| Modal shadow | `0 8px 32px rgba(0,0,0,0.15)` |
| Overlay | `rgba(0,0,0,0.5)` |
| Modal padding | 24px |
| Title font | 20px, weight 700 |
| Info banner | Background `#F5F3EF`, radius 8px, padding 12px 16px |
| Info icon | ℹ, 16px, color `#666666` |
| Label font | 14px, weight 500 |
| Required marker | `*`, color `#E53E3E` |
| Input | 40px tall, radius 8px, border 1px `#E5E3DE` |
| Prompt input | Min height 120px, radius 12px |
| Frequency dropdown | 40px tall |
| Time picker | 80px wide, 36px tall, radius 8px, border 1px `#E5E3DE` |
| Note text | 12px, color `#999999` |
| Cancel button | Background `#FFFFFF`, border 1px `#E5E3DE`, color `#000000` |
| Create task button | Background `#3D3D3D`, color `#FFFFFF` |
| Button gap | 8px |
| Button padding | 8px 20px |
| Button radius | 8px |

---

### 5.13 Active session title bar

```
  Analyze project structure and codebase ▾        ▷ Preview ▾
```

| Element | Spec |
|------|------|
| Title font | 14px, weight 500 |
| Title color | `#000000` |
| ▾ icon | 12px, color `#999999` |
| Preview button | 13px, border 1px `#E5E3DE`, radius 6px, padding 4px 10px |
| Area height | 44px |
| Bottom divider | 1px solid `#F0EDE8` |

---

## 6. Interaction states

### 6.1 Button states

| State | Primary button | Secondary button |
|------|----------|----------|
| Default | bg `#3D3D3D`, fg `#FFFFFF` | bg `#FFFFFF`, border `#E5E3DE` |
| Hover | bg `#2D2D2D` | bg `#F5F3EF` |
| Active | bg `#1D1D1D` | bg `#E5E3DE` |
| Disabled | bg `#D0D0D0`, fg `#999999` | bg `#F5F3EF`, fg `#CCCCCC` |
| Loading | Show spinner, text unchanged | Same |

### 6.2 Input states

| State | Spec |
|------|------|
| Default | border `#E5E3DE` |
| Focus | border `#999999`, box-shadow `0 0 0 3px rgba(153,153,153,0.1)` |
| Error | border `rgb(171,43,63)`, box-shadow `0 0 0 3px rgba(171,43,63,0.1)` |
| Disabled | bg `#F5F3EF`, border `#E5E3DE`, text color `#CCCCCC` |

### 6.3 Nav item states

| State | Spec |
|------|------|
| Default | Transparent background, color `#666666` |
| Hover | bg `#F5F3EF`, color `#000000` |
| Active/selected | bg `#F0EDE8`, color `#000000`, weight 500 |

### 6.4 Dropdown item states

| State | Spec |
|------|------|
| Default | Transparent background |
| Hover | bg `#F5F3EF` |
| Selected | ✓ on the right, color `#000000` |

### 6.5 Session list item states

| State | Spec |
|------|------|
| Default | Transparent background |
| Hover | bg `#F5F3EF` |
| Selected | bg `#F0EDE8`, solid dot on the left |

---

## 7. Animation

### 7.1 Transitions

| Animation | Property | Duration | Easing |
|------|------|------|------|
| Button hover | background-color | 150ms | ease |
| Nav item switch | background-color | 200ms | ease-out |
| Dropdown open | opacity + transform(Y) | 200ms | ease-out |
| Dropdown close | opacity + transform(Y) | 150ms | ease-in |
| Modal open | opacity + scale | 250ms | cubic-bezier(0.16,1,0.3,1) |
| Modal close | opacity + scale | 200ms | ease-in |
| Collapse/expand | height | 200ms | ease-out |
| Overlay | opacity | 200ms | ease |

### 7.2 Effects

| Animation | Description |
|------|------|
| Clawd mascot | Pixel blink animation every 3-5s |
| ✦ shimmer | opacity 0.4 ↔ 1.0, 1.5s period |
| Spinner | Rotate 360°, 1s period, linear |
| Shimmer | Brand color ↔ shimmer color, 2s period, ease-in-out |

---

## 8. Page interaction flows

### 8.1 New session flow

```
User clicks "New session"
  → "New session" selected in the sidebar
  → Main content shows the Code empty state
  → User types a prompt in the input
  → Presses Enter to send
  → A new session is created and added to the sidebar
  → Main content switches to the active session page
  → The user message bubble is shown
  → AI loading state is shown (✦ Crafting...)
  → The AI reply streams in progressively
  → Tool calls are shown as collapsible blocks
  → When permission is needed, a permission request dialog pops up
  → User approves/denies → tool execution continues/stops
```

### 8.2 Scheduled task creation flow

```
User clicks "Scheduled" in the sidebar
  → Main content shows the Scheduled page
  → User clicks "+ New task"
  → The "New scheduled task" modal opens
  → Fill in Name, Description, Prompt, choose Frequency/Time
  → Choose permission mode and model
  → Click "Create task"
  → The modal closes
  → The new task appears in the task list
```

### 8.3 Permission mode switch flow

```
User clicks the permission mode icon (⚙)
  → The dropdown opens
  → User picks a new mode (e.g. "Plan mode")
  → The dropdown closes
  → The permission icon updates to the new mode icon (📋)
  → If "Bypass permissions" is chosen, a safety confirmation dialog pops up
  → Switches after the user confirms
```

### 8.4 Model switch flow

```
User clicks the model name (Opus 4.7 1M)
  → The dropdown opens (model list + Effort level)
  → User picks a new model
  → or adjusts the Effort level
  → The dropdown closes
  → The model picker updates
  → Subsequent conversation uses the new model
```

### 8.5 Session switch flow

```
User clicks a past session in the sidebar
  → That session is highlighted
  → Main content loads that session's message history
  → Scrolls to the latest message
  → The input is restored to empty / the last unsent draft
```

### 8.6 Agent Teams flow

```
AI calls TeamCreate in the conversation
  → A team status bar appears below the message list
  → Shows the team name + member tags
  → Each member tag shows ● running (blinking yellow)

User clicks a member tag
  → The message list switches to that member's transcript
  → Shows a "Viewing: {name} transcript" divider
  → Renders that agent's message stream live (tool calls, text)
  → A "← Back to Leader" button appears at the bottom

A member finishes its task
  → The tag becomes ● completed (solid green)
  → The Leader view receives a task-notification message

User clicks "← Back to Leader"
  → Returns to the Leader's main conversation
  → The team status bar stays visible
```

---

## 9. Responsive behavior

### 9.1 Window size breakpoints

| Breakpoint | Width | Layout change |
|------|------|----------|
| Compact | < 900px | Sidebar collapsible, shown as an overlay |
| Standard | 900-1440px | Sidebar fixed at 280px |
| Wide | > 1440px | Sidebar can be widened to 400px |

### 9.2 Sidebar collapse

- Below 900px the sidebar is collapsed by default
- Expand it with the hamburger menu icon
- When expanded it overlays the main content
- Click the main content or press ESC to close

---

## 10. Icon list

| Usage | Icon | Notes |
|------|------|------|
| New session | `+` | Plus, creates a new session |
| Scheduled | ⏰ | Clock |
| Ask permissions | ⚙ | Gear |
| Auto accept | `</>` | Code symbol |
| Plan mode | 📋 | Clipboard |
| Bypass | ⚠ | Warning triangle |
| Add attachment | `+` | Circled plus |
| Voice input | 🎤 | Microphone |
| Stop generation | ⏹ | Square stop |
| Collapse | ▸ | Right triangle |
| Expand | ▾ | Down triangle |
| GitHub | 🐙 | GitHub logo |
| Git branch | 🔀 | Branch icon |
| Forward | → | Right arrow |
| Back | ← | Left arrow |
| Selected | ✓ | Check |
| Info | ℹ | Circled i |
| Agent Running | ● | 6px dot, blinking |
| Agent Completed | ● | 6px solid green dot |
| Agent Failed | ● | 6px solid red dot |
| Back to Leader | ← | Left arrow + text |
