/**
 * One tab style for every tab strip in the app: the session tabs above the chat
 * and the resource tabs above the workspace panel. Both strips sit on the
 * sidebar's ground (the "trough"), and a tab is a 28px chip on it.
 *
 * Three tiers, each strictly stronger than the one before:
 *
 * - idle: no fill, tertiary label.
 * - hover: a paper fill with the faint `--color-tab-separator` ring. Not
 *   `--color-surface-hover`: that token is tuned for hovering *on* paper, and on
 *   the two ink themes it is brighter than paper (dark #2B271F vs #201D17), so a
 *   hovered tab would outshine the selected one. The ring is needed because
 *   paper against the trough is only 1.05–1.10:1 — a fill alone has no shape.
 * - active: the same paper fill with the full `--color-tab-edge` ring, a hair
 *   of shadow and the medium label weight. `--color-border` cannot draw that
 *   edge: it is calibrated against paper and lands at 1.12:1 on the trough
 *   (see the tab-strip block in theme/contrast.test.ts).
 *
 * The rings are box-shadows rather than borders, so switching tiers never
 * moves the label.
 */
export const TAB_CHIP_BASE =
  'tab-bar-interactive group relative flex h-7 shrink-0 items-center rounded-[var(--radius-sm)] pl-2.5 pr-1 transition-[background-color,box-shadow,color] duration-150 ease-out'

export const TAB_CHIP_ACTIVE =
  'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-[0_0_0_1px_var(--color-tab-edge),var(--shadow-raised)]'

export const TAB_CHIP_IDLE =
  'text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text-primary)] hover:shadow-[0_0_0_1px_var(--color-tab-separator)]'

/** The tab's own min/max width, shared so both strips truncate titles alike. */
export const TAB_CHIP_WIDTH = 'min-w-[112px] max-w-[200px]'

export function tabChipClass(active: boolean): string {
  return `${TAB_CHIP_BASE} ${TAB_CHIP_WIDTH} ${active ? TAB_CHIP_ACTIVE : TAB_CHIP_IDLE}`
}

/** 12px title; only the active tab takes the medium weight. */
export function tabChipLabelClass(active: boolean): string {
  return `min-w-0 flex-1 truncate text-[12px] ${active ? 'font-medium' : ''}`
}
