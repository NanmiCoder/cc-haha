# Desktop FAQ

## Where is my data stored?

The default data root is under `~/.claude`. It contains user-owned sessions, provider settings, Skills, Agents, memory, tasks, traces, adapter configuration, and derived desktop state.

Use the General settings control when changing the data directory. Do not delete or replace the directory as a first troubleshooting step.

## Why does macOS say the app is damaged?

Official macOS releases from `v0.4.3` onward are signed and notarized. This message is more likely with an older or temporary unsigned package. Confirm that the file came from the project’s GitHub Release, then follow the macOS steps in [Installation](./04-installation.md#macos).

## Why does Windows show SmartScreen?

Windows signing is not a release requirement for every build. An unsigned installer can trigger SmartScreen even when the package is intact. Verify the GitHub Release and architecture before selecting **More info → Run anyway**.

## A Custom provider returns 401. What should I check?

Open **Settings → Providers**, verify the Base URL, API format, API key, and model ID, then run **Test connection**.

Authentication headers differ by provider:

- standard API-key providers normally use the API key field;
- bearer-token endpoints require the corresponding provider/auth configuration;
- OpenAI-compatible endpoints must use the correct `openai_chat` or `openai_responses` format;
- Kimi Code uses the current K3 Coding API preset and model metadata.

Prefer editing or recreating the provider in the UI over manually rewriting stored JSON. Never share the stored credential or a diagnostic screenshot containing it.

## Why is an official model missing?

Official-login catalogs are filtered by the models available to the account and by runtime discovery. A model listed in the app’s metadata is not a guarantee that every account can call it.

Sign out and back in, refresh the catalog, and confirm account access. For Custom providers, verify the endpoint’s real model ID and capability support.

## Why was my reasoning effort reduced or ignored?

Effort is applied only when the selected model and provider support it. Per-Agent effort follows the same rule. Unsupported combinations can be normalized, reduced, or omitted rather than forcing an invalid API request.

## My old sessions are missing from the list. Were they deleted?

Usually not. The SQLite local index is a rebuildable projection; original session files remain authoritative. Open **Settings → Diagnostics**, inspect index state, and use the confirmed rebuild action if needed.

Rebuilding the index does not delete source sessions, settings, Skills, memory, tasks, or traces.

## The app opens to a blank or startup error screen

Restart once and open Diagnostics if the app recovers. If a visible startup error remains:

1. record the exact error and platform;
2. confirm the package architecture;
3. check that security software did not quarantine a sidecar;
4. avoid deleting the data directory;
5. report the issue with the release version and sanitized logs.

The desktop has bounded renderer and sidecar recovery, but it intentionally leaves an unrecoverable startup failure visible.

## H5 asks for a token

Remote browser access requires H5 to be enabled and a current token. True same-machine loopback development access is separate and does not require H5.

Regenerating the token invalidates the previous one. See [H5 Access](./06-h5-access.md).

## An IM bot says I am unauthorized

Binding a bot or linked account does not authorize every chat user. The user must be in `allowedUsers` or complete pairing with the current six-character code. Codes expire after 60 minutes, are one-time use, and are rate limited after repeated failures.

See [IM Integrations](../im/).

## Will updates delete my providers or chats?

Official in-app and overwrite updates are designed to preserve the user data directory. Back up important user-owned data before unusual manual migrations, and do not treat application build directories as the data source.

## Desktop pets

See [Desktop Pets](./pets.md) for the complete enable, customization, and import workflow.

### Why is the active-task panel missing?

The panel lists only non-idle sessions, such as tasks that are running, waiting for you, or need attention. It hides automatically when every task is complete or idle; enabling **Show active task panel** does not keep historical tasks visible.

Confirm **Settings → Pets → Show active task panel** is enabled, then start a real task. Status refreshes periodically; if it still does not appear after a few seconds, hide and show the pet again.

### Why is my pet not moving?

Confirm **Settings → Pets → Play animations** is enabled. The app also respects the operating system’s reduced-motion preference, which can reduce or disable animation.

A custom pet made from one image receives lightweight breathing, floating, and task-state motion. It does not have the complete frame-by-frame actions of a v2 atlas pet. Hover over or click the pet to trigger interactions such as jumping or waving.

### Why did my custom-pet import fail?

Check each requirement:

- A single image must be PNG or WebP, 32–4096 pixels on each side, no larger than 8 MB, and no more than 16,777,216 total pixels.
- A v2 animation atlas must be exactly 1536×2288 pixels and use the documented 8-column × 11-row frame layout.
- The pet ID may be at most 73 characters, contain only lowercase letters, numbers, and single hyphens, and must not duplicate an existing ID.
- Display name and description are required.

The import reads only the local file you confirm in the system picker. Fix the source image and create the pet again instead of manually editing its manifest.

### How do I restore a pet after closing it?

Right-clicking the pet and choosing close, or turning off **Settings → Pets → Show desktop pet**, saves the disabled state. Turn that setting on again to restore the pet; reinstalling the app is not necessary.

If the pet was dragged onto another display, hide and show it again. Its saved position is clamped into the currently visible work area when the pet window is recreated.

### How do I delete a custom pet?

There is no in-app delete button in the current version. Select a built-in pet first, choose **Settings → Pets → Open folder**, delete only the folder for the custom pet, then return to Settings and select **Refresh**.

Delete only the confirmed pet directory under `${CLAUDE_CONFIG_DIR:-~/.claude}/cc-haha/pets`. Do not delete the entire `~/.claude` directory. Built-in pets ship with the app and are not removed here.

### Why is “Generate full animation with AI” unavailable?

That path requires a separately configured image-generation service. The current chat model is not used to generate pet artwork or action frames, so the option is explicitly unavailable when no suitable service is configured.

You can use the recommended single-image animation path now, or import a prepared v2 animation atlas.

### Can the pet approve permissions or send replies?

No. The pet window reports task state, focuses the main window, and opens the corresponding session. It has no message composer and cannot approve file, command, or Computer Use permissions.

When it shows **Waiting for you**, open the task in the main window, review the full context, approve or reject the request, and reply there. The pet never bypasses the selected permission mode.
