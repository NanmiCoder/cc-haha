/**
 * The one page column the extensions surfaces share: the page head, the plugin
 * catalog, the skill market and both detail pages. Kept in one place so the
 * head's title, the search row under it and the first card all start on the
 * same edge — when each page carried its own `max-w-*`/`px-*` pair, switching
 * tabs nudged the content sideways.
 */
export const EXTENSION_PAGE_COLUMN = 'mx-auto w-full max-w-[1200px] px-6 lg:px-10'

/**
 * Two to three cards a row inside that column. The floor matches the market
 * grid's `CATALOG_COLUMN_FLOOR`, so the plugin and skill tabs break to the same
 * column count at the same width.
 */
export const EXTENSION_CARD_GRID = 'grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,340px),1fr))]'
