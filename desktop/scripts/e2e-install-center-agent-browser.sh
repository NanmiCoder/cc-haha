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
SESSION_NAME="cc-haha-install-e2e-${RUN_ID}"
ARTIFACT_DIR="$(mktemp -d "/tmp/cc-haha-install-e2e-${RUN_ID}-XXXX")"
SERVER_LOG="${ARTIFACT_DIR}/server.log"
WEB_LOG="${ARTIFACT_DIR}/web.log"

if [[ "${CC_HAHA_E2E_USE_REAL_CONFIG:-1}" == "1" ]]; then
  CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
else
  CONFIG_DIR="${CLAUDE_CONFIG_DIR:-${ARTIFACT_DIR}/claude-config}"
  mkdir -p "${CONFIG_DIR}"
fi

cleanup() {
  local exit_code=$?
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${WEB_PID:-}" ]]; then
    kill "${WEB_PID}" >/dev/null 2>&1 || true
    wait "${WEB_PID}" >/dev/null 2>&1 || true
  fi
  agent-browser --session "${SESSION_NAME}" close >/dev/null 2>&1 || true
  if [[ $exit_code -ne 0 ]]; then
    echo "Artifacts kept at: ${ARTIFACT_DIR}" >&2
  else
    rm -rf "${ARTIFACT_DIR}"
  fi
}
trap cleanup EXIT

echo "Starting isolated backend on ${BASE_URL}"
(
  cd "${ROOT_DIR}"
  CLAUDE_CONFIG_DIR="${CONFIG_DIR}" SERVER_PORT="${API_PORT}" bun run src/server/index.ts --host 127.0.0.1 --port "${API_PORT}"
) >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!

echo "Starting web UI on http://127.0.0.1:${WEB_PORT}"
(
  cd "${DESKTOP_DIR}"
  bun run dev -- --host 127.0.0.1 --port "${WEB_PORT}"
) >"${WEB_LOG}" 2>&1 &
WEB_PID=$!

wait_for_http() {
  local url="$1"
  for _ in $(seq 1 120); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for ${url}" >&2
  return 1
}

browser_body() {
  agent-browser --session "${SESSION_NAME}" get text body
}

wait_for_body_contains() {
  local needle="$1"
  local attempts="${2:-180}"
  for _ in $(seq 1 "${attempts}"); do
    if browser_body | grep -Fq "${needle}"; then
      return 0
    fi
    sleep 2
  done
  echo "Timed out waiting for page text: ${needle}" >&2
  return 1
}

wait_for_body_contains_any() {
  local attempts="$1"
  shift

  for _ in $(seq 1 "${attempts}"); do
    local body
    body="$(browser_body)"
    for needle in "$@"; do
      if grep -Fq "${needle}" <<<"${body}"; then
        return 0
      fi
    done
    sleep 2
  done

  echo "Timed out waiting for any expected page text: $*" >&2
  return 1
}

wait_for_path() {
  local path="$1"
  local attempts="${2:-180}"
  for _ in $(seq 1 "${attempts}"); do
    if [[ -e "${path}" ]]; then
      return 0
    fi
    sleep 2
  done
  echo "Timed out waiting for path: ${path}" >&2
  return 1
}

AB="agent-browser --session ${SESSION_NAME}"
TELEGRAM_PROMPT="Install the official Telegram plugin from https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram. If the URL points to official external_plugins, identify the plugin id directly, complete a user-level install, then tell me the result."
SKILL_PROMPT="Install ui-ux-pro-max from the skill page https://www.aitmpl.com/component/skill/creative-design/ui-ux-pro-max. If the page has an official install command, identify and run it, then tell me the result."
PLUGIN_DIR="${CONFIG_DIR}/plugins/cache/claude-plugins-official/telegram"
SKILL_DIR="${CONFIG_DIR}/skills/ui-ux-pro-max"

wait_for_http "${BASE_URL}/health"
wait_for_http "http://127.0.0.1:${WEB_PORT}"

${AB} open "${WEB_URL}"
${AB} click 'button:has-text("Settings")'
${AB} click 'button:has-text("Install")'
${AB} screenshot "${ARTIFACT_DIR}/01-install-center.png" >/dev/null

run_install_prompt() {
  local prompt="$1"
  ${AB} click 'button:has-text("New install chat")'
  ${AB} fill 'textarea' "${prompt}"
  ${AB} click 'button:has-text("Send request")'
}

echo "Running plugin install flow"
run_install_prompt "${TELEGRAM_PROMPT}"
wait_for_body_contains 'telegram@claude-plugins-official'
wait_for_path "${PLUGIN_DIR}"
${AB} click 'button:has-text("Open Plugins")'
wait_for_body_contains 'Enabled1'
wait_for_body_contains 'telegram Enabled'
${AB} screenshot "${ARTIFACT_DIR}/02-plugin-installed.png" >/dev/null

echo "Running skill install flow"
${AB} click 'button:has-text("Install")'
run_install_prompt "${SKILL_PROMPT}"
wait_for_body_contains 'claude-code-templates@latest'
wait_for_path "${SKILL_DIR}"
${AB} click 'button:has-text("Open Skills")'
wait_for_body_contains 'Installed Skills'
wait_for_body_contains 'ui-ux-pro-max'
${AB} screenshot "${ARTIFACT_DIR}/03-skill-installed.png" >/dev/null

echo "Install Center E2E passed"
echo "Config dir: ${CONFIG_DIR}"
echo "API port: ${API_PORT}"
echo "Web port: ${WEB_PORT}"
