/**
 * Class recipes shared by the composer's popovers (model, effort, permission
 * mode, the + menu, slash commands, @ references) — the 「素」 menu pattern in
 * one place, so the six surfaces cannot drift into six slightly different
 * menus again.
 */

/** Frosted glass sheet, hairline rim, card corner, dropdown glass shadow, 4px inset. */
export const COMPOSER_POPOVER =
  'dropdown-glass popover-motion rounded-[var(--radius-lg)] p-1'

/** A menu row: 32px minimum, the row corner, 13px. Hover doubles as highlight. */
export const COMPOSER_MENU_ITEM =
  'flex min-h-8 w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[13px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]'

/**
 * The current value in a single-select popover (model, permission mode, agent
 * profile) keeps the neutral hover fill at rest. These rows mark the value with
 * their own check/brand glyph and deliberately avoid a filled selection row;
 * leave them on the page wash.
 */
export const COMPOSER_MENU_ITEM_ACTIVE = 'bg-[var(--color-surface-hover)]'

/**
 * Suggestion rows (slash commands, `@` references, the `+` menu) paint on the
 * dense composer menu sheet, where the page hover wash is invisible. Their
 * hover and keyboard-selected states carry the brand tint instead; the selected
 * row adds a brand rim so the active line is unmistakable (#2013).
 */
export const COMPOSER_MENU_ITEM_HOVER = 'hover:bg-[var(--color-menu-item-active)]'
export const COMPOSER_MENU_ITEM_SELECTED =
  'bg-[var(--color-menu-item-active)] ring-1 ring-inset ring-[var(--color-brand)]'

/** Group heading: 11px semibold tertiary, sentence case. */
export const COMPOSER_MENU_SECTION =
  'px-2 pb-1 pt-2 text-[11px] font-semibold text-[var(--color-text-tertiary)]'

/** Hairline between groups inside a menu. */
export const COMPOSER_MENU_SEPARATOR = 'mx-1 my-1 h-px bg-[var(--color-border)]'

/** Keyboard hint chip: mono 11px, 18px tall, chip corner, white ground. */
export const COMPOSER_KBD =
  'inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-1 font-mono text-[11px] text-[var(--color-text-tertiary)]'

/** A 28px toolbar control in the composer's bottom row. */
export const COMPOSER_TOOLBAR_CONTROL =
  'inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-50'
