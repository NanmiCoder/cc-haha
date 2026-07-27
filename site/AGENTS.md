# React Site Instructions

These rules apply to the public landing page and documentation experience under `site/`.

## Contracts that must not break

- Keep the site independently installable with `npm ci` and buildable with `npm run build`.
- Keep `npm run check` deterministic, offline, and responsible for site-specific validation beyond compilation.
- Preserve the GitHub Pages custom-domain contract; production assets and routes must work from the root of `claudecode-haha.relakkesyang.org`. `scripts/prepare-static-output.mjs` hard-fails when the CNAME drifts.
- Treat files under `docs/` as the source of truth for long-form Chinese and English documentation. Keep paired public routes aligned when both languages exist.
- Do not copy private user state, credentials, local filesystem paths, or unredacted product screenshots into the site.
- Run `bun run check:docs` after site or docs changes and include desktop plus narrow-mobile browser evidence for user-visible layout changes.

## How content reaches the site

`scripts/generate-docs-manifest.mjs` scans `docs/`, then emits three things into `src/generated/` (gitignored):

- `docs-index.js` — the eager index: route, section, title, `nav_title`, description, `order`. Keep it small; it ships on every page.
- `content/<id>.js` — one module per document holding the markdown **body** (frontmatter already stripped). `docsContent` maps a route to a dynamic import, so opening one page never downloads the rest.
- `search-index.js` — lazily imported by the search dialog only.

Routes come from file paths (`docs/start/install.md` → `/start/install`). Renaming a file renames its URL, so add the old path to both `LEGACY_ROUTES` in `src/content/docs.js` and `legacyRoutes` in `scripts/prepare-static-output.mjs`.

Sidebar grouping comes from the `sections` array in the generator — register any new top-level `docs/` directory there or it sorts last with a bare directory name. Order inside a group comes from each document's `order` frontmatter.

## Design system

`src/styles/base.css` holds every token. The palette is lifted from the desktop app's 「纸·墨·印」 themes — light mirrors 纯白, dark mirrors 墨夜 — so the site and the app read as one product. Rules:

- Use tokens (`--surface-*`, `--text-*`, `--border*`, `--brand*`, `--sp-*`, `--fs-*`, `--r-*`) rather than literal values. A raw hex in a component is a bug.
- The primary button is ink (`--ink`), turning terracotta (`--brand`) on hover. It is not brand-coloured at rest.
- Depth comes from 1px borders and surface layering, not heavy shadows.
- Both themes must work. `data-theme` on `<html>` is set by the bootstrap script in `index.html` before first paint.
- Breakpoints are 1180 / 900 / 620 across both stylesheets. Do not introduce a fourth.

## Mermaid

````mermaid fences render as diagrams. Nothing under `docs/` currently uses one — the two pages that did were deleted in the July 2026 restructure — so the dependency and its `.doc-mermaid` styles sit unused, lazily loaded and costing readers nothing. Keep them: `internals/` is exactly where a diagram would earn its place, and the mermaid theme is already wired to the site tokens.

## Fonts

Self-hosted in `public/fonts/`, copied from `desktop/public/fonts/`. **Never add a Google Fonts `@import` or `<link>`** — it is unreachable from mainland China and would leave every heading in a fallback serif. Only the latin subsets are hosted; Chinese glyphs fall through to the platform font on purpose, exactly as the desktop app does.
