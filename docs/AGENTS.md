# Documentation Instructions

These rules apply to `docs/` changes in addition to the root instructions.

- Keep Chinese pages and their `docs/en/` counterparts aligned when both versions exist.
- Treat `docs/` as the bilingual content and media source for the React site in `site/`; preserve existing terminology and do not replace reference screenshots or media unless the task requires it.
- Run `bun run check:docs` when selected by `bun run check:impact`.
- `check:docs` installs the isolated `site/` dependency tree, then builds and validates the React site.
- Release instructions must stay consistent with `scripts/release.ts`, `.github/workflows/release-desktop.yml`, and the versioned release-notes convention.
