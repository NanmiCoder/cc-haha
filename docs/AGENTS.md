# Documentation Instructions

These rules apply to `docs/` changes in addition to the root instructions.

## Who the docs are for

Two audiences, nothing else. If a page serves neither, it does not belong here.

- **People using the app** — `start/`, `desktop/`, `im/`. No prior code knowledge assumed.
- **People reading the source** — `internals/`, `cli/`. Architecture, implementation, contributing.

Internal process artefacts (migration task lists, validation checklists, design proposals, release runbooks) are not documentation. Keep them out of `docs/`, or fold the durable part into `internals/contributing.md`.

## Structure

Five top-level sections: `start/`, `desktop/`, `im/`, `cli/`, `internals/`. Adding a sixth means registering it in the `sections` array of `site/scripts/generate-docs-manifest.mjs`.

`docs/en/` mirrors the Chinese tree file for file. Keep Chinese pages and their `docs/en/` counterparts aligned.

## Frontmatter (required on every page)

```yaml
---
title: 连接模型服务
nav_title: 连接模型      # sidebar label, ≤12 CJK characters
description: 一句话说明这篇讲什么。       # feeds search and SEO meta
order: 2                # position inside the section; index.md uses 0
---
```

The site renders the first paragraph after the H1 as a lede — write it as a normal paragraph, not a blockquote.

## Chinese typography

Put a space between Chinese characters and adjacent Latin letters or digits: 「一枚 6 位码」, 「回填 App ID」. Nothing in the render pipeline inserts it for you, so it has to be in the source. Punctuation needs no space.

## Screenshots

Product screenshots live in `docs/images/app/` as WebP at 2000px wide, captured from a real build. Never ship a screenshot from an older UI generation; re-capture instead. Redact tokens, QR codes, API keys and paired account names before committing. Cap feature pages at roughly three screenshots.

Step-by-step setup walkthroughs are the exception: `docs/im/` embeds console screenshots from `docs/images/im/<platform>/` and needs one per step. Judge those by whether a reader could follow along without them.

## Routes are file paths

`docs/start/install.md` publishes to `/start/install`. Renaming a file changes a public URL, so add the old path to `LEGACY_ROUTES` in `site/src/content/docs.js` and to `legacyRoutes` in `site/scripts/prepare-static-output.mjs`.

`/im/` is linked from inside the desktop app (`desktop/src/pages/AdapterSettings.tsx`). That route cannot move.

## Checks

- Run `bun run check:docs` when selected by `bun run check:impact`. It installs the isolated `site/` dependency tree, builds the React site, then validates every local link and image.
- Release instructions must stay consistent with `scripts/release.ts`, `.github/workflows/release-desktop.yml`, and the versioned release-notes convention.
