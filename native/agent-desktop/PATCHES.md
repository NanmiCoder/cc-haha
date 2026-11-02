# Vendored agent-desktop

Source: [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop/tree/9eb9b296192fcb70bda25e918cd6dd66abfa3d0d), version 1.0.2, Apache-2.0.

`UPSTREAM.json` records the original SHA-256 for each copied upstream file. The copy contains the Rust workspace, embedded skills, tests, and their compile-time include dependencies. The documentation site, unrelated probe scripts, media assets, build output, and Git history are excluded. `THIRD-PARTY-NOTICES` preserves license texts from the dependencies fixed by `Cargo.lock`.

## Local changes

- `crates/core/src/cursor_overlay/product_cursor.rs` defines the seven-point arrow shared by Windows and X11. Its hotspot, 22-point reference height, notched tail, and 1.5-point outline follow the product's Swift helper. Its tests preserve the hotspot and shape across scaling.
- `crates/windows/src/system/cursor_overlay/geometry.rs` uses that arrow and a 64-point click ripple. The corresponding geometry tests follow the product reference.
- `crates/linux/src/system/overlay/cursor_overlay_draw.rs` uses the same arrow dimensions and outline width. Its window remains click-through and keeps the hotspot at the requested screen coordinate.
- `src/cli/product_bridge_tests.rs`, registered in `src/cli/mod.rs`, checks the product bridge's actual cursor configuration, screenshot, clipboard image, and batch argument contracts without opening a desktop.
- `crates/core/tests/product_cursor_visuals.rs` runs the Windows geometry and raster tests without linking an OS adapter or opening a window.
- `.gitignore` excludes the local Cargo target and test state directories.
- `tests/e2e-windows/scenarios/Interaction.ps1`, `tests/fixture-app-windows/FixtureCardsClicks.cs`, and the collected dependency notices have trailing whitespace normalized. Source statements and license wording are unchanged.
- `NOTICE`, `THIRD-PARTY-NOTICES`, this file, and `UPSTREAM.json` provide distribution and source attribution.

The local changes affect presentation. Headless versus headed policy, OS input delivery, interaction leases, and the explicit unsupported Wayland cursor response are inherited from upstream. Windows retains its existing cursor animation and effects; the X11 overlay remains a static arrow at each action position. The product's macOS path continues to use its Swift helper.

## Build

Prepare the installed stable Rust toolchain, its target standard library, and Cargo dependencies before running the offline native gate:

```sh
cargo +stable fetch --locked --manifest-path native/agent-desktop/Cargo.toml
```

`desktop/scripts/native-agent-desktop.ts` builds with `cargo +stable build --locked --offline`. It sets an explicit target directory under this source tree and stages the Windows or Linux CLI into `desktop/src-tauri/binaries`. Linux also stages `agent-desktop-linux-clipboard-owner`, which must remain beside the CLI. The scripts stage license texts and upstream metadata into `agent-desktop-licenses` in the same directory. They do not download a prebuilt executable.

For a focused development build, pass the platform target explicitly:

```sh
bun desktop/scripts/native-agent-desktop.ts --target-triple x86_64-unknown-linux-gnu --debug
```

The development executable remains at `native/agent-desktop/target/<target>/debug/agent-desktop`. A direct host Cargo build instead writes to `native/agent-desktop/target/debug`. Windows uses the `.exe` suffix. Cross builds require the selected target's linker and standard library; use the matching platform build runner for release packaging.
