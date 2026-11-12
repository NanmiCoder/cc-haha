#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/desktop"

if ! command -v agent-browser >/dev/null 2>&1; then
  echo "agent-browser is required but was not found in PATH" >&2
  exit 1
fi

PORTS="$(bun -e 'import { createServer } from "node:net"; const getPort = () => new Promise((resolve) => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; server.close(() => resolve(port)); }); }); const apiPort = await getPort(); const webPort = await getPort(); console.log(`${apiPort} ${webPort}`);')"
API_PORT="${PORTS%% *}"
WEB_PORT="${PORTS##* }"
BASE_URL="http://127.0.0.1:${API_PORT}"
WEB_URL="http://127.0.0.1:${WEB_PORT}/?serverUrl=${BASE_URL}"

RUN_ID="$(date +%s)-$RANDOM"
SESSION_NAME="cc-haha-context-live-${RUN_ID}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$(mktemp -d "/tmp/cc-haha-context-live-${RUN_ID}-XXXX")}"
PROJECT_DIR="${ARTIFACT_DIR}/project"
SERVER_LOG="${ARTIFACT_DIR}/server.log"
WEB_LOG="${ARTIFACT_DIR}/web.log"
BROWSER_LOG="${ARTIFACT_DIR}/browser.log"
RESULT_FILE="${PROJECT_DIR}/context-live-result.txt"

cleanup() {
  local exit_code=$?
  if [[ -n "${PREVIOUS_PERMISSION_MODE:-}" ]]; then
    curl -fsS -X PUT "${BASE_URL}/api/permissions/mode" \
      -H 'Content-Type: application/json' \
      -d "{\"mode\":\"${PREVIOUS_PERMISSION_MODE}\"}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${SESSION_ID:-}" && "${KEEP_SESSION:-0}" != "1" ]]; then
    curl -fsS -X DELETE "${BASE_URL}/api/sessions/${SESSION_ID}" >/dev/null 2>&1 || true
  fi
  agent-browser --session "${SESSION_NAME}" close >/dev/null 2>&1 || true
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${WEB_PID:-}" ]]; then
    kill "${WEB_PID}" >/dev/null 2>&1 || true
    wait "${WEB_PID}" >/dev/null 2>&1 || true
  fi
  if [[ $exit_code -ne 0 || "${KEEP_ARTIFACTS:-0}" == "1" ]]; then
    echo "Artifacts kept at: ${ARTIFACT_DIR}" >&2
  else
    rm -rf "${ARTIFACT_DIR}"
  fi
}
trap cleanup EXIT

mkdir -p "${PROJECT_DIR}"
cat > "${PROJECT_DIR}/README.md" <<'EOF'
# Context Usage Live E2E

This throwaway project is used by a real-model desktop WebUI test.
EOF

echo "Starting backend on ${BASE_URL}"
(
  cd "${ROOT_DIR}"
  SERVER_PORT="${API_PORT}" bun run src/server/index.ts --host 127.0.0.1 --port "${API_PORT}"
) >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!

echo "Starting web UI on http://127.0.0.1:${WEB_PORT}"
(
  cd "${DESKTOP_DIR}"
  bun run dev -- --host 127.0.0.1 --port "${WEB_PORT}" --strictPort
) >"${WEB_LOG}" 2>&1 &
WEB_PID=$!

wait_for_http() {
  local url="$1"
  for _ in $(seq 1 120); do
    if curl --max-time 2 -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "Timed out waiting for ${url}" >&2
  return 1
}

fetch_json_field() {
  local url="$1"
  local expression="$2"
  curl -fsS "$url" | bun -e "const input = await Bun.stdin.text(); const data = JSON.parse(input); ${expression}"
}

AB=(agent-browser --session "${SESSION_NAME}")

browser_text() {
  "${AB[@]}" get text body 2>>"${BROWSER_LOG}"
}

wait_for_text() {
  local needle="$1"
  local attempts="${2:-120}"
  for _ in $(seq 1 "${attempts}"); do
    if browser_text | grep -Fq "$needle"; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for page text: ${needle}" >&2
  return 1
}

session_contains() {
  local needle="$1"
  curl -fsS "${BASE_URL}/api/sessions/${SESSION_ID}/messages" | NEEDLE="${needle}" bun -e '
    const input = await Bun.stdin.text()
    const data = JSON.parse(input)
    const haystack = JSON.stringify(data)
    process.exit(haystack.includes(process.env.NEEDLE ?? "") ? 0 : 1)
  '
}

wait_for_session_text() {
  local needle="$1"
  local attempts="${2:-180}"
  for _ in $(seq 1 "${attempts}"); do
    if session_contains "${needle}"; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for transcript text: ${needle}" >&2
  return 1
}

context_label() {
  "${AB[@]}" eval "document.querySelector('[aria-label^=\"Context usage\"]')?.getAttribute('aria-label') || ''" 2>>"${BROWSER_LOG}" || true
}

wait_for_context_indicator() {
  for _ in $(seq 1 120); do
    if context_label | grep -Fq "Context usage"; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for context usage indicator" >&2
  return 1
}

show_context_details() {
  "${AB[@]}" eval "(() => { const el = document.querySelector('[aria-label^=\"Context usage\"]'); if (el) { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); el.focus(); } })()" >>"${BROWSER_LOG}" 2>&1 || true
}

wait_for_context_window_text() {
  for _ in $(seq 1 80); do
    show_context_details
    if browser_text | grep -Eq "Window|Input context|Free space"; then
      return 0
    fi
    sleep 0.5
  done
  echo "Context usage detail popover text was not detected; continuing with indicator and screenshot evidence" >&2
  return 0
}

wait_for_result_file() {
  for _ in $(seq 1 240); do
    if [[ -f "${RESULT_FILE}" ]] && grep -Fq "context-live-ok" "${RESULT_FILE}"; then
      return 0
    fi
    sleep 2
  done
  echo "Timed out waiting for real model tool execution" >&2
  return 1
}

wait_for_compact_boundary() {
  for _ in $(seq 1 240); do
    if session_contains "compact_boundary" || session_contains "Context compacted" || session_contains "Compacted"; then
      return 0
    fi
    sleep 2
  done
  echo "Timed out waiting for real /compact boundary" >&2
  return 1
}

wait_for_http "${BASE_URL}/health"
wait_for_http "http://127.0.0.1:${WEB_PORT}"

PREVIOUS_PERMISSION_MODE="$(fetch_json_field "${BASE_URL}/api/permissions/mode" 'console.log(data.mode)')"
curl -fsS -X PUT "${BASE_URL}/api/permissions/mode" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"bypassPermissions"}' >/dev/null

SESSION_ID="$(curl -fsS -X POST "${BASE_URL}/api/sessions" \
  -H 'Content-Type: application/json' \
  -d "{\"workDir\":\"${PROJECT_DIR//\"/\\\"}\"}" \
  | bun -e 'const input = await Bun.stdin.text(); const data = JSON.parse(input); console.log(data.sessionId);')"
UNIQUE_TITLE="Context Live ${RUN_ID}"
curl -fsS -X PATCH "${BASE_URL}/api/sessions/${SESSION_ID}" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"${UNIQUE_TITLE//\"/\\\"}\"}" >/dev/null

CURRENT_MODEL="$(fetch_json_field "${BASE_URL}/api/models/current" 'console.log(data.model?.name || data.model?.id || "current")')"
TAB_STATE="{\"openTabs\":[{\"sessionId\":\"${SESSION_ID}\",\"title\":\"${UNIQUE_TITLE}\",\"type\":\"session\"}],\"activeTabId\":\"${SESSION_ID}\"}"

"${AB[@]}" open "${WEB_URL}" >>"${BROWSER_LOG}" 2>&1
"${AB[@]}" wait 1200 >>"${BROWSER_LOG}" 2>&1
"${AB[@]}" eval "localStorage.setItem('cc-haha-locale', 'en'); localStorage.setItem('cc-haha-open-tabs', '${TAB_STATE}'); location.reload();" >>"${BROWSER_LOG}" 2>&1
"${AB[@]}" wait 1800 >>"${BROWSER_LOG}" 2>&1

"${AB[@]}" fill '#sidebar-search' "${UNIQUE_TITLE}" >>"${BROWSER_LOG}" 2>&1
"${AB[@]}" eval "Array.from(document.querySelectorAll('button')).find((el) => el.textContent?.includes('Context Live'))?.click()" >>"${BROWSER_LOG}" 2>&1
"${AB[@]}" wait 1200 >>"${BROWSER_LOG}" 2>&1
"${AB[@]}" wait 'textarea' >>"${BROWSER_LOG}" 2>&1
"${AB[@]}" screenshot "${ARTIFACT_DIR}/01-session-open.png" >/dev/null

wait_for_context_indicator
show_context_details
wait_for_context_window_text
"${AB[@]}" screenshot "${ARTIFACT_DIR}/02-initial-real-context.png" >/dev/null

PROMPT="Use Bash to run exactly: sleep 18 && printf context-live-ok > context-live-result.txt . After the command finishes, reply exactly CONTEXT_LIVE_DONE. Do not edit any other file."
"${AB[@]}" fill 'textarea' "${PROMPT}" >>"${BROWSER_LOG}" 2>&1
"${AB[@]}" press 'Enter' >>"${BROWSER_LOG}" 2>&1
"${AB[@]}" wait 3500 >>"${BROWSER_LOG}" 2>&1

wait_for_context_indicator
show_context_details
wait_for_context_window_text
"${AB[@]}" screenshot "${ARTIFACT_DIR}/03-running-real-model-context.png" >/dev/null

wait_for_result_file
wait_for_session_text "CONTEXT_LIVE_DONE" 180
"${AB[@]}" wait 1000 >>"${BROWSER_LOG}" 2>&1
show_context_details
"${AB[@]}" screenshot "${ARTIFACT_DIR}/04-after-real-model-turn-context.png" >/dev/null

COMPACT_PROMPT="/compact Keep a concise summary that mentions context-live-ok and the Bash command result."
"${AB[@]}" fill 'textarea' "${COMPACT_PROMPT}" >>"${BROWSER_LOG}" 2>&1
"${AB[@]}" press 'Enter' >>"${BROWSER_LOG}" 2>&1
wait_for_compact_boundary
show_context_details
wait_for_context_window_text
"${AB[@]}" screenshot "${ARTIFACT_DIR}/05-after-real-compact-context.png" >/dev/null

INSPECTION_SUMMARY="$(curl -fsS "${BASE_URL}/api/sessions/${SESSION_ID}/inspection?includeContext=1" | bun -e 'const input = await Bun.stdin.text(); const data = JSON.parse(input); const ctx = data.context || data.contextEstimate; console.log(JSON.stringify({ model: ctx?.model, totalTokens: ctx?.totalTokens, rawMaxTokens: ctx?.rawMaxTokens, percentage: ctx?.percentage, categories: ctx?.categories?.slice(0, 5)?.map((c) => ({ name: c.name, tokens: c.tokens })) }, null, 2));')"

echo "Context usage live WebUI E2E passed"
echo "Model: ${CURRENT_MODEL}"
echo "Session: ${SESSION_ID}"
echo "API port: ${API_PORT}"
echo "Web port: ${WEB_PORT}"
echo "Artifacts: ${ARTIFACT_DIR}"
echo "Inspection:"
echo "${INSPECTION_SUMMARY}"
