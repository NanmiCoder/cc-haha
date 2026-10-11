# CLI and Runtime Instructions

These rules apply to `src/` changes in addition to the root instructions.

- Keep CLI/runtime behavior under the existing `entrypoints`, `commands`, `services`, `tools`, `utils`, and `server` boundaries. Prefer the nearest existing seam over a new cross-cutting helper.
- Add a focused `*.test.ts` regression beside the affected area. Run it first, then follow `bun run check:impact`; ordinary `src/` changes normally select `bun run check:server`.
- Agent loop, tool, permission, or provider-wiring changes are exercised end to end by `bun run check:agent-e2e` (real CLI against a scripted mock LLM, no credentials); add a scenario in `scripts/quality-gate/mock-llm/` when the behavior is user-visible across a turn.
- Provider presets, authentication, managed environment variables, model metadata, proxy transforms, or streaming changes also require the offline `bun run check:provider-contract` when selected.
- Keep tests hermetic: use fake credentials, intercepted requests or loopback servers, temporary `HOME`/`CLAUDE_CONFIG_DIR`, and restored environment/global state.
- Never mutate real user configuration or transcripts. Persistence format changes require forward migration, unknown-field preservation, an old fixture, and `bun run check:persistence-upgrade`.
- Agent-loop, tool execution, provider routing, permissions, resume, and file-editing behavior need deterministic mock/fixture coverage before any separately authorized live smoke.
