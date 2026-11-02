# Observation Commands

Commands that read UI state and never change it. Run `agent-desktop <command> --help` for flags.

## snapshot

Captures the accessibility tree as JSON. Interactive elements get qualified refs (`@s8f3k2p9:e1`) that embed the snapshot id. A bare `@eN` fails with `INVALID_ARGS`.

```bash
agent-desktop snapshot --app "System Settings" -i --compact
agent-desktop snapshot --app "App" --skeleton -i --compact
agent-desktop snapshot --root @s8f3k2p9:e3 -i --compact
agent-desktop snapshot --app "App" --surface menu -i
agent-desktop snapshot --app "App" --window-id w-1234 -i
```

Output shape:

```json
{ "ok": true, "command": "snapshot",
  "data": { "app": "System Settings", "window": { "id": "w-4521", "title": "General" },
    "ref_count": 14, "snapshot_id": "s8f3k2p9", "complete": true,
    "tree": { "role": "window", "name": "General", "children": [
      { "ref_id": "@s8f3k2p9:e1", "role": "button", "name": "About", "states": ["focused"] } ] } } }
```

Each ref names the snapshot that owns it, so a ref keeps resolving against its own snapshot when you interleave several apps or windows.

Choose the scope:

- `-i --compact` keeps interactive elements only and drops empty wrappers. Use both by default.
- `--skeleton` clamps depth to 3 and adds `children_count` to cut containers. Each cut branch exposes its deepest safely resolvable drill target, or its nearest resolvable ancestor when the boundary has no stable identity.
- `--root <REF>` starts from a ref found earlier. Re-drilling a root replaces only the refs from that root's previous drill. Other regions and the skeleton keep their refs. `--root` cannot combine with `--surface` or `--wait-for`.
- `--max-depth` (default 10) limits depth. Reach deeper subtrees with `--root`.
- Use `--include-bounds` only when you need coordinates.
- With `--app` and no `--window-id`, `snapshot` and `find` take the app's only visible window, else its only focused window, and answer `AMBIGUOUS_TARGET` with the candidates when neither settles it. Pass `--window-id` when an app has several windows.

### Partial trees

`data.complete` is on every snapshot. When the observation budget runs out, the command still succeeds with `"complete": false`, `"truncated": true`, `"nodes_observed"`, and the tree it saw. Each node with cut descendants carries `"subtree_truncated": true`. Read `complete`; do not wait for a `TIMEOUT`. Raise `--timeout-ms` (default 3000) or drill with `--root` to finish the tree. A `--root` drill is all or nothing: an incomplete read returns `TIMEOUT`.

A cold Chromium or Electron app can take 10 to 25 seconds to expose its web tree. If a fresh snapshot comes back thin, raise `--timeout-ms` and snapshot again.

### Which refs exist

An element gets a ref when its role is interactive or it advertises a primary action. `scrollarea` and `disclosure` get refs because `scroll`, `expand` and `collapse` need them. Static text and inert containers stay in the tree without refs. Web content advertises focus, right-click and scroll-to on almost every node, so those alone do not earn a ref. `find` returns `bounds` for such matches. Drive them with `--xy` (right-click, hover, drag) or scroll the container.

### Surfaces

Surfaces are overlays: `menu`, `menubar`, `sheet`, `popover`, `alert`, `focused`, plus OS shell kinds on some platforms. Read `supported_surfaces` from `status` before you ask for one. An unsupported kind returns `PLATFORM_NOT_SUPPORTED` with the supported list in `details`. A shell surface needs no `--app`. When it is closed you get `WINDOW_NOT_FOUND`; raise it with `open-system-surface`.

Use a surface snapshot for dialogs and menus, not a window snapshot. To reach one item inside an overlay, use `find --surface` instead of a full dump.

## find

Searches by role, name, value, text, description or native id. Use it first when you know the target.

```bash
agent-desktop find --app "App" --role button --name "OK" --exact
agent-desktop find --root @s8f3k2p9:e4 --role textfield --first
agent-desktop find --app "App" --surface menubar --name "Save" --exact --first
agent-desktop find --app "App" --role button --count
```

- Scope before you widen. `--root` searches one ref's subtree. `--surface` searches an overlay. Both cost a few hundred bytes instead of a full dump. They cannot combine.
- `--name` and `--text` match fuzzily. Add `--exact` for case-insensitive equality. Use `--limit 2` before a mutation when you need to know the match is unique.
- `--text` also matches ancestors whose subtree text contains the text. Use `--name` to match the node itself.
- `--role` is case-insensitive; `textarea`, `textbox` and `searchfield` fold to `textfield`. When a role filter matches nothing, `data.roles_present` lists the roles in the searched tree. Use it to tell a wrong role name from an empty screen.
- Unnamed elements omit `name`. Their content is in `value`, so search it with `--value`.
- A large tree, such as a file dialog, can pass the 5000 ms default `--timeout-ms`. Raise it or narrow the search. A timeout here does not mean the app hangs.

Every non-count response returns the `snapshot_id` that owns its refs:

```json
{ "data": { "snapshot_id": "s8f3k2p9",
  "matches": [ { "ref_id": "@s8f3k2p9:e5", "role": "button", "name": "OK", "states": ["enabled"] } ] } }
```

A match without `ref_id` is a context match: readable text with no action target. It carries `bounds` when the platform reports them. A match with a `ref_id` never carries `bounds`; read them with `get --property bounds`.

## get

Reads one property of a ref: `text` (default), `value`, `title`, `bounds`, `role`, `states`.

- `title` is the accessible name. It answers "what does this button say".
- `text` is what a person reads. It is the content for `textfield`, `combobox`, `listbox`, `datefield` and `timefield`, and the name everywhere else. If the preferred half is empty, the other half answers. A checkbox answers its label, not `1`.
- `value` is the raw value regardless of role (text, slider position).
- `text`, `value`, `bounds` and `states` read live state when the adapter can. A missing live value or bounds returns `null`. When an optional live read is unavailable, `get` can fall back to the saved ref entry's value, name, bounds or states.
- Only `bounds` reports whether it is live, in `data.live`. When it is `false`, the rectangle came from the snapshot and may be out of date. Check it before you pass bounds to `mouse-click`.

## is

Checks one boolean: `visible` (default), `enabled`, `checked`, `focused`, `expanded`, `selected`. Output: `{ "ref", "property", "result" }`. For `enabled`, an unknown native value returns `result: false` with `applicable: false`. That means unknown, not disabled.

## screenshot

```bash
agent-desktop screenshot --app "Finder" out.png
agent-desktop screenshot --screen 0 display.png
```

With no path, the PNG returns as base64 in `data`. `--screen` takes a display index from `list-displays`; `0` is the primary display. A screenshot is evidence for you, not proof that an action worked. Permission denial returns `PERM_DENIED` (see the platform skill).

## list-displays

Lists displays as `{ id, bounds, is_primary, scale }`, primary first. Use the array index, not `id`, with `screenshot --screen`.

## list-surfaces

```bash
agent-desktop list-surfaces --app "Finder"
```

Lists the overlay surfaces an app presents now, the values `snapshot --surface` accepts. Shell surfaces belong to the OS and never appear here. If a window entry carries `"unclassified": ["sheet"]` or `["menu"]`, the check could not read that window (often a busy app). Treat the missing entry as unknown, not absent.

## open-system-surface

```bash
agent-desktop --headed open-system-surface --surface action-center
```

Raises an OS shell surface and returns the window it presents, in the `w-<id>` form that `list-windows` uses. It takes the foreground, so strict headless is refused with `POLICY_DENIED`; pass `--headed`. An already-present surface returns without being raised again. A kind the OS does not expose returns `PLATFORM_NOT_SUPPORTED` with a `platform_detail` that names the alternative. See the platform skill for the kinds.

## Chromium and Electron apps

The accessibility path is the default. It is the only path for an app that is already running and for native menus, dialogs and windows. For the web contents of an app you can launch fresh, `launch --cdp` plus a CDP client is faster than a skeleton walk. See `commands-system.md`.
