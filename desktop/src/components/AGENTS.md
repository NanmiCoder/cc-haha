# Desktop Component Guidelines

This document provides the reusable component index, placement rules, and styling / i18n / accessibility / testing conventions. Look up the section for the components your change touches; there's no need to reread the whole thing before every edit.

Rule precedence: root `AGENTS.md` < `desktop/AGENTS.md` < this file. This file wins on conflicts.

Companion doc: [`desktop/docs/component-library-plan.md`](../../docs/component-library-plan.md) records audit evidence and follow-up plans.

---

## 1. I want to do X — what do I use?

Check this table first. **Don't write another one.**

| Need | Use this | Location |
|---|---|---|
| Button with text | `Button` | `ui/Button.tsx` |
| Icon-only button | `IconButton` | `ui/IconButton.tsx` |
| Loading spinner | `Spinner` | `ui/Spinner.tsx` |
| Status badge / count | `Badge` | `ui/Badge.tsx` |
| Status dot | `StatusDot` | `ui/Badge.tsx` |
| Checkbox | `Checkbox` | `ui/Checkbox.tsx` |
| Toggle switch | `Switch` | `ui/Switch.tsx` |
| Single-line input | `Input` | `ui/Input.tsx` |
| Multi-line input | `TextArea` | `ui/TextArea.tsx` |
| Dropdown with plain-text options | `SelectField` | `ui/SelectField.tsx` |
| Dropdown with icons / descriptions | `Dropdown` | `ui/Dropdown.tsx` |
| Search box | `SearchField` | `ui/SearchField.tsx` |
| Segmented control / tabs | `SegmentedControl` | `ui/SegmentedControl.tsx` |
| Empty state | `EmptyState` | `ui/EmptyState.tsx` |
| Error state | `ErrorState` | `ui/ErrorState.tsx` |
| Loading state | `LoadingState` | `ui/LoadingState.tsx` |
| Skeleton | `Skeleton` / `SkeletonRows` / `SkeletonCards` | `ui/Skeleton.tsx` |
| Progress bar | `Progress` | `ui/Progress.tsx` |
| Card container | `Card` | `ui/Card.tsx` |
| Dialog | `Modal` | `ui/Modal.tsx` |
| Dialog + a row of buttons | `ActionDialog` | `ui/ActionDialog.tsx` |
| Confirm / delete confirmation | `ConfirmDialog` | `ui/ConfirmDialog.tsx` |
| Mobile bottom sheet | `MobileBottomSheet` | `ui/MobileBottomSheet.tsx` |
| Hover tooltip | `Tooltip` | `ui/Tooltip.tsx` |
| Copy button | `CopyButton` | `ui/CopyButton.tsx` |
| Directory picker | `DirectoryPicker` | `composite/DirectoryPicker.tsx` |
| "Open with X" menu | `OpenWithMenu` | `composite/OpenWithMenu.tsx` |
| cc-haha brand mark | `BrandSeal` | `composite/BrandSeal.tsx` |

### Three hooks

| Need | Use this |
|---|---|
| Close an overlay on outside click / Esc | `hooks/useDismissable.ts` |
| Position an overlay against its trigger (with flipping and clamping) | `hooks/useAnchoredPosition.ts` |
| Limit the height of an upward-opening `bottom-full` overlay to the space above | `hooks/useRoomAbove.ts` |

**Don't hand-write `document.addEventListener('mousedown', ...)` anymore.** `mousedown` is unreliable on touch screens; this is the root-cause category behind "tapping outside doesn't close the menu" on H5. `useDismissable` uses `pointerdown` by default.

When an overlay opens inside a `Modal`, pass `stopEscapePropagation: true`; otherwise a single Esc closes both the dropdown and the dialog.

### Explicitly not built

`Table` (there are 0 `<table>` elements in the whole codebase; tabular data uses CSS Grid), `Divider` (`divide-y` is enough), `Avatar` (`market/SkillAvatar` already exists), virtual scrolling libraries (they would break the "virtualized items disable content-visibility" invariant).

---

## 2. Where new components go

```
components/ui/         Primitives with no business semantics. Must not import stores/ or api/
components/composite/  Business composites. May import stores/api, but must have ≥2 callers
components/<feature>/  Feature directories. Single-caller components always go here
```

Decision tree:

1. **Only one caller?** → Put it in the caller's feature directory, not `ui/` or `composite/`.
   > `composite/contract.test.ts` asserts ≥2 callers for each file; single-caller components fail it.
2. **Needs to read a store or call an API?** → `composite/` (and it must have ≥2 callers).
3. **Pure UI with no business semantics?** → `ui/`.
   > `ui/contract.test.ts` asserts: no imports from stores/api, no imports from other feature directories, no hard-coded hex, no Tailwind radii such as `rounded-md`.

`shared/` and `common/` have been deleted; **don't recreate them**. Their problem was that the names had no binding force: both directories were created in the same commit, the split criteria were never written down, and a year later each was stuffed with a mix of primitives and business components, 35% of them single-caller pseudo-shared components. The three rules above are the only distinction, and they're the part CI can check.

**Always import via the `@/` alias**: `import { Button } from '@/components/ui/Button'`.

---

## 3. Styling

### 3.1 Colors may only come from tokens

```tsx
// Right
className="bg-[var(--color-surface)] text-[var(--color-text-primary)]"
// Wrong: looks identical in all three themes
className="bg-[#FAF9F5] text-[#1B1C1A]"
```

The three themes (`white` default / `light` / `dark`) are switched via `<html data-theme>` and **don't follow the operating system**. New tokens must be defined in all three theme blocks; `globals.test.ts` checks this.

`tokenUsage.test.ts` scans all source and asserts that every `var(--token)` resolves — a misspelled token doesn't error, it just silently renders as a transparent background or a `currentColor` border.

### 3.2 Status colors are used in pairs

Semantic colors come in pairs: `--color-<tone>-container` is the background, and `--color-on-<tone>-container` is the text color on top of it. **Don't use `--color-warning` directly as the foreground on `--color-warning-container`** — in the light theme that gives only 2.66:1, far below AA's 4.5.

`contrast.test.ts` computes actual contrast for three themes × six tones and asserts ≥4.5 (dark containers are semi-transparent, so the test composites them over the surface first).

### 3.3 Radii

Use `rounded-[var(--radius-md)]`, not `rounded-md`. They share names but not values (Tailwind's `rounded-lg` is 8px, `--radius-lg` is 12px); mixing them is where the codebase's 21 different radii came from.

### 3.4 Layering

z-index may only come from the layer scale in `globals.css`:

```tsx
className="z-[var(--z-dropdown)]"
style={{ zIndex: 'var(--z-dialog)' }}
```

Order: `base 0 → raised → sticky → nav → scrim → drawer → dialog 60 → sheet 65 → dropdown 70 → popover 75 → tooltip 80 → toast 90`

Two deliberate orderings: **dropdown above dialog** (a modal dialog covers the background, so an open dropdown necessarily belongs to the topmost dialog — this is why `DirectoryPicker` was once forced to write `zIndex: 9999`), and **toast above sheet** (otherwise users can't see feedback from actions taken inside a sheet).

`tokenUsage.test.ts` rejects any bare `zIndex: 9999` or `z-[10000]`.

### 3.5 The `dark:` variant

You can use it; it's bound to `[data-theme="dark"]` (see `@custom-variant dark` at the top of `globals.css`). **But prefer tokens** — `dark:` only covers one of the three themes, so white and light share the same values.

### 3.6 className overrides aren't guaranteed to win

Components don't resolve Tailwind conflicts (that would need the `tailwind-merge` dependency, and this project doesn't add UI dependencies). In `<Button size="sm" className="px-3">`, whether `px-2` or `px-3` wins depends on their order in the generated stylesheet, not the order in the class attribute.

**If you find yourself repeatedly overriding the same set of utilities via className, a variant is missing — go add it.**

### 3.7 What to do when a component can't express the style you need

**Don't force it with className, and don't fall back to a hand-written `<button>`.** The correct order is:

1. First confirm this isn't a case that "should be custom anyway". List items, tree nodes, tab items, drag handles, and OS window buttons shouldn't be crammed into generic components.
2. If it's a generic need (the same shape appears in multiple places), **add a variant/tone/size to the component**, together with tests.
3. Fill in the needed component capability within the current task's scope, and verify callers, interactions, and theme results. Only ask for confirmation when a necessary product decision is missing or it's outside the authorized scope; for anything you can't finish, state the specific blocker.

`IconButton`'s `secondary` tone, six sizes `2xs`–`2xl`, `bordered`, `solid`, `hoverTone="danger"`, `pressed`, `surface="sidebar"`, `surface="terminal"` (ink terminal title bar, on which `--color-text-tertiary` is invisible in the paper theme); `Button`'s `base` (h-8), `inverse`, and `tonal-outline` (terracotta outline, inverted on hover) variants; `Card`'s `shadow`/`lift`/`container` levels and rest-prop passthrough; `Badge`'s `wrap`/`title`/rest passthrough; `SearchField`'s `clearLabel` and `xl` (44px) size — all came out of this process. Several independent rounds of replacement work each hit the same set of gaps, which were then filled in one go.

A few reasons worth remembering:

> **`hoverTone="danger"`** — Delete-style icons that are red at rest read as "currently in an error state". Use `muted` at rest and only turn red on hover.
>
> **`surface="sidebar"`** — The sidebar has its own hover token (`--color-sidebar-item-hover`), which differs from `--color-surface-hover` in all three themes. Overriding via className results in two `hover:bg-[…]` classes fighting, with the winner decided by stylesheet order.
>
> **`solid` vs `filled`** — `filled` is only a light tint and gets muddy on top of user-uploaded images. `solid` is a full-strength fill + contrasting foreground (via tokens like `--color-on-error`; **don't write `text-white`** — in the dark theme `--color-error` is light red, and white text is unreadable).
>
> **`2xl` (44px)** — The platform minimum for primary touch targets on mobile. `ChatInput`'s input bar buttons have tests pinning this size; shrinking to 40px is a regression.
>
> **`SearchField`'s `clearLabel`** — The component once built English internally with `` `Clear ${label}` ``, so any caller that had already translated its clear button regressed i18n by adopting it. **The component library itself must never build user-visible English.**

### 3.8 "Plain Porcelain" visual constraints

The full redesign in 2026-10 converged the UI onto a checkable set of constraints, each guarded by `src/theme/designSystem.test.ts` (violations are listed as file:line):

- **Font sizes only** 11 / 12 / 13 / 14 / 15 / 18 / 22 / 26 (`text-xs`, `text-sm`, `text-lg` are allowed; `text-base/xl/2xl…` and fractional sizes are not).
- **Maximum font weight is semibold**: Inter is only self-hosted up to 600, and `font-bold` makes the browser synthesize a blurry bold; `font-mono` is never paired with semibold (JetBrains Mono only has 400).
- **No italics or wide-tracked uppercase labels for CJK text**; summary lists in CJK use 「、」 as the separator.
- **Icons are lucide only** (`strokeWidth={1.75}`); `IconButton`'s `icon` only accepts elements, no longer Material strings.
- **Radii only from tokens**: `--radius-xs` 4 / `sm` 6 / `md` 8 / `lg` 12 / `xl` 16 / `3xl` 20 / `full`.
- **Status color semantics are fixed**: running = info, waiting for your confirmation = warning, done = success, failed = error; terracotta is only for the brand, the send button, and selection indicators.
- Settings pages all use the skeleton from `components/settings/SettingsSection.tsx` (PageHeader → Section → Group → Row).

---

## 4. Desktop hard constraints

- **No UI dependencies.** shadcn/ui was just rolled back on 2026-07-25.
- **Don't use `/N` alpha modifiers for key colors** (`bg-[var(--x)]/10`). They compile to a color function the Safari 15 WebView can't parse, and `vite-config.test.ts` has whole-file assertions on `globals.css`. For soft backgrounds, add a solid token (e.g. `--color-brand-soft`).
- **No barrel `index.ts` files.** There's zero precedent in the project, and they hinder tree-shaking.
- **Put `content-visibility` in a CSS class, not an inline style** — inline styles bypass the override that disables it for touch H5.
- The same bundle serves the Electron shell / desktop browser / mobile H5. Touch-only styles are scoped under `html[data-touch-h5]`.
- **Components that overlays anchor to must use `forwardRef`.** Both `Tooltip` and `Dropdown` attach a ref to the trigger; a component that doesn't forward refs leaves the tooltip unable to position and loses focus after the dropdown closes, with **only a console warning**, no error.

---

## 5. i18n

All user-visible text goes through `useTranslation()`, including `aria-label` and `title`.

The component library doesn't contain string literals in any language internally — default text (such as `ConfirmDialog`'s button labels) is passed in by the caller.

---

## 6. Accessibility baseline

New components must meet:

- **Focusable elements have a visible focus ring**: `focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]`
- **Icon buttons have a name**: use `IconButton`, whose `label` is required
- **Input controls have an associated label**: generate ids with `useId()`, **don't derive them from label text** — CJK text has no spaces, so two CJK labels can collide on id, leaving one `<label>` pointing at another field's input
- **Error messages have `role="alert"` and are referenced by `aria-describedby`**
- **Overlays use the correct role**: put `role="option"` inside `role="listbox"`, not `<button>`
- **Tooltips use `aria-describedby`, not `aria-label`** — the latter overrides the element's own name, so an icon button is read as its tooltip text rather than its action
- **Don't mix description text into the accessible name**: when a `<label>` wraps both a title and a description, use `aria-labelledby` to point precisely at the title span

---

## 7. Testing

New components must have a matching `.test.tsx`. Three templates you can copy:

```tsx
// 1. Accessibility contract
it('names the button for screen readers from label', () => {
  render(<IconButton icon={<span />} label="Open settings" />)
  expect(screen.getByRole('button', { name: 'Open settings' })).toBeInTheDocument()
})

// 2. Props matrix
it.each(SIZES)('pins an explicit height for size=%s', (size) => {
  const { container } = render(<Button size={size}>Label</Button>)
  expect(container.firstElementChild?.className).toMatch(/\bh-\d/)
})

// 3. Regression anchor: the comment states exactly what used to break
it('defaults to type="button" so it cannot submit a surrounding form', () => {
  render(<Button>Run</Button>)
  expect(screen.getByRole('button', { name: 'Run' })).toHaveAttribute('type', 'button')
})
```

**Three known jsdom deviations** — don't waste time on these:

- `fireEvent.click` on a `disabled` `<input>` **still** fires change (even for a bare input). Assert `toBeDisabled()` instead of simulating a click.
- `scrollIntoView` isn't implemented. Use an optional call `?.scrollIntoView?.()` in source.
- `getBoundingClientRect` always returns all zeros. To test positioning logic, stub the rect with a **ref callback** — it runs synchronously on DOM mount, before the layout effect that measures; putting it in the render body is one frame too late.

**Tests that use real DOM elements as triggers miss a whole class of bugs.** Overlay component tests must include at least one case that passes a **function component** (`<Button>` rather than `<button>`) — ref forwarding failures only show up in that case.

**For what unit tests can't catch, open the gallery**:

```bash
cd desktop && bun run dev
```

Open `http://localhost:1420/gallery.html`. It renders all `ui/` components, with a three-theme switcher in the top right. Whether colors are readable, overlays cover correctly, and entrance animations actually animate — you only know once it's rendered. Add new components to `src/dev/ComponentGallery.tsx` as well.

> The gallery is only reachable in dev and isn't part of the production build (vite's build input is only `index.html`).

---

## 8. Verification and delivery

While iterating, run the relevant component tests; at the end, run the checks selected by `bun run check:impact` per the root rules. `bun run check:desktop` already includes lint, the full test suite, and build, so there's no need to run lint / test separately first. Use `bun run verify` when you need PR-ready or full verification; with no further changes or unresolved risks, checks that already passed don't need to be rerun.

Self-check list:

- [ ] No new component duplicates one in the section 1 table
- [ ] The new component is in the correct directory (section 2 decision tree)
- [ ] Colors, radii, and layering all come from tokens
- [ ] Focus ring present; icon buttons have names; input controls have labels
- [ ] Matching tests exist, and overlay components are tested with a function-component trigger
- [ ] Visual changes were checked in the gallery in all three themes
