# Desktop Instructions

These rules apply to `desktop/` changes in addition to the root instructions.

- Before adding or editing anything under `desktop/src/components/`, read `desktop/src/components/AGENTS.md`. It is the authoritative index of reusable components, the placement rules for new ones, and the required style/i18n/a11y/test conventions. Do not add a component that duplicates one listed there, and do not add new files to `components/shared/` or `components/common/`.
- Reuse the existing desktop store/API patterns. Use `lucide-react` for common icons and keep operational UI dense, stable, and readable.
- A new feature panel is its own module from the start. `Settings.tsx` reached 4639 lines holding seven unrelated panels before it was split into `pages/settings/*`; the four most-repeatedly-fixed files in the repository are also its four largest. Put a panel in its own file, and put anything two panels share in an explicit shared module rather than leaving it in the page that happens to host both.
- Wire the component into its route in the same change that creates it. `src/__tests__/componentReachability.test.ts` fails on any `.tsx` no entry point can reach. Three components once lost their last import, and the coverage gate read "zero coverage" as "needs a test" — someone wrote suites for two of them, and a UI redesign then restyled all three.
- Every translation key a component uses must be added to all five files in `src/i18n/locales/`, including keys chosen inside an expression (`t(count === 1 ? 'a' : 'b')`) — a literal-only scan misses those in both directions.
- Add focused Vitest or Testing Library coverage for UI, store, or API behavior. Run it first, then follow `bun run check:impact`; desktop product changes normally select `bun run check:desktop`.
- Chat transport, WebSocket lifecycle, first-turn runtime selection, reconnect, or session changes also require the offline `bun run check:chat-contract` when selected, plus `bun run check:agent-flow` for the end-to-end session/tool/permission/reconnect protocol.
- Permission dialog, tool-call rendering, or approval-flow changes should also run `bun run check:desktop-ui-smoke`: it exercises the real dialog in a real browser against the mock runtime, with no provider.
- `desktop/electron/**` is not covered by `desktop/tsconfig.json`, so `check:desktop` cannot prove it still compiles. Changing a `desktop/src/**` module that the Electron host imports selects `bun run check:native` through the import graph — run it.
- Electron host, sidecar, packaging, or version changes require `bun run check:native` when selected.
- Validate user-visible flows in a real browser/desktop session when unit tests cannot prove layout or cross-process behavior, and record the path exercised.
- `localStorage` or native settings shape changes require a migration, an old fixture, and `bun run check:persistence-upgrade`.
