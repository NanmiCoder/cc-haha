# CEF/Electron injection: why clicks silently fail

## Symptom

For Chromium apps such as NetEase Cloud Music (CEF116), every `click` / `type_text` returns
`Action completed.` while the UI **does not change at all**. The model looks at the screenshot, cannot make sense of it, retries
again and again, and finally hallucinates "done". The user got unusable results two turns in a row.

The blast radius is far bigger than one music player: VS Code, Slack, Discord, Notion — **every Electron app**.

## Root cause

A bare event sent with `CGEvent.postToPid` has a `windowNumber` of **0**.

- Native AppKit apps are unaffected: they re-run hit testing against their own windows using the event coordinates.
- **Chromium/CEF routes by the window the event declares.** An event with window number 0 has nowhere to go and is dropped.

The drop is silent — `postToPid` has no return value, so we cannot tell the event never landed and report success anyway.

## Fix

Bake the window identity into the event before posting (`WindowTargetedEvent.swift`):

```swift
// 1. CGEvent has no public API to set the window number; the only route is via AppKit
let ns = NSEvent.mouseEvent(
    with: nsType,
    location: globalQuartzPoint,   // screen coordinates, not window-local
    modifierFlags: [],             // modifiers go through CGEventSetFlags, not here
    timestamp: 0,                  // the real timestamp is stamped right before post
    windowNumber: targetWindowID,  // ← the routing key
    context: nil,
    eventNumber: monotonicCounter, // duplicates collapse double-clicks into single clicks
    clickCount: n,
    pressure: 1.0
)
let cg = ns?.cgEvent

// 2. Window hit-test fields
cg.setIntegerValueField(CGEventField(rawValue: 91)!, value: windowID)  // WindowUnderMousePointer
cg.setIntegerValueField(CGEventField(rawValue: 92)!, value: windowID)  // ...ThatCanHandleThisEvent

// 3. Window-local coordinates (private SPI, resolved via dlsym)
CGEventSetWindowLocation(cg, globalPoint − windowOrigin)   // top-left origin, not flipped

// 4. Send
cg.timestamp = DispatchTime.now().uptimeNanoseconds
cg.postToPid(pid)
```

Delivery still uses the **public `CGEventPostToPid`**, the same API as the reference implementation.

### Background targets: also bring to front and wait for it to settle

Even with full window identity, a background target still does not receive clicks. It needs `SLPSSetFrontProcessWithOptions(&psn, winID, 0x2)`.

Two facts that must be written down:

1. **It is a real frontmost switch**, not "just make the window key". Measured by reading
   `frontmostApplication` directly via System Events: Finder before the call, the target app after.
2. **The first click after the switch is swallowed as the window's activation click.** Waiting 250ms → everything fails; waiting **800ms** →
   everything succeeds. That single number is the entire gap between "background control is impossible" and "it works",
   and it lives in `Injection.focusSettleMs`.

### The keyboard needs none of this

Bare `postToPid` works, **even when the target is fully in the background**: no pointer movement, no frontmost switch, no window identity.
So the final shape is:

| Channel | Works in background | Cost |
|---|---|---|
| Keyboard input | ✅ | none |
| Mouse click | ✅ | target is brought to front + 800ms settle |

## Three misdiagnoses and their lessons

It took three rounds to find this root cause. The detours are recorded because each one will be walked again by someone.

**1. "Codex does not synthesize events; it only uses Accessibility"**

The basis was that `nm -u` showed its service importing only `_CGEventGetFlags` and no event-posting API.
The conclusion was badly wrong — it has a home-grown symbol obfuscation layer: walk loaded images → hand-parse the
dyld export trie in `__LINKEDIT` → **SipHash-2-4** (message = symbol name ‖ a 126-character salt per call site) → dlsym.
**So the import table, `strings` and `nm` all miss what it actually calls.**

> Lesson: for a binary with anti-analysis measures, absence from the import table is not evidence.

**2. "`subtype = 3` is required by Chromium"**

I wrote in a code comment that "without it the event is dropped as malformed". That sentence had **no empirical support**; it was
inferred from the reference implementation. After a single-variable A/B test: it works without it. The field is kept (harmless, consistent with the reference),
but the comment now says "not independently verified, not where the fix is".

> Lesson: assertions in comments are read later as verified facts. If you have not tested it, write "unverified".

**3. "Background clicks don't work"**

The test itself was broken: I assumed the CPS call only gave key focus, but it actually switched the frontmost app, so that "background
failure" was not testing background at all. The real cause was the swallowed first click; waiting an extra 550ms fixes it.

> Lesson: the preconditions of a "failure" conclusion must be verified independently, or you will record something fixable as a product limit.

## Experiment discipline

- **Trust only before/after screenshots, never API return values.** "Returned success but nothing happened" is exactly the shape of this bug;
  judging by the return value means verifying the bug with the bug.
- **Only one experimenter per app at a time.** Multiple agents injecting in parallel create false positives — this time
  someone took text another agent typed into a search box as their own success. Isolate with unique marker strings, and run a few no-op passes
  to measure the false-positive rate (about 1/6 in this round).
- Crosstalk only produces false positives, never false negatives, so **negative results can be trusted across contaminated windows**.

## Points that silently regress (guarded by tests)

| Point | Symptom after regression |
|---|---|
| `windowNumber` does not survive the NSEvent→CGEvent bridge | back to silent drops |
| `CGEventSetWindowLocation` cannot be resolved | same as above |
| `SLPSSetFrontProcessWithOptions` cannot be resolved | background clicks become no-ops |
| someone lowers `focusSettleMs` | first background click is swallowed |
| a `makeMouse` call site forgets to pass `targetPid` | the new path is never reached (happened once) |

For on-device steps see `computer-use-native-manual-qa.md` §2.5.
