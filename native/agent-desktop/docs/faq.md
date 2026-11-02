# agent-desktop FAQ

## What is agent-desktop?

agent-desktop gives any agent computer use on the desktop. Agents see and operate desktop apps through OS accessibility trees, using structured JSON with stable refs instead of guessing from screenshots or pixel matching.

## Does agent-desktop require screenshots or pixel matching?

No. The core workflow reads native accessibility trees and assigns refs to interactive elements. Screenshots are available as a separate command, but agents do not need screenshots or pixel matching to click buttons, type into fields, inspect menus, or navigate app windows.

## How does agent-desktop work?

| Component | Function |
|-----------|----------|
| **Native Rust CLI** | Fast, single binary, no runtime dependencies |
| **C-ABI cdylib** | Load once from Python, Swift, Go, Ruby, Node, or C instead of forking |
| **60 Commands** | Observation, interaction, keyboard, mouse, notifications, clipboard, window management, session lifecycle, trace read/export, and bundled `skills` docs |
| **Snapshot & Refs** | Compact snapshot IDs and deterministic element refs like `@s8f3k2p9:e1`, `@s8f3k2p9:e2` |
| **Structured JSON** | Machine-readable responses with error codes and recovery hints |

## What makes agent-desktop useful for AI agents?

| Feature | Benefit |
|---------|---------|
| **Progressive Skeleton Traversal** | `snapshot --skeleton` returns a shallow overview and `--root @ref` drills into one region, so an agent reads only the part of a dense app it acts on |
| **Headless-by-Default Actions** | Ref actions use accessibility APIs and block unintended physical side effects |
| **Snapshot Refs** | Agents act on stable refs within a snapshot instead of guessing coordinates |
| **Recovery Hints** | Errors include machine-readable codes and suggestions for the next agent step |
| **Cross-Language FFI** | Python, Swift, Go, Ruby, Node, C, and C++ hosts can call the native library directly |

## Which platforms are supported?

macOS, Windows and Linux. The [platform table in the README](../README.md#platform-support) shows what each one
supports, and `agent-desktop skills get platform` prints the full capability table for the OS the binary runs on.

## How do I install agent-desktop?

Install the CLI from npm:

```bash
npm install -g agent-desktop
agent-desktop snapshot --app Safari
```

Build the FFI library from source:

```bash
cargo build --profile release-ffi -p agent-desktop-ffi
# Outputs under target/release-ffi/: libagent_desktop_ffi.dylib/.so or agent_desktop_ffi.dll
```

## What is the ref system?

`snapshot` assigns qualified refs to interactive elements in depth-first order, such as `@s8f3k2p9:e1`. The embedded snapshot ID makes every ref self-describing. Snapshot lookup remains confined to the selected namespace, so refs created under a session still require that session's `--session` or `AGENT_DESKTOP_SESSION` scope. A bare `@e1` is rejected with `INVALID_ARGS`.

Interactive roles that receive refs:

`button`, `textfield`, `checkbox`, `link`, `menuitem`, `tab`, `slider`, `combobox`, `treeitem`, `cell`, `radiobutton`, `incrementor`, `menubutton`, `switch`, `colorwell`, `dockitem`, `listbox`, `option`.

Stale ref recovery:

```text
snapshot -> act -> STALE_REF? -> snapshot again -> retry
```

## How does an agent learn the tool?

Run `agent-desktop skills get desktop` for the core skill, then `agent-desktop skills get platform` for the skill of the OS the binary runs on. Run `agent-desktop <command> --help` for flags.

## Is agent-desktop free and open source?

Yes. agent-desktop is Apache-2.0 licensed for personal and commercial use.

## What data can contain private information?

Snapshot trees, window titles, clipboard reads, notifications, screenshots and command results contain the desktop content you asked to inspect. Debug HTML embeds a screenshot and accessibility data. Session traces can retain evidence artifacts even when structured fields are redacted. Keep these files and caller transcripts private; redaction does not make a screenshot safe to publish.

The native CLI does not require a remote model service. The optional repository-only [JEV helper](../skills/jev-desktop/SKILL.md) sends goals and screen descriptions to the configured provider. Its value-suppression option does not remove private text from labels, titles, ancestor paths or the goal itself. Use it only with data approved for that provider. Its executable command output can also contain supplied text.

Public probe captures retain technical environment details such as OS versions and window geometry. Review captures and media before publishing them, even when identity fields have been redacted.

## Where can I get help?

| Resource | Link |
|----------|------|
| **Repository** | [github.com/vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) |
| **skills.sh Listing** | [skills.sh/vercel-labs/agent-desktop/agent-desktop](https://skills.sh/vercel-labs/agent-desktop/agent-desktop) |
| **npm Package** | [npmjs.com/package/agent-desktop](https://www.npmjs.com/package/agent-desktop) |
| **CI Status** | [GitHub Actions](https://github.com/vercel-labs/agent-desktop/actions/workflows/ci.yml?query=branch%3Amain) |
| **Releases** | [GitHub Releases](https://github.com/vercel-labs/agent-desktop/releases) |
| **Issues** | [GitHub Issues](https://github.com/vercel-labs/agent-desktop/issues) |
