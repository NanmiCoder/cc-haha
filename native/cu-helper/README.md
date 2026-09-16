# Native Computer Use compatibility

The compatibility reference is the installed **official** Codex Computer Use
plugin, its shipped JavaScript client, and its native service. Third-party
replicas are historical references, not specifications for current Codex.
`docs/internals/computer-use-codex-impl-blueprint.md` describes the verified
contracts and the boundaries of our implementation.

## Reference inspected on 2026-09-09

- Plugin: `openai-bundled/unified-computer-use/26.901.51231`.
- Native service: `SkyComputerUseService` **26.831.1000926**, SHA-256
  `25e9141499b94c396f39afbdb7b19ed8f49e45dc8c61be61028ceab8f3807ce6`.
- The app ships `@oai/cua` and `@oai/sky` under
  `Contents/Resources/cua_node/lib/node_modules/`. Its native client sends
  length-prefixed JSON-RPC over a persistent local pipe. The browser provider is
  separate from the native app provider.
- The public Codex CLI/App Server repository supplies MCP integration, not the
  native service's mouse-event implementation. Missing static CGEvent imports
  do not prove an AX-only implementation: the service also resolves functions
  indirectly.

These observations apply to this build. Recheck the actual caller and callee
when changing versions; a nearby symbol or a third-party constant is insufficient
evidence for a timing or event contract.

## Native browser Apps and the separate browser provider

The native App route permits Chrome and other browsers on macOS. The earlier
TypeScript and `AppTargetPolicy` browser-category rejection blocked this route
despite it being the route used by the official native App client. Both dispatch
layers now permit native browser targets while preserving other denials,
authorization, signatures, and process/window-identity checks. Windows browser
categories and tiers remain unchanged. This permission is for native App
control; it does not implement the browser service's Tab, DOM, or Playwright API.

In the user-designated Townscaper success trace, 21 JS calls include one browser
inventory and a `getTab` attempt that times out after 30.0355 seconds. The next
binding is `cua.getApp("com.google.Chrome")`. All 57 later input actions are
native: 47 drags, 3 clicks, 3 scrolls, 3 key presses, and 1 paste. The trace
returns 18 screenshot blocks. Six cells containing loops perform 41 drags;
39 occur inside loop bodies and two are palette selections outside them.
Those six cells take 19.9703 seconds including their final observations. There
are no successful Tab/DOM/Playwright construction calls. Browser provider setup
is outside this native compatibility scope.

## Coordinate drag contract

The native coordinate click controller calls `ApplicationUIElement.sendClick`
with an optional drag destination and `delay: nil`. The specialized
`SynthesizedEvent.click` implementation emits:

| Event | Location | Click count | Event number |
| --- | --- | --- | --- |
| Mouse down | origin | 1 | gesture number |
| Mouse dragged | origin | 0 | motion number |
| Mouse dragged | midpoint | 0 | motion number |
| Mouse dragged | destination | 0 | motion number |
| Mouse up | destination | 1 | gesture number |

Zero-distance drags retain all five events. Do not replace them with clicks or
drop the initial dragged event. The three motion events share a number distinct
from the down/up pair. The origin window stays bound for the complete gesture.

In the inspected arm64 service, the specialized function is at `0x100723c60`,
the midpoint calculation is at `0x100723d34`, and the five NSEvent constructions
are at `0x100723dd8`, `0x100723fbc`, `0x100724160`, `0x100724300`, and
`0x1007244a8`. The coordinate caller at `0x10007c8dc` supplies a nil delay to
`sendClick` at `0x1006e22d8`. Both the direct and virtual-cursor sender branches
skip their optional sleep for this call. Actor transitions are not evidence for
a guaranteed yield or a substitute fixed delay.

`AXAction.dragEvents` and `MouseDragEventTests` encode this event contract using
the production event builder. `MouseEventBurstDelivery` retains target/window
validation, cancellation checks, and release of a held button at the last
posted point. Removing artificial waits must not remove those checks.

## Batches and observations

The official native app API supports persistent JavaScript bindings and loops.
It recommends batching known actions and observing the resulting state in the
same call. In the inspected coordinate controller, only `returnSkyshot: true`
enters the UI-settle/capture branch (notification delay 250ms); false invalidates
state and returns. The full observation time is not a fixed 250ms promise.

Only `js`/`js_reset` are advertised to models on macOS, avoiding duplicate
per-action schemas. These entry points provide an isolated persistent worker.
Variables, App bindings, top-level await, loops, calculations, and intermediate
observations survive across ordinary cells. Native App methods pass JSON messages
through the existing host semantic-tool dispatch and target checks. Binding an
App uses the approved path returned by initial observation; it does not cache a
PID as authority. The first visible App selection or inventory includes concise
API guidance; selecting an App initially displays AX text only.

The official facade's `getAXState`, `getScreenshot`, and
`getAXStateAndScreenshot` all call `get_app_state`. Our facade mirrors that
boundary: output selection and `emit:false` do not optimize away native AX
traversal or screenshot work. Actions do not add implicit observations. Copied
`gN:id` handles remain opaque; integer aliases are mapped only from returned AX
rows and track native diffs/generations. Image-only observations clear integer
aliases; a full AX observation is required to rebuild them.

Each JS cell permits 256 native calls, 256 KiB of source, 128 emitted content
blocks and 16 MiB of emitted data. The wall timeout defaults to 30 seconds and
is capped at 60 seconds. Ordinary script errors preserve bindings; timeout,
cancellation, or explicit reset discards them. Already-dispatched actions may
have run and are never automatically replayed. Imports, Node, filesystem and
networking are not exposed. Runtime, compiler, and worker boundaries live under
`src/utils/computerUse/`; `src/vendor/computer-use-mcp/replApi.ts` owns the native
method facade and observation output.

The existing `sequence` still executes validated JSON actions serially against
one proven process and observes once. It stops after failure/cancellation and
reports completed steps. Its limits remain 256 steps and a cooperative 60-second
deadline; an in-flight native command must settle before the runner returns.
Standalone semantic tools retain direct-call compatibility, but they and
`sequence` are not advertised by default. Windows retains its pixel tool face.

The ordinary Swift test suite uses event factories and injected receivers to
check input construction and routing without launching fixture apps, opening
windows, or driving the macOS desktop. The former native receiver integration
suite was removed because it interacted with the developer's desktop whenever
Accessibility and Screen Recording permissions were already available.
These tests do not prove delivery to a real receiving app.

The identity diagnostic added to `Injection.validateAuthorizedTarget` is
DEBUG-only and records the exact target/current values used by strict comparison.
`ProcessValidationObservationTests` verifies that this observer does not alter
the comparison or allow missing identity evidence. Controlled repeated runs
passed 15 rounds, comprising 45 disposable Apps, 180 complete drags, and 1,095
actual validation samples (1,080 during drag delivery). Each process retained
one complete identity, including identical launch-time Double bits. Twelve
gestures and a final observation took 1.178–1.405 seconds in those fixture runs.
This is fixture throughput, not model task performance.

Two earlier anomalies, `stale_process` and a timeout lacking phase records,
were not reproduced. Their causes remain unknown. The investigation added
diagnostics, not launch-time tolerances, retries, a relaxed comparison, or a
different fixture bundle ID.

## Compatibility limits

Matching these contracts does not establish complete Codex compatibility or
Townscaper/Blender task success. The persistent JS native App facade is present,
but browser-tab/DOM providers and the official runtime's general Node facilities
are not. Tests that run the actual sandboxed worker with simulated native tools
establish persistence, isolation and output behavior. Real receiving-app gesture
delivery requires a separate manual check. These tests do not prove parity
across real model tasks.

Focus acquisition, AX fallbacks, key synthesis, coordinate transforms, capture,
and gesture delivery must each be verified at their actual boundary. Do not
remove focus or interference checks merely because they cost time. Compare
action counts, observations, model round trips, per-action tool time and
receiver-visible outcomes separately; tool-time improvements alone do not
predict end-to-end model task performance.
