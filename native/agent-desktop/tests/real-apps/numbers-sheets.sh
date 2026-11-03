#!/bin/bash
set -euo pipefail

if [[ $# -lt 4 || $# -gt 5 ]]; then
    echo "usage: numbers-sheets.sh BINARY WINDOW_ID SHEET_1_REF OTHER_SHEET_REF [CYCLES]" >&2
    exit 2
fi

binary=$1
window=$2
first=$3
second=$4
cycles=${5:-5}
[[ "$binary" = /* && -x "$binary" ]]
[[ "${AGENT_DESKTOP_HOME:-}" = /* ]]
[[ "$window" =~ ^w-[0-9]+$ ]]
[[ "$first" =~ ^@s[a-z0-9]+:e[0-9]+$ ]]
[[ "$second" =~ ^@s[a-z0-9]+:e[0-9]+$ && "$first" != "$second" ]]
[[ "$cycles" =~ ^[1-9][0-9]*$ && "$cycles" -le 15 ]]

output=$(mktemp -d /tmp/ad-numbers-sheets.XXXXXX)
echo "Evidence: $output" >&2
step=0

run() {
    step=$((step + 1))
    "$binary" "$@" | tee "$output/$step-$1.json"
}

transition() {
    local target=$1
    local inactive=$2
    local label=$3
    if ! run click "$target"; then
        run screenshot --window-id "$window" "$output/$label-failed.png" || true
        return 1
    fi
    run screenshot --window-id "$window" "$output/$label.png"
    run wait --element "$target" --predicate value --value true --timeout 5000
    run wait --element "$inactive" --predicate value --value false --timeout 5000
    run get "$target" --property states
    run is "$target" --property checked
    run get "$inactive" --property states
    run is "$inactive" --property checked
}

run list-windows --app Numbers
for ((cycle = 1; cycle <= cycles; cycle++)); do
    transition "$first" "$second" "$cycle-sheet-1"
    transition "$second" "$first" "$cycle-other"
done
echo "Commands completed. Review raw state pairs, screenshots and independent document oracle before scoring." >&2
