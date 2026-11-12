# Documentation Instructions

These rules apply to `docs/` changes in addition to the root instructions.

## Who the docs are for

Two audiences, nothing else. If a page serves neither, it does not belong here.

- **People using the app** — `start/`, `cases/`, `desktop/`, `im/`. No prior code knowledge assumed.
- **People reading the source** — `internals/`, `cli/`. Architecture, implementation, contributing.

Internal process artefacts (migration task lists, validation checklists, design proposals, release runbooks) are not documentation. Keep them out of `docs/`, or fold the durable part into `internals/contributing.md`.

## Structure

Six top-level sections: `start/`, `cases/`, `desktop/`, `im/`, `cli/`, `internals/`. Register any added section in the `sections` array of `site/scripts/generate-docs-manifest.mjs`.

The docs are English only. Do not add translated copies or a `docs/<locale>/` mirror.

## Frontmatter (required on every page)

```yaml
---
title: Connect a model provider
nav_title: Connect a model   # sidebar label, keep it short
description: One sentence on what this page covers.   # feeds search and SEO meta
order: 2                # position inside the section; index.md uses 0
---
```

The site renders the first paragraph after the H1 as a lede — write it as a normal paragraph, not a blockquote.

## Screenshots

Product screenshots live in `docs/images/app/en/` as WebP at 2000px wide, captured from a real build. Never ship a screenshot from an older UI generation; re-capture instead. Redact tokens, QR codes, API keys and paired account names before committing. Cap feature pages at roughly three screenshots.

Step-by-step setup walkthroughs are the exception: `docs/im/` embeds console screenshots from `docs/images/im/<platform>/` and needs one per step. Judge those by whether a reader could follow along without them.

## Routes are file paths

`docs/start/install.md` publishes to `/start/install`. Renaming a file changes a public URL, so add the old path to `LEGACY_ROUTES` in `site/src/content/docs.js` and to `legacyRoutes` in `site/scripts/prepare-static-output.mjs`.

`/im/` is linked from inside the desktop app (`desktop/src/pages/AdapterSettings.tsx`). That route cannot move.

## Checks

- Run `bun run check:docs` when selected by `bun run check:impact`. It installs the isolated `site/` dependency tree, builds the React site, then validates every local link and image.
- Release instructions must stay consistent with `scripts/release.ts`, `.github/workflows/release-desktop.yml`, and the versioned release-notes convention.
