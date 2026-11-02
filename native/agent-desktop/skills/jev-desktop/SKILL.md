---
name: jev-desktop
description: >
  Drive a desktop application from one plain-language goal, or resolve one intent
  at a time, without ever reading the accessibility tree. Use when automating a
  desktop app and you want to keep a 150-element JSON tree out of your context.
  Hand `run.mjs` a whole goal and it observes, decides and acts until the goal is
  met; hand `act.mjs` a single step when you want to keep the plan yourself.
  Covers which element, which operation, when to look deeper, and when to stop.
  Needs a clone of the agent-desktop repository and a TYPESAFE_API_KEY.
---

# jev-desktop

This skill requires a clone of the agent-desktop repository (the scripts live in `scripts/jev/` and ship in no installed package) and a `TYPESAFE_API_KEY`.

Two entry points over the same screen reading. `run.mjs` takes a goal and drives
until it is met. `act.mjs` takes one step and hands the plan back to you. Neither
puts the tree in your context.

## The loop

```sh
node scripts/jev/run.mjs --app Finder "open the Applications folder"
node scripts/jev/run.mjs --app TextEdit --cursor --text "A line to write." "write the supplied sentence into the document"
```

Each turn reads the screen, asks for one operation and a target for that
operation in the same request, carries it out, and reads again. It prints one
JSON line per turn and one when it stops (shown trimmed).

```json
{"turn":{"step":1,"operation":"CLICK","target":"treeitem \"Applications\"",
         "confidence":1,"ok":true,"delivery":"delivered_verified","changed":true}}
{"stop":"done","confidence":0.96}
```

The operations are `CLICK`, `TYPE_TEXT`, `CHECK`, `UNCHECK`, `EXPAND`,
`COLLAPSE`, `SCROLL`, `DRILL`, `WIDEN`, `WAIT`, `DONE` and `BLOCKED`. Only the
ones something on screen can receive are offered: `DRILL` for a region that
reports it holds more, `WIDEN` only after a `DRILL`. `SCROLL` always scrolls
down. `delivery` is `waited` for `WAIT` and `looked` for `DRILL` and `WIDEN`.

**The target is asked once per operation.** `click_target` is chosen from the
elements that advertise `Click`, `type_text_target` from those that advertise
`SetValue`, and so on. Only the head matching the chosen operation is read, so a
target can never be incompatible with the verb that acts on it.

**Looking is an operation.** A window is read with `--skeleton` first, so a dense
document costs the same first look as a small panel. A region that was cut off
reports how much it holds, and `DRILL` pins it as the root for later turns.
`WIDEN` gives the whole window back.

**`CHECK` and `UNCHECK` instead of a toggle.** Both are idempotent: a box already
in the wanted state stays there.

**You supply the text.** Nothing here writes a value, so a run never puts a
string on screen that you did not choose. Pass `--text` once per value and they
are consumed in order, or pass a function as the `text` option and it is asked
for each field with that field's description. When there is no value left to
give, `TYPE_TEXT` is not offered at all, so the run stops rather than inventing
one.

**Text goes in by whichever route the application accepts.** A direct value
write (`set-value`) is one verified call. Only when the application refuses it
and the refusal says a retry is safe does the value go through the clipboard and
a `cmd+v` paste (macOS only). The clipboard is put back when the run ends, or
emptied if it held anything but text. One key press per character is never used:
it drops characters and loses capitals.

**What leaves the machine.** Every turn posts a description of the screen to the
decision endpoint (TypeSafe's `api.typesafe.ai` by default, or whatever
`TYPESAFE_BASE_URL` points at): each element's role, its accessible name or description, up
to sixty characters of the value it holds, its state, the window title, and the
recent actions, excluding supplied text and detailed execution evidence. That is enough to send the contents of a private document or a
filled form to the configured remote service. Secure text fields are already
withheld by agent-desktop and never reach the request. Pass `--no-values` to
either script to withhold what every other field holds as well; targeting gets
harder, because a value is often the only thing that tells two unnamed rows
apart. The default is to include values. `run.mjs` redacts explicit supplied
strings from action turns and later recent-action history, including when later
target names or execution evidence repeat them. Live screen descriptions remain
separate: if the application displays that text, its accessible name or field
value may still reach the remote service under the settings above. `act.mjs`
preserves its exact executable `argv` in stdout, so that field can include a
value supplied with `--text`; stdout may also contain accessible names and
element paths. Choose the endpoint and output destination with that exposure in
mind.

**A step that is hard to undo is not taken quietly.** An ordinary step needs 0.70
confidence in its target, one rated destructive (0.50 or more) needs 0.90, and
below 0.55 nothing runs. When the bar is not met the run stops and names the
candidate it would have acted on, so you decide instead of it. `act.mjs` gets the
rating in its single request. `run.mjs` rates risk with a second model call
(counted toward the 80), only for targets at 0.70 up to 0.90, so by default a
destructive step at target confidence 0.90 or higher runs unrated. If that call
returns no number, the step counts as destructive. Pass `--confirm-destructive`
to `run.mjs` or `act.mjs` to stop for confirmation on every step rated
destructive, regardless of confidence.

**`--cursor` makes the run watchable.** It starts a session, shows a cursor that
travels to each element before the operation lands, and turns it off at the end.
If the session cannot start, the run continues without a cursor. The cursor is
drawn where the element is, so bring the application in front of your terminal or
it arrives behind it.

It stops on `DONE`, on `BLOCKED`, on a confidence too low for the risk, after 40
operations (`WAIT`, `DRILL` and `WIDEN` count), after 80 model calls (risk
ratings count), or after three turns in a row that changed nothing (`WAIT` turns
do not count). It also stops with `action_failed` when an operation fails, and
with `nothing on this screen can be acted on` when no element advertises an
action.

A screen with more actionable elements than a choice can carry says so, in the
request and in the turn it reports (`truncated`), and the policy is told to look
inside a region rather than call the goal impossible.

`--root @ref` starts inside a region when you already know which one.

## One step at a time

You keep the goal, the plan and the memory. You send one sentence. You get back
one small object.

```sh
node scripts/jev/act.mjs --app TextEdit --execute \
  --text "Morning over the dock." "type this text into the main writing area"
```

```json
{
  "ok": true,
  "intent": "type this text into the main writing area",
  "app": "TextEdit", "window": "Untitled 3", "window_id": "w-4521", "surface": "sheet",
  "element": { "ref": "@s1:e139", "role": "textfield", "name": "Save As:",
               "where": "sheet \"save\" > group" },
  "command": "set-value",
  "argv": ["set-value", "@s1:e139", "poem.txt"],
  "decision": "act",
  "why": null,
  "confidence": { "target": 0.99, "command": 0.88 },
  "gates": { "present": 0.94, "destructive": 0.31, "needs_text": 0.87 },
  "runner_up": [{ "ref": "@s1:e137", "what": "textfield", "p": 0.02 }],
  "notes": [],
  "executed": { "ok": true, "delivery": "delivered_verified" }
}
```

## Calling it

| Flag | Meaning |
| --- | --- |
| `--app <name>` | Required. |
| `--window-id <id>` | Read one window of the app, by the id `agent-desktop list-windows --app <name>` reports. Needed only when the app has more than one visible window and none of them is focused, which otherwise fails with `AMBIGUOUS_TARGET`. The run stays on that window: a window the run opens elsewhere is not read. If the window closes after an action, `run.mjs` reports that turn and stops with `window_closed`. A `--root` or an open surface outside the window gives `root_outside_window` or `surface_outside_window` (a stop in `run.mjs`, the `error` in `act.mjs`). Every `run.mjs` stop reports the window it read in `screen.window_id`. `run.mjs` takes it too. |
| `--no-values` | Withhold accessible field values from the decision request. Supported by both scripts; the default includes values. |
| `--execute` | `act.mjs` only. Run the command when `decision` is `act`. Without it, nothing runs. |
| `--text "…"` | Text the intent needs. Jev returns choices, never strings. `run.mjs` takes it repeatedly; `act.mjs` takes one value. |
| `--root @ref` | Resolve inside one container instead of the whole window. |
| `--bin <path>` | `act.mjs` only. agent-desktop binary. Defaults to the release build, then `PATH`. `run.mjs` reads `AGENT_DESKTOP_BIN` instead, with the same default. |

Environment: `TYPESAFE_API_KEY` is required (both scripts fail with
`TYPESAFE_API_KEY unset`). `TYPESAFE_BASE_URL` and `TYPESAFE_MODEL` are covered
below. `JEV_VERIFY_MS` sets the paste read-back deadline in ms (default 2000, 0
to 60000).

`argv` is the exact agent-desktop command. `double-click` and `hover` carry
`--headed`; `scroll` always goes down.

**Phrase the intent as an action, not as an element.** `"type this text into the
main writing area"` resolves to `type`. `"the main writing area"` names no
operation and can resolve to `focus`. Describe the target the way a person would,
`"the field holding the name the file will be saved under"`, not the way the tree
names it.

## Reading `decision`

| `decision` | What it means | What you do |
| --- | --- | --- |
| `act` | One element clearly matches and the confidence clears the bar for this action's risk. | Nothing. With `--execute` it already ran. |
| `confirm` | The match is plausible but under the bar. | Ask the user, or re-phrase the intent and call again. |
| `abstain` | Jev answered `none`, the element is probably not on this screen, or two elements fit equally. | The screen is not where you think. Open the surface you need, then call again. |
| `needs_text` | The command takes text and none was supplied. | Call again with `--text`. |

`why` carries the reason in one sentence for every `decision` except `act`
(where it is `null`). `runner_up` shows what else it considered, which is usually
enough to tell a wrong screen from a vague intent.

## What the script decides, not Jev

- **Risk sets the bar.** The answer says what; confidence says whether to act.
  An ordinary action needs 0.70. One that Jev rates `destructive` at 0.50 or
  more needs 0.90: writing a file, deleting, sending, confirming a warning.
  Below 0.55 nothing acts at all.
- **The command is reconciled against the element.** Both questions are
  answered in parallel and neither sees the other, so code checks the chosen
  verb against the element's advertised actions. A readonly combobox gets
  `click`, never `set-value`. A `--text` payload with a non-text verb corrects
  the verb, because the caller supplying text is evidence Jev does not have.
- **An open surface wins.** When a sheet, alert, menu or popover is up, the
  script reads the window, then that surface, and offers the surface's elements
  instead of the window's. In the window tree those
  elements carry `offscreen` and would all be dropped.
- **Disabled, hidden and action-less elements are never offered**, nor a cell
  inside a treeitem (the row beside it acts). Everything else is, including
  unnamed rows: a row is told apart by the value it holds, and a Choice does
  better with the full list than with a shortlist.

## How the request is shaped

`act.mjs` sends one call with five questions. They are answered in parallel, so
the speculative ones cost tokens and no latency.

| Question | Type | Asks |
| --- | --- | --- |
| `target` | choice | Which element the intent refers to, plus `none`. |
| `command` | choice | Which of the 16 interaction verbs it asks for. |
| `present` | noul | Is the thing on this screen at all? |
| `destructive` | noul | Would this be hard to undo? |
| `needs_text` | noul | Does this need text from the caller? |

A Choice accepts 255 options, so up to 254 elements go in one pass (both
scripts). When the first `act.mjs` pass lands under 0.70, the top five are
re-asked with richer descriptions. A screen with more than 254 elements says so
in `notes`; use `--root @ref`.

## Deciding through OpenRouter

The decision endpoint is `TYPESAFE_BASE_URL`, defaulting to TypeSafe's native
`https://api.typesafe.ai/v1/systemone`. Configured endpoints must use HTTPS;
HTTP is allowed only for `localhost` or a literal loopback IP, which keeps local
test routers usable. URL credentials are rejected, and redirects fail closed so
the bearer key cannot be forwarded to another endpoint. Point it at OpenRouter's Decisions
router to use an OpenRouter key as `TYPESAFE_API_KEY`:

```sh
TYPESAFE_BASE_URL=https://openrouter.ai/api/alpha/decisions \
TYPESAFE_MODEL=typesafe/jev-1.13 \
TYPESAFE_API_KEY=sk-or-... \
node scripts/jev/run.mjs --app Finder "open the Applications folder"
```

`TYPESAFE_MODEL` may stay at its `jev-latest` default: against OpenRouter a bare
name is sent as the registered `~typesafe/<name>` alias. Or pin a routed id such
as `typesafe/jev-1.13`. Do not set `typesafe/jev-latest`: OpenRouter answers
`400 Model does not exist`. OpenRouter's Decisions endpoint is alpha and may
change shape.

## Known limits

- `act.mjs` reads the screen once per call. `run.mjs` reads it before and after
  each action, and skips the read after `DRILL` or `WIDEN`. Without a pinned
  region, each read takes a second snapshot when a sheet, alert, menu or popover
  is open. A read takes about 3 s on a dense app; `--root` is far cheaper.
- `act.mjs` does not retry: a 429 ends the call. `run.mjs` retries 429, 503 and
  529 twice, after 500 ms then 1000 ms, before it fails.
- Held input is unavailable, so no sustained key and no drag with hold. See
  `crates/core/src/commands/input_hold_policy.rs`.
- `press` is not resolved here. It needs no element, so send it directly.

## Files

| File | Holds |
| --- | --- |
| `scripts/jev/policy.mjs` | The operations, how a screen is described, and when to stop. No application is touched here. |
| `scripts/jev/screen.mjs` | Which elements a command can reach, which surface is open, how an element is described. Shared by both entry points. |
| `scripts/jev/desktop.mjs` | The only code that speaks to agent-desktop. |
| `scripts/jev/run.mjs` | The loop and its command line. |
| `scripts/jev/act.mjs` | The single-step resolver. |

## Checks

`WAIT` in `run.mjs` pauses 250 ms before the screen is read again. A failed operation stops the run at once as `action_failed`, keeping the error code and delivery state, and is never repeated. A failed focus, clipboard write or paste ends the run the same way. A binary whose failed `set-value` reports no error disposition fails with `BINARY_TOO_OLD`.

`run.mjs` exits 0 only when the run stops at `done`; every other stop, and any error (`{"ok":false,"error":…}`), exits 1, and a usage error exits 2. `act.mjs` exits 0 unless the executed command failed or was not executed (`executed.code` is `NOT_EXECUTED` when `decision` is not `act`); an error exits 1 and a usage error exits 2.

After a paste the field is read back. If it does not hold the requested text the run stops with `TEXT_VERIFICATION_FAILED` and does not type again. The read-back compares the exact string, so a field that normalizes text (trims, changes case or line endings) reports a failure even when the text landed. The read is retried until the `JEV_VERIFY_MS` deadline before it fails.

```sh
node scripts/jev/act.test.mjs
node scripts/jev/run.test.mjs
node scripts/jev/run.integration.test.mjs
node scripts/jev/evidence.test.mjs
```

Turns keep native `steps`, `post_state` and `details` for the caller; they are excluded from model history. A verified `AlreadyInState` step with `outcome: "skipped"` and `delivery: "not_delivered"` means no input was needed. A failed postcondition keeps `ok: false` and any nested action evidence.
