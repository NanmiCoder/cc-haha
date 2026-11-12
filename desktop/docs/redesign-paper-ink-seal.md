# "Paper · Ink · Seal" Redesign Spec

This document is the working standard for the desktop app's overall visual overhaul. Read it together with [`desktop/src/components/AGENTS.md`](../src/components/AGENTS.md) (hard constraints for components and tokens; that file wins on conflicts).

## The only boundary: reskin only, don't touch functionality

- Allowed to change: `className`, inline presentation styles, purely presentational DOM structure, visual wording in i18n strings.
- **Not allowed to change**: any logic in `stores/`, `api/`, or `hooks/`, event handlers, state transitions, data contracts, or component props semantics.
- **Features** that exist in the mockup but not in the original project (e.g. the three suggestion pills in the empty state) are **not added**.
- UI that exists in the original project but isn't drawn in the mockup is **not removed**; bring it in line with the same rules.

Rule of thumb: if a change would make a behavior assertion (click, request, state) in some `.test.tsx` fail, it's out of bounds; only snapshot-style style assertions should change with it.

## Design stance

Layered warm paper backgrounds + ink primary buttons + serif headings + a terracotta seal. Hierarchy comes from **background layering and 1px hairline borders**, not heavy shadows.

## Tokens (finalized; do not change `theme/globals.css`)

The six themes (`white` pure white / `paper` paper & ink / `warm-classic` classic warm / `celadon` celadon / `dark` ink night / `ink-blue` ink night blue) only swap a set of `--cc-*` source variables, which the `:root` semantic layer maps to `--color-*`. **Components only ever use `--color-*` / `--radius-*` / `--shadow-*` / `--z-*`; never use `--cc-*` directly.**

| Role | Token |
|---|---|
| Page background | `--color-surface` / `--color-background` |
| Sidebar and secondary panel background | `--color-surface-container-low` |
| Hover / selected | `--color-surface-hover` / `--color-surface-selected` |
| Card inset | `--color-surface-container` |
| Regular border / strong border | `--color-border` / `--color-outline` |
| Primary / secondary / muted text | `--color-text-primary` / `--color-text-secondary` / `--color-text-tertiary` |
| Terracotta primary / dark / soft background / outline | `--color-brand` / `--color-brand-hover` / `--color-brand-soft` / `--color-primary-fixed-dim` |
| **Text on terracotta soft background** | `--color-on-brand-soft` (**not** `--color-brand`; see below) |
| Status colors | `--color-{success,warning,error,info}` + `-container` + `--color-on-*-container` |
| Ink primary button | `--color-btn-primary-bg` / `--color-btn-primary-fg` |

**Status colors are used in pairs.** `--color-<tone>` is the indicator color (outlines, icons, underlines); `--color-on-<tone>-container` is the **text** color on the `-container` background. Using `--color-brand` directly as text on `--color-brand-soft` gives only 4.3:1 in the two ink themes, below AA. `contrast.test.ts` will fail.

### Radius scale

`--radius-sm` 6 (small badges) / `--radius-md` 10 (buttons, inputs) / `--radius-lg` 13 (card inner elements) / `--radius-xl` 17 (cards) / `--radius-2xl` 20 (composer) / `--radius-3xl` 24 (modals) / `--radius-full` pills.

Write `rounded-[var(--radius-md)]`, **not** `rounded-md` (Tailwind's `rounded-lg` is 8px while `--radius-lg` is 13px — same name, different value).

### Three shadow levels

`--shadow-card` (card at rest) / `--shadow-composer` (composer, card hover lift) / `--shadow-overlay` (overlays, dropdowns, modals).

### Typography

- Headings use `style={{ fontFamily: 'var(--font-headline)' }}`: all h1/h2/h3, large page titles, large stat numbers, large values in popovers (context percentage, reasoning level name). CJK text falls back to the system serif, which is expected.
- Body defaults to `--font-body`, 14px / 1.5.
- Code, paths, shortcuts, IDs, durations, and token counts use `--font-mono` (Tailwind `font-mono`).
- Font size scale: 11 / 12 / 12.5 / 13 / 13.5 / 14 / 14.5 / 15 / 16.5 / 21 / 24–28 (serif page titles) / 32 (detail page titles).

## Component rules

Prefer the primitives in `components/ui/`; don't hand-write `<button>`. The table is in section one of `components/AGENTS.md`.

Already updated to the mockup and ready to **reuse directly**:

- `Button` — `primary` is already solid ink + turns terracotta on hover + lifts 1px + `active:scale(.97)`; the disabled state is opaque `--s1`/`--t3`.
- `Card` — adds two props, `shadow` (`none`/`card`/`composer`) and `lift` (lifts 2px on hover), plus `radius="2xl"`. **Don't pass `lift` and `shadow` together**; two `shadow-[…]` classes don't stack.
- `IconButton` / `Badge` / `Modal` (radius already 24) / `SegmentedControl` / `Switch` / `Progress` — all use tokens and follow the theme.
- `composite/BrandSeal` — the cc-haha brand mark (a vector rebuild of the original app icon), `sm` 24 / `md` 32 / `lg` 38 / `xl` 80, with detail removed as size shrinks (the starburst only appears at `xl`, the cursor is dropped at `sm`).

Unified focus state: `focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]`.

### Motion

- Buttons: `transition-[background-color,color,border-color,box-shadow,transform] duration-150 ease-out`.
- Card hover lift uses `Card`'s `lift`.
- Screen entrance uses `.animate-screen-pop`.
- Existing: `.animate-spin` (.9s), `.animate-pulse-dot` (1.6s), `.animate-overlay-in*`.
- Every motion with movement needs a `motion-reduce:` fallback.

## Common patterns

- **Page header**: serif 24–28px title + secondary description line + ink primary button on the right.
- **Stat card**: `Card` + large serif number (21–26px) + 12px `--color-text-tertiary` label.
- **List row**: status dot + main title + 12.5px secondary info + mono metric on the right; hover shows `--color-surface-hover`.
- **Chip / pill**: `rounded-full`, 1px `--color-border`, turns `--color-outline` on hover; active state is `--color-brand-soft` background + `--color-on-brand-soft` text + `--color-primary-fixed-dim` outline.
- **Alert bar**: `--color-{warning,error}-container` background + `--color-on-*-container` text + same-color outline.
- **Frosted overlay**: the `glass-panel` class (already includes blur 18px + `--shadow-overlay`).
- **Code block**: `--color-code-bg` background + `font-mono` 13px/1.7 + a header with Copy.

## Hard constraints (will turn CI red)

- Don't use Tailwind palette colors (`bg-amber-50`, `text-red-400`…) — they don't follow `data-theme`. `paletteEscapes.test.ts` catches them.
- Don't use `/N` alpha modifiers (`bg-[var(--x)]/10`) — the Safari 15 WebView can't parse them. For soft backgrounds, use the existing `-soft` / `-container` tokens.
- Don't write bare `zIndex: 9999` or `z-[10000]`; layering must come only from `--z-*`.
- Don't hard-code hex values.
- All user-visible text (including `aria-label` and `title`) goes through `useTranslation()`, added for every supported locale.
- Icon buttons must have a name (use `IconButton`; `label` is required).
- Components that overlays anchor to must use `forwardRef`.

## Reference prototype

`CC Haha.dc.html` under `/Users/nanmi/Downloads/design_handoff_cc_haha_redesign/` is the high-fidelity interactive prototype, and README.md there is the pixel-level spec. Open the prototype directly in a browser to interact with it.
