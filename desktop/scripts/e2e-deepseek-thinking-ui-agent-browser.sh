#!/usr/bin/env bash
set -euo pipefail

if ! command -v agent-browser >/dev/null 2>&1; then
  echo "agent-browser is required for this UI E2E" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARTIFACT_DIR="${ARTIFACT_DIR:-/tmp/cc-haha-e2e-deepseek-thinking-$$}"
CONFIG_DIR="${ARTIFACT_DIR}/config"
UPSTREAM_PORT="${UPSTREAM_PORT:-49391}"
API_PORT="${API_PORT:-49392}"
WEB_PORT="${WEB_PORT:-49393}"
SESSION_NAME="${SESSION_NAME:-cc-haha-deepseek-thinking-ui-$$}"

mkdir -p "${ARTIFACT_DIR}"

UPSTREAM_PID=""
SERVER_PID=""
WEB_PID=""

cleanup() {
  agent-browser --session "${SESSION_NAME}" close >/dev/null 2>&1 || true
  if [[ -n "${WEB_PID}" ]]; then kill "${WEB_PID}" >/dev/null 2>&1 || true; fi
  if [[ -n "${SERVER_PID}" ]]; then kill "${SERVER_PID}" >/dev/null 2>&1 || true; fi
  if [[ -n "${UPSTREAM_PID}" ]]; then kill "${UPSTREAM_PID}" >/dev/null 2>&1 || true; fi
  wait "${WEB_PID}" >/dev/null 2>&1 || true
  wait "${SERVER_PID}" >/dev/null 2>&1 || true
  wait "${UPSTREAM_PID}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

ARTIFACT_DIR="${ARTIFACT_DIR}" UPSTREAM_PORT="${UPSTREAM_PORT}" node --input-type=module <<'NODE' &
import http from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'

const artifactDir = process.env.ARTIFACT_DIR
const port = Number(process.env.UPSTREAM_PORT)
mkdirSync(artifactDir, { recursive: true })
const captures = []

function record(req, body) {
  captures.push({
    ts: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: req.headers,
    body,
  })
  writeFileSync(`${artifactDir}/captures.json`, JSON.stringify(captures, null, 2))
}

function anthropicSse() {
  return [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_ui_test","type":"message","role":"assistant","model":"deepseek-v4-pro","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n')
}

function openaiChatSse() {
  return [
    'data: {"id":"chatcmpl-ui","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl-ui","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl-ui","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
}

http.createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    let body = {}
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      body = { raw }
    }
    record(req, body)

    const hasConflict =
      body?.thinking?.type === 'disabled' &&
      body?.output_config?.effort !== undefined
    if (hasConflict) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: {
          message: 'thinking options type cannot be disabled when reasoning_effort is set',
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_request_error',
        },
      }))
      return
    }

    if (req.url?.includes('/v1/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(openaiChatSse())
      return
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(anthropicSse())
  })
}).listen(port, '127.0.0.1', () => {
  console.log(`fake upstream listening on ${port}`)
})
NODE
UPSTREAM_PID=$!

(
  cd "${ROOT_DIR}"
  CLAUDE_CONFIG_DIR="${CONFIG_DIR}" SERVER_PORT="${API_PORT}" \
    bun run src/server/index.ts --host 127.0.0.1 --port "${API_PORT}"
) &
SERVER_PID=$!

(
  cd "${ROOT_DIR}/desktop"
  VITE_DESKTOP_SERVER_URL="http://127.0.0.1:${API_PORT}" \
    bun run dev -- --host 127.0.0.1 --port "${WEB_PORT}"
) &
WEB_PID=$!

wait_for_url() {
  local url="$1"
  for _ in {1..80}; do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "Timed out waiting for ${url}" >&2
  exit 1
}

wait_for_url "http://127.0.0.1:${API_PORT}/health"
wait_for_url "http://127.0.0.1:${WEB_PORT}"

AB=(agent-browser --session "${SESSION_NAME}")
APP_URL="http://127.0.0.1:${WEB_PORT}"
UPSTREAM_URL="http://127.0.0.1:${UPSTREAM_PORT}"

"${AB[@]}" open "${APP_URL}" >/dev/null

ui_eval() {
  "${AB[@]}" eval "$1" >/dev/null
}

ui_eval "
const buttonByName = (name) => [...document.querySelectorAll('button')]
  .find((node) => (node.getAttribute('aria-label') || node.textContent || '').trim() === name);
buttonByName('Settings')?.click();
"
"${AB[@]}" wait 300 >/dev/null
ui_eval "
[...document.querySelectorAll('button')]
  .find((node) => (node.textContent || '').includes('Add Model'))
  ?.click();
"
"${AB[@]}" wait 300 >/dev/null
ui_eval "
const setValue = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const byPlaceholder = (placeholder) => [...document.querySelectorAll('input,textarea')]
  .find((node) => node.getAttribute('placeholder') === placeholder);
setValue(byPlaceholder('https://api.example.com/anthropic'), '${UPSTREAM_URL}/anthropic');
setValue(byPlaceholder('sk-...'), 'ui-test-key');
"
"${AB[@]}" wait 300 >/dev/null
ui_eval "
[...document.querySelectorAll('button')]
  .find((node) => (node.textContent || '').trim() === 'Add' && !node.disabled)
  ?.click();
"
"${AB[@]}" wait 700 >/dev/null
ui_eval "
[...document.querySelectorAll('button')]
  .find((node) => (node.textContent || '').includes('Set default'))
  ?.click();
"
"${AB[@]}" wait 300 >/dev/null
ui_eval "
[...document.querySelectorAll('button')]
  .find((node) => (node.getAttribute('aria-label') || node.textContent || '').includes('General'))
  ?.click();
"
"${AB[@]}" wait 300 >/dev/null
ui_eval "
[...document.querySelectorAll('button')]
  .find((node) => (node.textContent || '').trim() === 'Medium')
  ?.click();
const thinking = [...document.querySelectorAll('input[type=\"checkbox\"]')]
  .find((node) => node.getAttribute('aria-label') === 'Enable thinking mode');
if (thinking?.checked) thinking.click();
"
"${AB[@]}" wait 300 >/dev/null
ui_eval "document.querySelector('button[aria-label=\"Close Settings\"]')?.click();"
"${AB[@]}" wait 300 >/dev/null
"${AB[@]}" fill textarea "Say ok" >/dev/null
"${AB[@]}" eval "[...document.querySelectorAll('button')].find((node)=>node.textContent?.includes('Run') && !node.disabled)?.click();" >/dev/null
"${AB[@]}" wait 5000 >/dev/null

node --input-type=module <<NODE
import { readFileSync } from 'node:fs'
const captures = JSON.parse(readFileSync('${ARTIFACT_DIR}/captures.json', 'utf8'))
const main = captures.find((capture) => capture.url.includes('/anthropic/v1/messages?beta=true'))
if (!main) throw new Error('No DeepSeek Anthropic UI request captured')
if (main.body?.thinking?.type !== 'disabled') throw new Error('DeepSeek request did not disable thinking')
if (main.body?.output_config?.effort !== undefined) {
  throw new Error('DeepSeek request still sends output_config.effort with disabled thinking')
}
NODE

ui_eval "
const buttonByName = (name) => [...document.querySelectorAll('button')]
  .find((node) => (node.getAttribute('aria-label') || node.textContent || '').trim() === name);
buttonByName('Settings')?.click();
"
"${AB[@]}" wait 300 >/dev/null
ui_eval "
[...document.querySelectorAll('button')]
  .find((node) => (node.textContent || '').includes('Add Model'))
  ?.click();
"
"${AB[@]}" wait 300 >/dev/null
ui_eval "
[...document.querySelectorAll('button')]
  .find((node) => (node.textContent || '').trim() === 'Custom')
  ?.click();
"
"${AB[@]}" wait 300 >/dev/null
ui_eval "
[...document.querySelectorAll('button')]
  .find((node) => (node.textContent || '').includes('Anthropic Messages'))
  ?.click();
"
"${AB[@]}" wait 100 >/dev/null
ui_eval "
[...document.querySelectorAll('button')]
  .find((node) => (node.textContent || '').includes('OpenAI Chat Completions'))
  ?.click();
"
"${AB[@]}" wait 300 >/dev/null
ui_eval "
const setValue = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const byPlaceholder = (placeholder) => [...document.querySelectorAll('input,textarea')]
  .find((node) => node.getAttribute('placeholder') === placeholder);
setValue(byPlaceholder('Configuration name'), 'Custom OpenAI DeepSeek');
setValue(byPlaceholder('https://api.example.com/anthropic'), '${UPSTREAM_URL}');
setValue(byPlaceholder('sk-...'), 'ui-test-key');
setValue(byPlaceholder('Model ID'), 'deepseek-v4-pro');
const sameAsMain = [...document.querySelectorAll('input')]
  .filter((node) => node.getAttribute('placeholder') === 'Same as main');
setValue(sameAsMain[0], 'deepseek-v4-flash');
setValue(sameAsMain[1], 'deepseek-v4-pro');
setValue(sameAsMain[2], 'deepseek-v4-pro');
"
"${AB[@]}" wait 300 >/dev/null
ui_eval "
[...document.querySelectorAll('button')]
  .find((node) => (node.textContent || '').trim() === 'Add' && !node.disabled)
  ?.click();
"
"${AB[@]}" wait 700 >/dev/null
ui_eval "
const buttons = [...document.querySelectorAll('button')]
  .filter((node) => (node.textContent || '').includes('Set default'));
buttons.at(-1)?.click();
"
"${AB[@]}" wait 300 >/dev/null
ui_eval "document.querySelector('button[aria-label=\"Close Settings\"]')?.click();"
"${AB[@]}" wait 300 >/dev/null
ui_eval "
[...document.querySelectorAll('button')]
  .find((node) => (node.getAttribute('aria-label') || node.textContent || '').trim() === 'New session')
  ?.click();
"
"${AB[@]}" wait 300 >/dev/null
"${AB[@]}" fill textarea "Say ok through custom openai" >/dev/null
"${AB[@]}" eval "[...document.querySelectorAll('button')].find((node)=>node.textContent?.includes('Run') && !node.disabled)?.click();" >/dev/null
"${AB[@]}" wait 5000 >/dev/null

node --input-type=module <<NODE
import { readFileSync } from 'node:fs'
const captures = JSON.parse(readFileSync('${ARTIFACT_DIR}/captures.json', 'utf8'))
const openai = captures.find((capture) => capture.url.includes('/v1/chat/completions'))
if (!openai) throw new Error('No Custom OpenAI Chat UI request captured')
if (openai.body?.thinking !== undefined) throw new Error('OpenAI Chat request leaked Anthropic thinking')
if (openai.body?.output_config !== undefined) throw new Error('OpenAI Chat request leaked Anthropic output_config')
if (openai.body?.reasoning_effort !== undefined) throw new Error('OpenAI Chat request unexpectedly sent reasoning_effort')
NODE

echo "UI E2E passed. Artifacts: ${ARTIFACT_DIR}"
