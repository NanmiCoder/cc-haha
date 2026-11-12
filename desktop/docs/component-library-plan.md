# Desktop Component Library: Extraction and Migration Plan

This is the companion working document for [`desktop/src/components/AGENTS.md`](../src/components/AGENTS.md), recording audit evidence, API drafts for components to extract, and the order of incremental rollout.

Audit scope: `desktop/src/**` (492 ts/tsx files, 235 of them tsx). Method: 5 parallel read-only agents scanned by domain (design tokens / interaction primitives / overlays / data display / shared layer and engineering constraints), with conclusions spot-checked by the lead agent.

> **Execution status (2026-07-26)**: Stages 0–8 have all landed, and `shared/` and `common/` have been deleted.
> Deviations from this document and new findings during rollout are recorded in [Appendix 2](#appendix-2-implementation-record-and-deviations-from-this-document). **That section is the authoritative change list; the body of this document is kept as the audit snapshot at the time.**

---

## 1. Current state: the problem isn't "developers being lazy"

### 1.1 Quantified

| Metric | Value |
|---|---|
| Component / test files under `components/` | 117 / 67 |
| Native `<button>` / `<Button>` instances | **362** (non-test) / 102 → reuse rate **22%** |
| Files completely unaware `shared/Button` exists | **80** |
| Files mixing two styles in the same file | 13 |
| Native input / textarea / select | 56 / 13 / 7 |
| Hand-rolled overlays (dialogs/drawers/dropdowns/context menus/popovers/tooltips) | **31** |
| Hand-written outside-click logic | **21 places** |
| Hand-written empty states | **22 places** (24 `border-dashed` shells across 15 files) |
| Hand-written skeletons | 6 blocks / 15 places |
| Pill badges / status dots | 45 / 41 |
| Card container combinations (top 7 combined) | **115 places** |
| `[var(--x)]` bridges vs bare `@theme` utilities | **4874 / 8** |
| Button focus styles / disabled styles | **32 kinds / 19 kinds** |
| Button height / radius / font size steps | **18 / 21 / 21 kinds** |
| z-index values / z tokens | **17 kinds / 0** |

### 1.2 Root cause: no index, not a lack of capability

Three pieces of hard evidence, all cases where **the same code was copied by authors who clearly didn't know an implementation already existed**:

1. **`shared/Button.tsx:56-63` privately implements its own `Spinner`, whose SVG path is character-for-character identical to the adjacent `shared/Spinner.tsx`** (`M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z`). And `shared/Spinner.tsx` is imported by **0 files** — pure dead code. Even inside the shared directory, between two adjacent files, code was copy-pasted.

2. **`chat/ChatInput.tsx:408-466` and `pages/EmptySession.tsx:140-198` are a 59-line byte-for-byte copy** (`diff` output is empty), with four identical outside-click effects.

3. **The progress bars in `chat/SessionTaskBar.tsx:65-76` and `teams/TeamStatusBar.tsx:62-71` even share the `{/* Progress bar */}` comment**, differing only in the variable names in the ternary.

Add the directory archaeology: `shared/` and `controls/` were created in the **same commit** (`993b96cd`, 2026-04-06), with the implicit rules never written down; `common/` (2026-05-29) has a one-line commit message that doesn't explain why a new directory was needed — and shared/common are synonyms to begin with.

> **Conclusion**: The line "Reuse the existing desktop design system" in `desktop/AGENTS.md` is a non-executable instruction for both humans and AI — it doesn't say where to look or what counts once found. That's what this effort fills in.

### 1.3 Reuse rate of the existing shared layer

| Component | Production callers | Lines | Coupling | Verdict |
|---|---:|---:|---|---|
| `shared/Button` | 23 | 63 | Pure UI | Truly shared |
| `shared/ConfirmDialog` | 13 | 49 | Pure UI | Truly shared |
| `shared/Modal` | 10 | 119 | Pure UI | Truly shared |
| `shared/CopyButton` | 8 | 61 | Pure UI\* | Truly shared |
| `shared/Input` | 7 | 38 | Pure UI | Truly shared |
| `shared/MobileBottomSheet` | 5 | 94 | Pure UI | Truly shared |
| `shared/DirectoryPicker` | 5 | 363 | api×2 | **Business component** |
| `shared/ActionDialog` | 4 | 66 | Pure UI | Truly shared |
| `shared/Dropdown` | 4 | 103 | Pure UI | Truly shared |
| `controls/ModelSelector` | 3 | 658 | store×7 | **Business component** |
| `controls/PermissionModeSelector` | 3 | 418 | store×5 | **Business component** |
| `shared/RepositoryLaunchControls` | 2 | 664 | api | **Pseudo-shared** |
| `controls/ReasoningEffortPopover` | **1** | 214 | Pure UI | **Pseudo-shared** (only caller is ModelSelector in the same directory) |
| `controls/AutoModeOptInDialog` | **1** | 47 | — | **Pseudo-shared** |
| `shared/ConfirmPopover` | **1** | 33 | Pure UI | **Pseudo-shared** |
| `shared/ProjectContextChip` | **1** | 71 | — | **Pseudo-shared** |
| `shared/Toast` | **1** | 54 | store | App singleton |
| `shared/UpdateChecker` | **1** | 74 | store | App singleton |
| `shared/Spinner` | **0** | 30 | Pure UI | **Dead code** |

Of the 23 "shared" components, only 8 are truly shared; single-caller pseudo-shared components account for 35%.

\* `CopyButton` imports `../chat/clipboard` in reverse, one of 4 layering inversions.

---

## 2. Defects that can be fixed right away

Issues found incidentally during the audit, decoupled from extraction. **Recommend fixing this batch first**: small changes, low risk, and a way to validate the submission flow.

### P0 — affects user-visible behavior

| # | Problem | Location | Evidence |
|---|---|---|---|
| 1 | **The `dark:` variant is bound to the operating system, not the app theme**. `globals.css` has no `@custom-variant dark` and no `prefers-color-scheme`, so all 13 `dark:` usages are broken. With a light system theme + dark app theme, the streaming retry banner blows up into a near-white block | `chat/StreamingIndicator.tsx:68,70,72,75,78,84`, `features/pets/PetApp.tsx:600` | Verified: 0 `@custom-variant`, 0 `prefers-color-scheme`, 13 `dark:` |
| 2 | **6 tokens are referenced but never defined**, causing borders to fall back to `currentColor`, the focus ring's outer ring to turn white in dark mode, and panel backgrounds to be transparent | `--color-bg-secondary` (3 places) `--color-bg-primary` `--color-bg` `--color-surface-secondary` `--color-border-strong` `--color-on-primary-container` | Verified: 0 definitions, 1–3 tsx references |
| 3 | **Toast is completely covered by BottomSheet** (z 100 vs 10000) → on H5, users can't see feedback for actions taken inside a sheet | `shared/Toast.tsx:48` vs `shared/MobileBottomSheet.tsx:49` | Read z values directly |
| 4 | **Portal dropdowns cover the Modal scrim** (inline 9999 vs z-50). `DirectoryPicker` is used inside a Modal by `AgentManager` | `shared/DirectoryPicker.tsx:178`, `RepositoryLaunchControls.tsx:306,314,325,333` | Read z values directly |
| 5 | **All overlay entrance animations are broken**. `animate-in slide-in-from-right fade-in` are classes from `tailwindcss-animate`, which was removed during the shadcn rollback, and `globals.css` doesn't define them | `shared/Toast.tsx:25`, `shared/Dropdown.tsx:69,72` | Verified: package.json has no such dependency, globals.css has no definitions |
| 6 | **Two copies of the MCP status badge colors have drifted**; `toneForStatus` lacks a `checking` branch → the same server shows a badge on the settings page but renders as bare text in the slash panel | `pages/McpSettings.tsx:71-77` vs `chat/LocalSlashCommandPanel.tsx:32-44` | — |
| 7 | **The embedded terminal is hard-locked to dark**. 20 hard-coded hex values, while the full set of terminal tokens for all three themes is bypassed entirely → a pitch-black terminal embedded in the white theme | `pages/TerminalSettings.tsx:229-249` (tokens at `globals.css:577-584/786-793/988-995`) | — |

### P1 — consistency and dead code

| # | Problem | Location |
|---|---|---|
| 8 | `pages/NewTaskModal.tsx` is **an entire file of zero-reference dead code** (the one actually in use is `components/tasks/NewTaskModal.tsx`), and it's the biggest remaining user of the deprecated token `--color-primary` (9/29 places). **Delete before extraction**, or the deprecated token will be carried into new components | Verified zero imports |
| 9 | Status dots misuse `animate-pulse` (2s) instead of `animate-pulse-dot` (1.5s), breathing out of sync with the other 13 | `layout/TabBar.tsx:610`, `chat/SessionTaskBar.tsx:143` |
| 10 | The indeterminate progress bar fakes it with `animate-pulse`, while `globals.css:1487-1506` already has a correct implementation nobody uses | `pages/Settings.tsx:4241` |
| 11 | `content-visibility` is written as an inline style, bypassing the override that disables it for touch H5 (iOS long-press word selection jumps around); and `'212px'` is missing the `auto` keyword | `market/SkillCard.tsx:35` |
| 12 | A hard-coded DOM id rendered in two places → duplicate id, `aria-controls` target is ambiguous | `controls/PermissionModeSelector.tsx:129`, rendered at `:176` and `:291` |
| 13 | 4 dead classes, one of which (`.pet-status-pulse`) references a keyframe that doesn't exist | `globals.css:1073, 1121, 2056, 2074` |
| 14 | 4 layering inversions; the worst is the 4th most-reused base component depending back on a feature directory | `shared/CopyButton.tsx:2` → `../chat/clipboard` (fix: move `chat/clipboard.ts` to `lib/clipboard.ts`) |
| 15 | Hard-coded copy: `Modal.tsx:98` `aria-label="Close dialog"` with no override; `ReasoningEffortPopover.tsx:35` defaults to `'推理强度'` ("reasoning effort"); `AttachmentGallery.tsx:193` `'修改内容'` ("edit content") | — |
| 16 | 10 icon-only buttons have no name at all for screen readers, including global chrome | `layout/TitleBar.tsx:62` (settings entry), `layout/TabBar.tsx:404,483` (tab scrolling), `tasks/TaskRow.tsx:135`, `tasks/TaskRunsPanel.tsx:232`, `chat/LocalSlashCommandPanel.tsx:84`, `pages/TerminalSettings.tsx:848`, `pages/AgentTeams.tsx:156,175` |

### To verify (no conclusion yet)

- **Who actually wins conflicting Tailwind classes**: among 84 `<Button className=>` usages, `size="sm"` (px-2) already directly conflicts with `px-0`/`px-3`. What's certain is that class attribute order doesn't determine the cascade; which one wins needs comparing the two rules' offsets in the generated CSS after `bun run build`.
- **WebKit floor for `color-mix`**: `globals.test.ts:118` locks in "the startup critical path must not contain color-mix" (Safari 15 WebView), but Tailwind v4 compiles `bg-[var(--x)]/40` to `color-mix`, and there are **422** such exposures in the codebase. Before extracting the library, confirm the Tauri shell's actual minimum WebKit version (`color-mix` needs Safari 16.2+). If Safari 15 is still in the matrix, the component library can't use `/N` alpha modifiers internally.

---

## 3. Extraction list

Ordered by: number of duplicates × code size per instance × visual inconsistency × behavioral risk.

### Batch 1: pure styling, zero behavioral risk

#### 1. `Spinner` (revive existing dead code)

Covers 17 hand-rolled border spinners + the private copy in `Button.tsx:56`. Smallest change, highest certainty — good for validating the whole process.

```ts
export type SpinnerProps = {
  size?: number                  // default 16
  tone?: 'brand' | 'current'     // covers the two existing dialects
  respectReducedMotion?: boolean // default true
  className?: string
}
```

Two existing dialects: brand + `border-2` (11 places) and `currentColor` (6 places). `chat/ContextUsageIndicator.tsx:276` is the only one respecting `motion-safe:`; make that the default when extracting.

#### 2. `IconButton` (new)

**The largest category**: 76 strictly icon-only buttons across 40 files, 15 radii × 12 sizes, focus ring coverage only 41%, 10 missing accessible names.

```ts
export type IconButtonProps =
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> & {
    icon: ReactNode | string       // lucide component, material icon name, or any ReactNode
    label: string                  // required: icon-only has no visible text, so the accessible name can't be omitted
    showTooltip?: boolean          // default true, also written to title
    size?: 'xs' | 'sm' | 'md' | 'lg'   // h-6/h-7/h-8/h-9, each with equal width
    tone?: 'default' | 'muted' | 'danger' | 'brand'
    shape?: 'square' | 'circle'
    loading?: boolean
    className?: string
  }
```

Fixed internally: `type="button"`, `aria-label={label}`, unified focus ring, unified disabled.

> For the same h-7 square icon button there are currently three styles: `Sidebar.tsx:1005` (rounded-lg + border-focus ring), `WorkbenchPanel.tsx:119` (rounded-[7px] + info/30 ring), `ChatInput.tsx:1193` (rounded-[6px] + no ring).

#### 3. Strengthen `Button` (extend the API in place, don't create a new one)

There's a reason 78% of buttons bypass it — no focus ring, no icon-only mode, **none of the three sizes has an `h-*`** (the direct cause of the 18 heights across the codebase), `type` not defaulting to `button`, no `tonal`/`link` variants.

```ts
export type ButtonVariant =
  | 'primary'         // converge on gradient-btn-primary (the winner of the 5 existing recipes)
  | 'secondary'
  | 'tonal'           // new: 27 existing places have nowhere to go
  | 'ghost'
  | 'danger'          // solid
  | 'danger-outline'  // new: 11 of the 17 existing danger buttons are outlined
  | 'link'            // new: text only + hover:underline

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: 'xs' | 'sm' | 'md' | 'lg'   // each step bound to a fixed h-*, ending the 18 heights
  loading?: boolean
  icon?: ReactNode
  iconPosition?: 'start' | 'end'     // new: for dropdown arrow cases
  block?: boolean                    // new: replaces scattered w-full
  className?: string
}
```

Four accompanying fixes: add a focus ring to the base class; default `type` to `'button'`; add `aria-busy` when `loading`; delete the private internal Spinner and use `shared/Spinner`.

> **The most glaring evidence**: `pages/Settings.tsx:2623` (theme picker) and `:2643` (language picker) are two adjacent controls whose outer className is **character-for-character identical**, differing only in the active fill — one uses gradient + shadow, the other flat brand fill. Users can see it directly.

#### 4. `Badge` + `StatusDot`

Covers 45 pill badges + 41 status dots. Pure display, stateless, can be merged in file by file.

```ts
export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info'

export type BadgeProps = {
  tone?: BadgeTone
  variant?: 'soft' | 'outline' | 'solid'   // soft = background, no border (default)
  size?: 'xs' | 'sm'                       // xs = text-[10px] px-2 py-0.5 (covers 27/45)
  pill?: boolean                           // false → radius-sm, for count badges
  icon?: ReactNode
  mono?: boolean                           // version numbers/paths
  className?: string
  children: ReactNode
}

export type StatusDotProps = {
  tone: BadgeTone
  size?: 'sm' | 'md' | 'lg'   // sm = 1.5 (covers 23/41)
  pulse?: boolean             // always uses animate-pulse-dot
  className?: string
}
```

> The shells of `market/InstallStateBadge.tsx:27-39` and `market/SecurityBadge.tsx:25-37` are **character-for-character identical**, differing only in the mapping tables — after extraction, each file is left with just a mapping table.
> Also fixes P0#6 (MCP tone drift) and P1#9 (two pulse misuses).

#### 5. `Checkbox` / `Switch`

Checkbox: 20 instances in 5 styles (3 sizes, 2 accent tokens, plus a hidden input + peer self-drawn mechanism in `globals.css:162`), and even class order is inconsistent (`w-4 h-4` vs `h-4 w-4`).

Switch has only 3 instances, but **100% inconsistency** (3 implementations, sizes differ by 27%: 56×32 vs 44×24), and new features will keep copying them.

```ts
export type SwitchProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string                 // required; used as aria-label when there's no visible text
  labelHidden?: boolean
  description?: ReactNode
  disabled?: boolean
  size?: 'sm' | 'md'            // adopts PetSettings proportions, drops h-8 w-14
  as?: 'switch' | 'checkbox'    // semantic button vs native input
}
```

Uses the existing `--color-switch-checked-bg` / `--color-switch-thumb` tokens.

### Batch 2: involves behavior, walk through one by one

#### 6. `EmptyState` / `ErrorState` / `LoadingState`

Covers 22 + 12 + 19 places, and **deletes 5 same-named local definitions**.

The worst current case: the project has **3 local components named `EmptyState` and 2 named `LoadingState`, imported across files 0 times**, and two of the `EmptyState`s have incompatible props (`{icon, text}` vs `{title, body}`).

```ts
export type StateSize = 'sm' | 'md' | 'lg'

export type EmptyStateProps = {
  icon?: ReactNode
  title?: string                 // rendered as <h3>, overridable via headingLevel
  description?: string
  action?: { label: string; onClick: () => void; variant?: 'primary' | 'secondary' }
  size?: StateSize
  variant?: 'dashed' | 'plain' | 'inline'
  headingLevel?: 2 | 3 | 4
  className?: string
}

export type ErrorStateProps = {
  title: string
  detail?: string
  onRetry?: () => void
  retryLabel?: string
  size?: StateSize
  tone?: 'soft' | 'strong'       // converge the 20 error backgrounds to 2 levels
  className?: string
}
```

Current inconsistency: three icon systems coexist (lucide / material-symbols / inline svg), 9 icon sizes, 4 heading tags (only 2 places have real heading tags; the rest are plain paragraphs to screen readers), 5 radii, 8 paddings, **only 1 of 24 empty states has an action button**.

Error state alpha is completely out of control: 5 background levels + 7 border levels + 8 container levels = **20 error backgrounds**.

#### 7. `SearchField` / `TextField` / `TextArea` / `SelectField`

Input controls are the worst area for accessibility in the codebase: among 76 input/textarea/select, `focus-visible:` is **used 0 times**, `disabled:` styles **0 places**, `aria-invalid` only 1 place, all 13 textareas **have no id**, all 7 selects **have no aria-label**. **3 places have completely invisible focus** (`trace/TraceTree.tsx:86`, `shared/RepositoryLaunchControls.tsx:437,506`, `search/GlobalSearchModal.tsx:229`).

Search boxes have **11 independent implementations, 2 structures, 7 focus feedback styles**.

```ts
export type SearchFieldProps =
  Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type' | 'value' | 'onChange'> & {
    value: string
    onChange: (value: string) => void
    label: string                 // required; search boxes usually have no visible label
    showLabel?: boolean
    size?: 'sm' | 'md' | 'lg'
    clearable?: boolean
    onClear?: () => void
    icon?: ReactNode
    containerClassName?: string
    onNavigate?: (direction: 'up' | 'down') => void   // up/down arrow navigation to results
    controlsId?: string
    activeDescendantId?: string                       // combobox
  }
```

`TextField`/`TextArea` must add everything the existing `Input.tsx` lacks: `aria-invalid={!!error}`, `aria-describedby` pointing to hint/error (generated with `useId()`, which also fixes the current CJK collision risk of deriving ids from label text), `role="alert"` on the error node, and `disabled:` styles.

#### 8. `SegmentedControl` / `Tabs`

10 implementations, **6 active-state visuals** (gradient fill / flat fill / border + light background / raised white / bottom border / pure color difference), with 5 inside `pages/Settings.tsx` alone. All 4 `role="tab"` usages **lack a `role="tablist"` parent**, and none support left/right arrow keys.

```ts
export type SegmentedControlProps<T extends string> = {
  items: Array<{ value: T; label: ReactNode; description?: ReactNode; icon?: ReactNode; disabled?: boolean }>
  value: T
  onChange: (value: T) => void
  label: string                                     // required, attached to the container
  appearance?: 'solid' | 'raised' | 'underline'
  size?: 'sm' | 'md'
  layout?: 'fill' | 'auto' | number
  as?: 'radiogroup' | 'tablist'                     // single-choice group vs view switcher
}
```

#### 9. The `Skeleton` family

Covers 6 hand-rolled skeleton blocks / 15 places. First decide whether pulse applies to the container or leaves (**container level recommended**, but note container level makes the border breathe too; the two existing styles look different).

```ts
export function Skeleton(props: {
  shape?: 'line' | 'block' | 'circle' | 'avatar'
  width?: string; height?: string
  radius?: 'sm' | 'md' | 'lg' | 'full'
  tone?: 'base' | 'strong'      // converge the 4 existing placeholder backgrounds to 2
  className?: string
}): JSX.Element

/** The only place holding animate-pulse, and uniformly attaches role/aria-busy */
export function SkeletonGroup(props: { label: string; className?: string; children: ReactNode }): JSX.Element
export function SkeletonRows(props: { count: number; rowHeight?: string; lines?: number; divided?: boolean }): JSX.Element
export function SkeletonCards(props: { count: number; minHeight?: string; withAvatar?: boolean }): JSX.Element
```

#### 10. `Card` / `Panel`

Covers 115 places. **Recommend using it only in new code and opportunistic refactors, not a global bulk replacement.**

The real value of extracting `Card` isn't saving code but **providing an incremental path for converging radius tokens**: hard-coded Tailwind steps (433 uses) currently outnumber design tokens (184 uses) 2.35 to 1, and `rounded-lg` and `rounded-[var(--radius-lg)]` share a name but not a value (8px vs 12px). Once callers switch to `<Card radius="md">`, the 433 hard-coded places have a convergence path without a risky global replace.

```ts
export type CardProps = {
  radius?: 'sm' | 'md' | 'lg' | 'xl'
  surface?: 'base' | 'low' | 'lowest' | 'high' | 'inspector'
  border?: 'solid' | 'dashed' | 'none'
  padding?: 'none' | 'sm' | 'md' | 'lg'
  interactive?: boolean          // hover border highlight + focus ring
  as?: 'div' | 'section' | 'article'
  className?: string
  children: ReactNode
}
```

#### 11. `Progress`

```ts
export type ProgressProps = {
  value?: number
  indeterminate?: boolean        // uses the existing implementation at globals.css:1487
  size?: 'xs' | 'sm' | 'md'
  tone?: BadgeTone | 'auto'      // 'auto' = turns success at 100%
  label: string                  // required; attaches role="progressbar" + aria-valuenow
  className?: string
}
```

Currently only `browser/BrowserAddressBar.tsx:48` has `role="progressbar"`. After extraction, the copy-paste between `chat/SessionTaskBar.tsx:65-76` and `teams/TeamStatusBar.tsx:62-71` is eliminated in one go.

### Batch 3: highest risk, separate PR + real-device walkthrough

#### 12. Two hooks first

```ts
// hooks/useDismissable.ts — eliminates 21 hand-written outside-click handlers
export type DismissReason = 'outside' | 'escape' | 'scroll' | 'resize' | 'blur'
export function useDismissable(options: {
  open: boolean
  refs: ReadonlyArray<{ current: HTMLElement | null }>
  triggerRef?: { current: HTMLElement | null }   // clicking it doesn't dispatch outside, avoiding "closes then immediately reopens"
  onDismiss: (reason: DismissReason) => void
  event?: 'pointerdown' | 'mousedown' | 'click'  // default pointerdown
  capture?: boolean                              // default true, so inner nested overlays close first
  closeOnEscape?: boolean                        // default true
  closeOnScroll?: boolean
  isExempt?: (target: EventTarget | null) => boolean
}): void

// hooks/useAnchoredPosition.ts — merges 4 independent viewport calculations
export function useAnchoredPosition(o: {
  open: boolean
  anchorRef: { current: HTMLElement | null }
  floatingRef: { current: HTMLElement | null }
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'left-start' | 'right-start'
  offset?: number
  viewportMargin?: number
  flip?: boolean; shift?: boolean; track?: boolean
}): { style: CSSProperties; placement: string; ready: boolean }
```

> **Port the implementation directly from `common/OpenWithMenu.tsx:36-75`** (measure-and-flip + clamping + trigger exclusion + Esc + close on scroll); it's the most complete overlay behavior implementation in the project. **floating-ui isn't needed.**
>
> The event type matters: currently `mousedown` (14) / `click` (3) / `pointerdown` (3). **`mousedown` is unreliable on touch screens; this is the root-cause category behind "tapping outside doesn't close the menu" on H5** — unify on `pointerdown`.

#### 13. `Menu` / `Popover` / `Tooltip` / `Dialog`

Tooltip first (5 implementations, 5 styles, 4 z values, 3 trigger mechanisms; pure display, lowest risk).

Menu covers 28 hand-rolled dropdowns + 71 menu items (29 padding recipes, 20 of which appear only once). Current state: only 4 places are a11y-compliant, 11 have no Esc, 13 don't close on outside click, only 6 have arrow keys, **only 1 returns focus after closing**, and **none moves focus into the menu when it opens**.

Dialog isn't "merging three duplicate implementations" — `Modal → ActionDialog → ConfirmDialog` is a clean three-layer one-way wrapper with no duplication. What actually needs adding:

- A `dismissible` switch (currently 4 places each hack `onClose={busy ? () => {} : onClose}`)
- i18n defaults for ConfirmDialog's `confirmLabel`/`cancelLabel` (all 13 places write `t('common.cancel')`)
- **`mobileVariant='auto'`**: let Dialog automatically switch to BottomSheet form by viewport, eliminating 4 `useMobileViewport() && !isDesktopRuntime()` ternary forks

#### 14. z-index tokens

```css
@theme {
  --z-base: 0;      --z-raised: 10;   --z-sticky: 20;   --z-nav: 30;
  --z-scrim: 40;    --z-drawer: 50;   --z-dropdown: 60; --z-popover: 70;
  --z-dialog: 80;   --z-sheet: 80;    --z-toast: 90;    --z-tooltip: 100;
}
```

`--z-toast` must be above `--z-sheet`; this is key to fixing P0#3. Migration mapping: `z-50` (20 places) split by semantics into dialog/dropdown/popover; inline 9999 (5 places) and 1000 → dropdown; `z-[10000]` (2 places) → sheet/dialog; the 20/30/40/50 of the 5 tooltips → tooltip.

### Explicitly not extracted

| Component | Reason |
|---|---|
| `Table` | **0 `<table>` elements** in the codebase; tabular data all uses CSS Grid. Forcing one would repeat the `Spinner.tsx` dead-code lesson |
| `Divider` | Only 9 places; `divide-y` is enough, and wrapping it in a component adds DOM |
| `Avatar` | `market/SkillAvatar.tsx` is already extracted with only 2 call sites; the one in `ActivitySettings` has different semantics (user avatars go through the upload API) |
| Virtual scrolling library | The current CV + hand-written windowing was measured in WebKit (worst frame 279ms → 18ms); adding a library would break the "virtualized items disable CV" invariant |
| Any UI dependency | shadcn/ui was just rolled back on 2026-07-25 (`e9b53f68`) |
| Barrel `index.ts` | Zero precedent in the project; `chunkSizeWarningLimit` has already been raised to 2200, and barrels hinder tree-shaking |

---

## 4. Directory reorganization

### Target structure

```
components/ui/         Primitives with no business semantics. Must not import stores/ or api/
components/composite/  Business composites. May import stores/api, but need ≥2 callers
components/<feature>/  Feature directories. Single-caller components always go back here
```

### Migration batches

**Batch 1 — zero risk (no caller changes)**
- Delete `shared/Spinner.tsx` (0 callers), or revive it per extraction batch 1
- Delete `pages/NewTaskModal.tsx` (0-caller dead code)
- `components/chat/clipboard.ts` → `lib/clipboard.ts` (untangles the layering inversion, changes 1 import)

**Batch 2 — private subcomponents move home (1 import change each)**

| From | To | Only caller |
|---|---|---|
| `controls/ReasoningEffortPopover.tsx` | Alongside ModelSelector, or marked internal | `controls/ModelSelector.tsx` |
| `controls/AutoModeOptInDialog.tsx` | Same as above | `controls/PermissionModeSelector.tsx` |
| `shared/ConfirmPopover.tsx` | `components/tasks/` | `components/tasks/TaskRow.tsx` |

**Batch 3 — establish `ui/` (pure moves, affects 74 imports)**

`Button` `ConfirmDialog` `Modal` `CopyButton` `Input` `MobileBottomSheet` `ActionDialog` `Dropdown` → `components/ui/`

> **Do it together with the alias migration** — those 74 lines need changing anyway, so go straight to `@/components/ui/Button` and avoid touching them twice.

**Batch 4 — business components leave shared**

| From | To | Callers |
|---|---|---:|
| `shared/Toast.tsx` | `components/layout/` | 1 |
| `shared/UpdateChecker.tsx` | `components/layout/` | 1 |
| `shared/ProjectContextChip.tsx` | `components/session/` | 1 |
| `shared/RepositoryLaunchControls.tsx` | `components/session/` | 2 |
| `shared/DirectoryPicker.tsx` | `components/composite/` | 5 |
| `common/OpenWithMenu.tsx` + `common/TargetIcon.tsx` | `components/composite/` | 3 + 3 |

**Batch 5** — delete `shared/` and `common/` once empty; keep `controls/` (by then the name will fit). Don't touch `workbench/`, `hooks/`, or `lib/`.

### Machine-enforced gates (recommended)

`theme/globals.test.ts` already set the precedent of "guarding conventions with tests". Copy it and add a `components/ui/layering.test.ts`: read all source under `ui/` and assert it contains no `from '../../stores/` or `from '../../api/`. About 20 lines, turning "`ui/` must not couple to business logic" from a documented convention into a CI red line — more effective than any wording at ensuring both humans and AI comply.

---

## 5. Rollout cadence

Each step is its own PR with unit tests (props matrix + behavioral regressions at the replaced locations).

| Stage | Content | Risk |
|---|---|---|
| 0 | Fix P0 defects (one line of `@custom-variant dark`, add the 6 ghost tokens, z-layer inversions, delete two dead files) | Very low; pure CSS + file deletion |
| 1 | Revive `Spinner` + `IconButton` + strengthen `Button` | Low; pure styling |
| 2 | `Badge`/`StatusDot` + `Checkbox`/`Switch` | Low |
| 3 | The three State components (also deleting the 5 same-named local definitions) | Medium-low |
| 4 | Directory batches 1–3 + the `@/` alias | Medium (affects 74 imports, but purely mechanical) |
| 5 | Input control family + `SegmentedControl` | Medium; walk through each |
| 6 | `useDismissable` + `useAnchoredPosition` (validate by replacing those 59 duplicated lines first) | Medium; unit-testable |
| 7 | `Tooltip` → `Menu` → `Dialog` + z tokens | High; needs real-device walkthrough |
| 8 | `Skeleton` / `Card` / `Progress` (new code only, no bulk replacement) | Low |

Recommend finishing and merging stages 0 and 1 first, so that "there's a component library to use" takes effect for subsequent development as soon as possible — otherwise new features will keep copy-pasting the old way, and debt will grow faster than it's paid down.

---

## Appendix: audit method and reliability

5 read-only agents scanned in parallel by domain, and the lead agent independently re-checked the key conclusions. Re-checked and confirmed: missing `@custom-variant`, the 6 ghost tokens, the `animate-in` dead classes, the 59-line byte-for-byte duplicate, zero references to `pages/NewTaskModal.tsx`, the private Spinner inside `shared/Button` being character-for-character identical to `shared/Spinner.tsx`, and 0 uses of the `@/` alias.

Two items re-checked and found **not to hold**, and removed:

1. That `browser/BrowserAddressBar.tsx:27,28` missing `type="button"` would trigger form submission — those three buttons are siblings of the `<form>`, not children (the form only starts at `:32` and only wraps the input), so they don't submit.
2. That "naming the doc `AGENTS.md` would only trigger the seconds-long `check:policy`" — in practice `evaluateChangePolicy(['desktop/src/components/AGENTS.md'])` returns `checks: desktop, policy`. The reason is that `touchesDesktopWeb` at `change-policy.ts:313-315` only checks `file.startsWith('desktop/src/')` and **doesn't exclude `isAgentInstructionPath` the way the adjacent `server` check does**. So changes to this file and to `components/AGENTS.md` both trigger `check:desktop`; that's a reasonable price for keeping docs next to the code for "nearby discovery", and the docs themselves change infrequently.

Statistics not re-checked and kept as-is (duplicate counts by category, variant distributions, recipe counts) come from the agents' scripted counts; they can be used for prioritization, but at rollout time the actual code then should be authoritative.

---

## Appendix 2: Implementation record and deviations from this document

Executed 2026-07-26. Baseline 225 test files / 2521 cases; after completion **250 / 2893**, with `check:desktop` (lint + test + build) all green.

### Landed

| Stage | Result |
|---|---|
| 0 | `@custom-variant dark`; the 6 ghost tokens cleared; z-layer scale; `animate-in` dead classes replaced with 4 real keyframes; MCP badge mappings unified; terminal colors hooked into the theme; deleted `pages/NewTaskModal.tsx` and 7 places of dead CSS |
| 1 | `Spinner` / `IconButton` / `Button` (4 fixed heights + focus ring + `type="button"` + 3 new variants); `shared/Button` and `shared/Spinner` deleted, 24 imports migrated |
| 2 | `Badge` / `StatusDot` / `Checkbox` / `Switch`; replaced 2 MCP badges, 2 `animate-pulse` misuses, and 2 Switch implementations |
| 3 | `EmptyState` / `ErrorState` / `LoadingState`; deleted 5 same-named local definitions |
| 4 | Created `ui/` and `composite/`, emptied and deleted `shared/` and `common/`; `chat/clipboard.ts` → `lib/clipboard.ts` to untangle the layering inversion; added contract tests to both directories |
| 5 | Strengthened `Input` + `TextArea` / `SelectField` / `SearchField` / `SegmentedControl` |
| 6 | `useDismissable` / `useAnchoredPosition`; replaced the 59 byte-for-byte duplicated lines in `ChatInput` and `EmptySession` |
| 7 | `Tooltip`; `Dropdown` gained listbox semantics, arrow keys, and focus management |
| 8 | `Skeleton` family / `Card` / `Progress` |

### Four deviations from this plan

1. **The z-layer order changed**. Section 14 of this document put `dropdown: 60` below `dialog: 80`; it was actually changed to dropdown (70) > dialog (60). Reason: a modal dialog covers the background, so an open dropdown necessarily belongs to the topmost dialog; with the original order, the `DirectoryPicker` inside the `AgentManager` modal would be covered by the dialog and unusable — exactly why it had hard-coded `zIndex: 9999` in the first place.

2. **`Badge` has no `solid` variant**. On inventory, all 45 badges are tinted, with not a single solid semantic badge; `solid` would need a readable foreground defined for every tone × every theme (12 tokens) with no callers. It became two variants, `soft` / `outline`, plus a `bordered` switch.

3. **`Menu` wasn't created**. The 28 hand-rolled dropdowns behave differently, and unifying them all at once was too risky. Instead: `Dropdown` gained full listbox semantics, and the two hooks `useDismissable` + `useAnchoredPosition` were delivered — the 28 places can converge one by one using these two hooks without a one-shot replacement.

4. **`Spinner` has no `respectReducedMotion` prop**. Reduced motion is instead handled globally in CSS, and it **slows down** (1s → 2.4s) rather than stopping: a spinner's only job is to express "in progress", and a stopped one reads as a frozen UI.

### Three things found in the real-device walkthrough (`gallery.html`)

Found only by opening the gallery after unit tests were all green; none are structural problems:

1. **`Button` / `IconButton` didn't forward refs** → `Tooltip` couldn't find its anchor, and `Dropdown` lost focus after closing. Only a console warning, no error. The original tests all used native `<button>` as the trigger (DOM elements accept refs natively), so they couldn't catch it. Added `forwardRef` + two tests using function components as triggers.

2. **The light theme's warning badge contrast was 2.66:1** (AA requires 4.5). The root cause was using `--color-warning` directly as the foreground on `--color-warning-container`. Added three groups of `--color-on-success/warning/info-container`, 9 tokens in total, and `Badge` now uses them; the worst contrast across the three themes went from 2.66 to 5.48. Added `theme/contrast.test.ts`, which parses tokens and computes contrast as a gate (**counter-verified**: reverting the values makes the test reproduce exactly 2.66:1 and go red).

3. **`Dropdown`'s Escape also closed the outer `Modal`**. This was a regression I introduced while rewriting `Dropdown` — the original implementation used capture + `stopPropagation`, which `useDismissable` initially lacked. Added a `stopEscapePropagation` option.

### Environment issue (pre-existing, not addressed)

`desktop/package.json` declares `"react": "^19.2.4"`, but `bun.lock` locks `^18.3.1`, and 18.3.1 is what's actually installed (the repository root's node_modules, oddly, has 19.2.4). So this effort used `forwardRef` rather than React 19's ref-as-prop. **Upgrading React was out of scope and not changed.**

---

## Appendix 3: Multi-agent parallel replacement (second round the same day)

After the component library was built, 6 parallel agents converged the scattered hand-written UI onto it.

### Partitioning

The worktree is shared, and concurrent writes to the same file overwrite each other, so **file-area isolation is a hard constraint, not a suggestion**. Every agent's prompt hard-coded the "never touch" directories.

| Agent | Scope |
|---|---|
| pages | `src/pages/**` |
| chat | `components/chat/**` |
| layout | `layout/` `workspace/` `workbench/` |
| market | `market/` `plugins/` `tasks/` `search/` `skills/` |
| settings | `settings/` `trace/` `browser/` `activity/` `controls/` `composite/` `teams/` `doctor/` `features/pets/` |
| i18n | `src/i18n/**` + hard-coded copy everywhere (started only after the first five finished, to avoid conflicts) |

Also required: **don't run the full test suite** (during parallel work you'd see red from others' half-finished changes; only run your own scope), **conservative first** (skip when unsure and state why), and **named protection for performance-sensitive areas** (files with virtual scrolling, `content-visibility`, or runtime-injected CSS variables get only the safest replacements).

### Results

**349** component adoptions, **294** native `<button>` remaining — reuse rate from 22% at audit time to **54%**.
Hand-written outside-click went from 21 places down to **2** (`useDismissable` adopted in 20 places).
Tests went from 250 files/2893 cases → **253/2919**, with `check:desktop` all green.
i18n gained 35 new keys × 5 locales, with locale files reaching 0 missing / 0 extra.

### Three things only parallel work exposed

1. **The `Dropdown` trigger rework was a breaking change, and it failed silently.** After changing the trigger from "rendered inside a wrapper" to `cloneElement` injecting ref/aria/onClick, the filter chips in `market/FilterBar` couldn't be clicked at all — `FilterTrigger` is a function component that doesn't forward props, so the injected onClick landed nowhere. No error, tests all green; an agent caught it by clicking manually while replacing that file.

   Hardened: audited all callers (only this one; the rest are native `<button>`); `Dropdown` gained a dev-time assertion that `console.warn`s if the trigger doesn't forward ref; added two tests (a non-forwarding trigger indeed can't open, a correct one doesn't warn). **This and the missing forwardRef on `Button`/`IconButton` are two faces of the same root cause** — in one the component itself doesn't forward, in the other a caller's custom trigger doesn't.

2. **An agent refused to carry out my wrong instruction.** I told it to use `tone="auto"` for the progress bar in `teams/TeamStatusBar`; it pointed out that `auto` means "turn green at 100%", while that progress bar means "turn green when nothing is running" — 1 done + 1 errored = 50%, so `auto` wouldn't turn green. It wrote an explicit condition and explained the deviation in its report.

3. **Component gaps were cross-confirmed by multiple independent sources.** Three agents each hit "`IconButton` lacks a `secondary` tone" in their own scope, each giving specific files and line numbers. Similarly: `2xs` (20px) and `xl` (40px) sizes, `bordered`, `hoverTone="danger"` (delete icons that are red at rest read as an error state), `pressed`, `surface="sidebar"` (the sidebar has its own hover token, differing from `--color-surface-hover` in all three themes), plus `Button`'s `base` (h-8) and `Badge`'s `wrap`/`title`/rest props passthrough. All have been added with tests.

   None of these were "agents lazily forcing it with className"; they correctly identified "missing variant" per the criteria in AGENTS.md §3.6 and reported it. That section has been expanded into §3.7 to codify this process.

### Dead things cleared along the way

- `layout/TitleBar.tsx` (96 lines) — zero references. The audit's "settings entry has no name for screen readers" **was never rendered at all**.
- 5 `scheduledPage.col*` i18n keys × 5 locales — the table layout had long been replaced by a card layout.
- A stale `vi.mock` in `RepositoryLaunchControls.test.tsx` (the path didn't follow the migration, silently losing isolation). Added `__tests__/mockPaths.test.ts` as a repo-wide gate.
- The byte-for-byte identical progress bars in `SessionTaskBar` and `TeamStatusBar` are now both `Progress`.

### New gates

- `__tests__/mockPaths.test.ts` — every `vi.mock` path resolves
- `theme/paletteEscapes.test.ts` — forbids new raw Tailwind palette colors that bypass tokens (things like `bg-amber-50` don't follow `data-theme`, and `tokenUsage.test.ts` can't see them because they aren't `var()`). 4 existing files are allowlisted, but the list may not grow and new files may not join.

---

## Appendix 4: Second round of parallel replacement

All five reports from the first round recorded "skipped because the component lacks X". After filling those gaps, another round was run with **each agent's own skip list**.

### Results

| | At audit | After round 1 | After round 2 |
|---|---:|---:|---:|
| Component adoptions | 102 | 349 | **524** |
| Remaining native `<button>` | 362 | 294 | **179** |
| Componentization rate | 22% | 54% | **75%** |

Tests: **253 files / 2929 cases**, with `check:desktop` all green.

### Component capabilities added in round 2

`IconButton`'s `2xl` (44px), `solid`, `disabledStyle`; `Button`'s `inverse`; rest props passthrough on `Badge`/`Progress`; `SearchField`'s `clearLabel`; and the `--color-on-error` token.

### A falsely green test masking a non-working feature

In round 2, the pages agent **actually compiled Tailwind v4** to verify class conflicts rather than guessing, and concluded: **arbitrary values of the same utility are ordered alphabetically by value, and the last one wins, regardless of the order passed in.**

As a result:

- **`hoverTone="danger"` had no effect at all with `tone="muted"` or `secondary`** — those two tones' hover already carries `hover:text-[var(--color-text-primary)]`, which sorts alphabetically after `hover:text-[var(--color-error)]` and always wins. And those are exactly the two combinations the feature was created to serve.
- The same mechanism also meant a caller's `disabled:opacity-0` couldn't beat the component's `disabled:opacity-50`.

**The original test only asserted that the class string "contains" the red class, never that the neutral class was removed, so it stayed green all along.** This is exactly the trap §3.6 warns others about, and the component library fell into it itself.

The fix made the two **mutually exclusive** rather than stacked: hover background and hover text color were split into two tables, and `hoverTone` replaces the tone's own text color; `disabled` opacity became a `disabledStyle` prop. The new test asserts that there is **exactly one** `hover:text-*` class, parameterized over all 5 tones — counter-verified: restoring the old implementation turns exactly `secondary` and `muted` red, matching the compilation conclusion exactly.

### The component library violating its own conventions (two places, both fixed)

1. **`SearchField` building English** — internally it assembled the aria-label with `` `Clear ${label}` ``, so any caller that had already translated its clear button regressed i18n by adopting it. Two agents independently listed it as a reason they "couldn't adopt".
   > The first fix, `clearLabel ?? label`, was wrong: the input and the clear button got the **same** accessible name, and `getByLabelText` threw "found multiple". It was finally made **required** — the same design as `IconButton.label`, forcing callers to provide a translation.
2. **`Badge` / `Progress` didn't pass through rest props** — once a caller needed `data-testid` it had to fall back to a hand-written span, which is exactly the source of duplication.

### More dead code cleared

`pages/ToolInspection.tsx` and `pages/AgentTeams.tsx` — an agent verified they're not among the 9 pages imported by `ContentRouter` and `AppShell`, and are referenced only by tests. Deleted together with the 5 references in `pages.test.tsx`.

### The remaining 179, by category

All are things that **semantically shouldn't use a generic component**: `role="tab"` / `menuitem"` / `option"` / `treeitem"` / `gridcell"` elements, clickable whole rows and whole cards, file tree nodes, drag handles, OS title bar buttons, and the diff cells in `WorkspaceDiffSurface`. The five reports state the reason for each.

A few exceptions, with evidence:

- **`ChatInput`'s plus/send buttons** — `ChatInput.test.tsx:1451` pins `h-11 w-11`; even with `2xl` (44px) added, the send button has a dual fill ("error-container when stopping / otherwise primary gradient") that no variant can express.
- **The only 2 remaining palette usages in `Settings.tsx`** — inside a QR code frame with a hard-coded white background (scanning needs contrast); switching to theme tokens would give a white background with light text in dark mode. The agent switched them and then reverted them itself, leaving a comment.
- **The spinner in `activity/SessionActivityPanel`** — this file has a `motion-safe:` / `motion-reduce:` reduced-motion strategy, with a test asserting that bare `animate-spin` must **not** appear inline; while `Spinner` intentionally emits bare `animate-spin` (it slows down rather than stopping). A genuine conflict.
- **The heatmap tooltip in `ActivitySettings`** — one tooltip is reused across ~365 cells, and `Tooltip` clones a single trigger, so wrapping it would mean 365 portals.

### Still outstanding

- `composite/OpenWithMenu` isn't hooked up to `useAnchoredPosition` (`anchor` is a rect rather than a ref, and the change must go together with its 3 callers in `chat/`).
- `ConversationNavigator`'s side tooltip — `useAnchoredPosition` only has top/bottom placements, no left/right.
- `Card` is still only used in new code; container combinations haven't been bulk-replaced.
- `MessageBlocks`' `ROLE_STYLES` still uses `/8` alpha fills and needs a new soft token.
