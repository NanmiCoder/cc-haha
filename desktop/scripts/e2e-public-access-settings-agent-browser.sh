#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BROWSER_BIN="${AGENT_BROWSER_BIN:-agent-browser}"
NODE_BIN="${CC_HAHA_NODE_BIN:-node}"
ARTIFACT_DIR="${CC_HAHA_SMOKE_ARTIFACT_DIR:-$(mktemp -d /tmp/cc-haha-remote-settings-XXXXXX)}"
mkdir -p "$ARTIFACT_DIR"
PORT="$(bun -e 'const s=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response()});console.log(s.port);s.stop(true)')"
SESSION_NAME="cc-haha-remote-settings-$$-$RANDOM"
cleanup() {
  local code=$?
  "$BROWSER_BIN" --session "$SESSION_NAME" close >/dev/null 2>&1 || true
  if [[ -n "${WEB_PID:-}" ]]; then kill "$WEB_PID" >/dev/null 2>&1 || true; wait "$WEB_PID" >/dev/null 2>&1 || true; fi
  echo "Remote settings smoke artifacts: $ARTIFACT_DIR"
  exit "$code"
}
trap cleanup EXIT
(cd "$ROOT_DIR/desktop" && exec "$NODE_BIN" node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$PORT") >"$ARTIFACT_DIR/vite.log" 2>&1 &
WEB_PID=$!
URL="http://127.0.0.1:$PORT/scripts/fixtures/public-access-settings/index.html"
for _ in $(seq 1 60); do
  if curl --silent --fail "$URL" >/dev/null; then break; fi
  sleep 0.2
done
ab() { "$BROWSER_BIN" --session "$SESSION_NAME" "$@"; }
ab open "$URL"
ab wait --text 'Stable discovery has not been configured'
ab snapshot -i >"$ARTIFACT_DIR/initial.txt"
LOGIN_SWITCH='input[role="switch"][aria-label="Start cc-haha when you sign in"]'
ab find role button click --name "Enable connection"
ab wait '[role="dialog"]'
ab get text '[role="dialog"]' >"$ARTIFACT_DIR/consent.txt"
rg -q 'signed public identity' "$ARTIFACT_DIR/consent.txt"
ab find role button click --name "Agree and enable connection"
ab wait 'img[alt="Scan to pair this phone"]'
ab wait --fn "document.querySelector('$LOGIN_SWITCH').checked === false"
ab wait --fn "!document.querySelector('$LOGIN_SWITCH').disabled"
ab focus "$LOGIN_SWITCH"
ab press Space
ab wait --fn "document.querySelector('$LOGIN_SWITCH').checked === true"
ab eval "document.getElementById('fixture-discovery-ready').click()"
ab wait --text 'Stable discovery is ready'
ab wait --fn 'Array.from(document.querySelectorAll("button")).some(button=>button.textContent==="Connect native Android App"&&!button.disabled)'
ab find role button click --name "Connect native Android App"
ab wait 'img[alt="Scan with the native Android App"]'
ab wait --fn 'document.querySelector("img").naturalWidth === 288'
ab screenshot --full "$ARTIFACT_DIR/stable-ready.png"
ab find role button click --name "Approve"
ab wait --text 'Revoke'
ab eval "document.getElementById('fixture-directory-outage').click()"
ab wait --text 'Discovery is temporarily unavailable'
ab wait --fn 'Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Connect a phone").disabled'
ab screenshot --full "$ARTIFACT_DIR/directory-outage.png"
ab find role button click --name "Turn off"
ab wait --text 'Off'
ab wait --fn "document.querySelector('$LOGIN_SWITCH').checked === true"
ab wait --fn "!document.querySelector('$LOGIN_SWITCH').disabled"
ab focus "$LOGIN_SWITCH"
ab press Space
ab wait --fn "document.querySelector('$LOGIN_SWITCH').checked === false"
ab eval "document.getElementById('fixture-discovery-ready').click()"
ab wait --text 'Stable discovery is ready'
ab focus 'button[role="radio"][aria-checked="false"]'
ab press Enter
ab wait 'input[aria-label="Tunnel Token"]'
FIXTURE_TOKEN="$(bun -e 'console.log(btoa(JSON.stringify({ a: "0123456789abcdef0123456789abcdef", t: "0d9c6c2e-4f5a-4b7e-9c1d-2e3f4a5b6c7d", s: btoa("fixture-tunnel-secret") })))')"
ab fill 'input[aria-label="Tunnel Token"]' "$FIXTURE_TOKEN"
ab wait --fn 'Array.from(document.querySelectorAll("button")).some(button=>button.textContent==="Enable connection"&&!button.disabled)'
ab eval 'Array.from(document.querySelectorAll("button")).find(button=>button.textContent==="Enable connection").focus()'
ab press Enter
ab wait '[role="dialog"]'
ab eval 'Array.from(document.querySelectorAll("[role=dialog] button")).find(button=>button.textContent==="Agree and enable connection").focus()'
ab press Enter
ab wait --text 'https://named.fixture.example/remote'
ab wait 'img[alt="Scan to pair this phone"]'
ab get text body >"$ARTIFACT_DIR/final.txt"
if rg -q '1970|fixture-pair-secret' "$ARTIFACT_DIR/final.txt"; then exit 1; fi
printf 'PASS: consent, OS-login toggle, quick/fixed connections, stable discovery, 288px QR, approval, directory outage and explicit disable\n'
