#!/usr/bin/env bash
# Shared independent observations for the packaged C and npm consumers.

find_ref() {
  python3 - "$1" "$2" "$3" <<'PY'
import json
import sys

path, role, name = sys.argv[1], sys.argv[2], sys.argv[3]

def walk(node):
    if isinstance(node, dict):
        if node.get("role") == role and node.get("name") == name and node.get("ref_id"):
            yield node["ref_id"]
        for value in node.values():
            if isinstance(value, (dict, list)):
                yield from walk(value)
    elif isinstance(node, list):
        for item in node:
            yield from walk(item)

with open(path, encoding="utf-8") as stream:
    document = json.load(stream)
refs = list(walk(document))
if len(refs) != 1:
    raise SystemExit(f"expected one {role} named {name!r}, found {refs}")
print(refs[0])
PY
}

click_display_transition() {
  local snapshot=$1 output=$2 before ref shown=""
  shift 2
  if ! before=$(read_display 20); then
    echo "click: FAIL code=BASELINE_READ" >&2
    return 1
  fi
  if [ "$before" = "7" ]; then
    echo "click: FAIL code=BASELINE_UNCHANGED display=$before" >&2
    return 1
  fi
  ref=$(find_ref "$snapshot" button 7) || return 1
  "$@" "$ref" > "$output" || return 1
  for _ in $(seq 1 100); do
    shown=$(read_display 5) || shown=""
    [ "$shown" = "7" ] && break
    sleep 0.05
  done
  if [ "$shown" != "7" ]; then
    echo "click: FAIL code=ACTION_NOT_DELIVERED display=$shown expected=7 before=$before" >&2
    return 1
  fi
  echo "click: ok display=$shown before=$before"
}

observe_clipboard_clear() {
  local status
  for _ in $(seq 1 100); do
    status=0
    read_clipboard >/dev/null || status=$?
    case "$status" in
      3) return 0 ;;
      0) sleep 0.05 ;;
      *)
        echo "clipboard: FAIL code=OBSERVER_ERROR status=$status" >&2
        return 1
        ;;
    esac
  done
  echo "clipboard: FAIL code=CLIPBOARD_CLEAR the selection survived the clear" >&2
  return 1
}
