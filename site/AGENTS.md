# React Site Instructions

These rules apply to the public landing page and documentation experience under `site/`.

## Contracts that must not break

- Keep the site independently installable with `npm ci` and buildable with `npm run build`.
- Keep `npm run check` deterministic, offline, and responsible for site-specific validation beyond compilation.
- Preserve the GitHub Pages custom-domain contract; production assets and routes must work from the root of `cchaha.ai`. `scripts/prepare-static-output.mjs` hard-fails when the CNAME drifts.
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

`src/styles/base.css` holds shared tokens. The landing page uses the user-provided Wandor direction throughout: warm paper illustrations, a white-faded ambient video, Geist typography, Special Elite wordmark, liquid glass surfaces and black capsule controls. Keep the entire landing journey consistent, including features, onboarding, FAQ and download. Documentation uses the same paper, illustration, typography and terracotta palette, scoped through `src/docs/doc-wandor.css` so its reading surfaces remain legible in both themes. The public display name is `cc-haha`; preserve legacy executable paths and release filenames when they must match actual artifacts. Rules:

On a first visit to `/`, show Chinese when the browser's preferred language is Chinese; use English for every other language. `/en` and `/en/start` are the English entries; `/` and `/start` remain Chinese routes. A saved manual language choice takes precedence when opening `/`.

- Use tokens (`--surface-*`, `--text-*`, `--border*`, `--brand*`, `--sp-*`, `--fs-*`, `--r-*`) rather than literal values. A raw hex in a component is a bug.
- Keep screenshots flat and legible. Never stack, tilt, blur, or auto-rotate product UI as the main evidence.
- Animation should explain a task stage or reading transition; the page must remain complete with reduced motion or paused motion.
- Both themes must work. `data-theme` on `<html>` is set by the bootstrap script in `index.html` before first paint.
- Breakpoints are 1180 / 900 / 620 across the stylesheets. Do not introduce a fourth.

## Mermaid

````mermaid fences render as diagrams. Nothing under `docs/` currently uses one — the two pages that did were deleted in the July 2026 restructure — so the dependency and its `.doc-mermaid` styles sit unused, lazily loaded and costing readers nothing. Keep them: `internals/` is exactly where a diagram would earn its place, and the mermaid theme is already wired to the site tokens.

## Fonts

Self-hosted in `public/fonts/`, copied from `desktop/public/fonts/`. The landing reference explicitly requests the Geist and Special Elite Google Fonts link. Keep local font fallbacks so the layout still works when the font CDN is unreachable. Only the latin subsets are hosted; Chinese glyphs fall through to the platform font on purpose, exactly as the desktop app does.
