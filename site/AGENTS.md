# React Site Instructions

These rules apply to the public landing page and documentation experience under `site/`.

- Keep the site independently installable with `npm ci` and buildable with `npm run build`.
- Keep `npm run check` deterministic, offline, and responsible for site-specific validation beyond compilation.
- Preserve the GitHub Pages custom-domain contract; production assets and routes must work from the root of `claudecode-haha.relakkesyang.org`.
- Treat files under `docs/` as the source of truth for long-form Chinese and English documentation. Keep paired public routes aligned when both languages exist.
- Do not copy private user state, credentials, local filesystem paths, or unredacted product screenshots into the site.
- Run `bun run check:docs` after site or docs changes and include desktop plus narrow-mobile browser evidence for user-visible layout changes.
