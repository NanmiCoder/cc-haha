#!/usr/bin/env bash
set -euo pipefail

if ! command -v agent-browser >/dev/null 2>&1; then
  echo "agent-browser is required for this UI E2E" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARTIFACT_DIR="${ARTIFACT_DIR:-/tmp/cc-haha-e2e-parallel-providers-$$}"
CONFIG_DIR="${ARTIFACT_DIR}/config"
PROJECT_A="${ARTIFACT_DIR}/project-a"
PROJECT_B="${ARTIFACT_DIR}/project-b"
SESSION_NAME_A="${SESSION_NAME_A:-cc-haha-provider-a-$$}"
SESSION_NAME_B="${SESSION_NAME_B:-cc-haha-provider-b-$$}"
RESPONSE_DELAY_MS="${RESPONSE_DELAY_MS:-15000}"

pick_port() {
  node -e "const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();})"
}

UPSTREAM_PORT="${UPSTREAM_PORT:-$(pick_port)}"
API_PORT="${API_PORT:-$(pick_port)}"
WEB_PORT="${WEB_PORT:-$(pick_port)}"

UPSTREAM_PID=""
SERVER_PID=""
WEB_PID=""

cleanup() {
  agent-browser --session "${SESSION_NAME_A}" close >/dev/null 2>&1 || true
  agent-browser --session "${SESSION_NAME_B}" close >/dev/null 2>&1 || true
  if [[ -n "${WEB_PID}" ]]; then kill "${WEB_PID}" >/dev/null 2>&1 || true; fi
  if [[ -n "${SERVER_PID}" ]]; then kill "${SERVER_PID}" >/dev/null 2>&1 || true; fi
  if [[ -n "${UPSTREAM_PID}" ]]; then kill "${UPSTREAM_PID}" >/dev/null 2>&1 || true; fi
  wait "${WEB_PID}" >/dev/null 2>&1 || true
  wait "${SERVER_PID}" >/dev/null 2>&1 || true
  wait "${UPSTREAM_PID}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "${ARTIFACT_DIR}" "${CONFIG_DIR}/cc-haha" "${PROJECT_A}" "${PROJECT_B}"
printf 'parallel provider A fixture\n' > "${PROJECT_A}/README.md"
printf 'parallel provider B fixture\n' > "${PROJECT_B}/README.md"

ARTIFACT_DIR="${ARTIFACT_DIR}" CONFIG_DIR="${CONFIG_DIR}" UPSTREAM_PORT="${UPSTREAM_PORT}" node --input-type=module <<'NODE'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const configDir = process.env.CONFIG_DIR
const upstream = `http://127.0.0.1:${process.env.UPSTREAM_PORT}`
mkdirSync(join(configDir, 'cc-haha'), { recursive: true })
writeFileSync(join(configDir, 'cc-haha', 'providers.json'), JSON.stringify({
  schemaVersion: 1,
  activeId: 'parallel-provider-a',
  providers: [
    {
      id: 'parallel-provider-a',
      presetId: 'custom',
      name: 'Parallel Provider A',
      apiKey: 'token-provider-a-only',
      authStrategy: 'auth_token',
      baseUrl: `${upstream}/provider-a`,
      apiFormat: 'anthropic',
      models: {
        main: 'parallel-model-a',
        haiku: 'parallel-model-a-haiku',
        sonnet: 'parallel-model-a-sonnet',
        opus: 'parallel-model-a-opus',
      },
    },
    {
      id: 'parallel-provider-b',
      presetId: 'custom',
      name: 'Parallel Provider B',
      apiKey: 'token-provider-b-only',
      authStrategy: 'auth_token',
      baseUrl: `${upstream}/provider-b`,
      apiFormat: 'anthropic',
      models: {
        main: 'parallel-model-b',
        haiku: 'parallel-model-b-haiku',
        sonnet: 'parallel-model-b-sonnet',
        opus: 'parallel-model-b-opus',
      },
    },
  ],
}, null, 2) + '\n')
NODE

ARTIFACT_DIR="${ARTIFACT_DIR}" UPSTREAM_PORT="${UPSTREAM_PORT}" RESPONSE_DELAY_MS="${RESPONSE_DELAY_MS}" node --input-type=module <<'NODE' &
import http from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'

const artifactDir = process.env.ARTIFACT_DIR
const port = Number(process.env.UPSTREAM_PORT)
const responseDelayMs = Number(process.env.RESPONSE_DELAY_MS)
mkdirSync(artifactDir, { recursive: true })
const captures = []

function persist() {
  writeFileSync(`${artifactDir}/captures.json`, JSON.stringify(captures, null, 2))
}

function providerFromUrl(url) {
  if (url?.startsWith('/provider-a/')) return 'provider-a'
  if (url?.startsWith('/provider-b/')) return 'provider-b'
  return 'unknown'
}

function anthropicJson(model, text) {
  return JSON.stringify({
    id: `msg_${model}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

function anthropicSse(model, text) {
  return [
    'event: message_start',
    `data: {"type":"message_start","message":{"id":"msg_${model}","type":"message","role":"assistant","model":"${model}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}`,
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${text}"}}`,
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

http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    let body = {}
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      body = { raw }
    }

    const provider = providerFromUrl(req.url)
    const model = typeof body.model === 'string' ? body.model : `unknown-${provider}`
    const capture = {
      id: captures.length + 1,
      provider,
      receivedAt: Date.now(),
      respondedAt: null,
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: {
        model: body.model,
        stream: body.stream,
        messageCount: Array.isArray(body.messages) ? body.messages.length : undefined,
      },
    }
    captures.push(capture)
    persist()

    const text = provider === 'provider-a' ? 'ok-provider-a' : provider === 'provider-b' ? 'ok-provider-b' : 'ok-unknown'
    setTimeout(() => {
      capture.respondedAt = Date.now()
      persist()
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(anthropicJson(model, text))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(anthropicSse(model, text))
    }, responseDelayMs)
  })
}).listen(port, '127.0.0.1', () => {
  console.log(`fake parallel provider upstream listening on ${port}`)
})
NODE
UPSTREAM_PID=$!

(
  cd "${ROOT_DIR}"
  CLAUDE_CONFIG_DIR="${CONFIG_DIR}" SERVER_PORT="${API_PORT}" \
    bun run src/server/index.ts --host 127.0.0.1 --port "${API_PORT}" \
      >"${ARTIFACT_DIR}/server.log" 2>&1
) &
SERVER_PID=$!

(
  cd "${ROOT_DIR}/desktop"
  VITE_DESKTOP_SERVER_URL="http://127.0.0.1:${API_PORT}" \
    bun run dev -- --host 127.0.0.1 --port "${WEB_PORT}" --strictPort \
      >"${ARTIFACT_DIR}/vite.log" 2>&1
) &
WEB_PID=$!

wait_for_url() {
  local url="$1"
  for _ in {1..120}; do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "Timed out waiting for ${url}" >&2
  exit 1
}

wait_for_url "http://127.0.0.1:${UPSTREAM_PORT}/health"
wait_for_url "http://127.0.0.1:${API_PORT}/health"
wait_for_url "http://127.0.0.1:${WEB_PORT}"

SESSION_INFO=$(API_PORT="${API_PORT}" PROJECT_A="${PROJECT_A}" PROJECT_B="${PROJECT_B}" node --input-type=module <<'NODE'
const api = `http://127.0.0.1:${process.env.API_PORT}`
async function create(workDir) {
  const res = await fetch(`${api}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workDir }),
  })
  if (!res.ok) throw new Error(`create session failed: ${res.status} ${await res.text()}`)
  return (await res.json()).sessionId
}
const a = await create(process.env.PROJECT_A)
const b = await create(process.env.PROJECT_B)
console.log(`${a} ${b}`)
NODE
)
SESSION_A="${SESSION_INFO%% *}"
SESSION_B="${SESSION_INFO##* }"

AB_A=(agent-browser --session "${SESSION_NAME_A}")
AB_B=(agent-browser --session "${SESSION_NAME_B}")
APP_URL="http://127.0.0.1:${WEB_PORT}"

setup_browser() {
  local session_id="$1"
  local provider_id="$2"
  local model_id="$3"
  local title="$4"
  shift 4
  local -a ab=("$@")

  "${ab[@]}" open "${APP_URL}" >/dev/null
  "${ab[@]}" eval "
    localStorage.setItem('cc-haha-open-tabs', JSON.stringify({
      openTabs: [{ sessionId: '${session_id}', title: '${title}', type: 'session' }],
      activeTabId: '${session_id}',
    }));
    localStorage.setItem('cc-haha-session-runtime', JSON.stringify({
      ['${session_id}']: { providerId: '${provider_id}', modelId: '${model_id}' },
    }));
  " >/dev/null
  "${ab[@]}" reload >/dev/null
  "${ab[@]}" wait textarea >/dev/null
}

setup_browser "${SESSION_A}" "parallel-provider-a" "parallel-model-a" "Parallel A" "${AB_A[@]}"
setup_browser "${SESSION_B}" "parallel-provider-b" "parallel-model-b" "Parallel B" "${AB_B[@]}"

click_run_js="
  [...document.querySelectorAll('button')]
    .find((node) => {
      const text = node.textContent || '';
      const title = node.getAttribute('title') || '';
      return !node.disabled && (
        text.includes('运行') ||
        text.includes('Run') ||
        title.includes('运行') ||
        title.includes('Run')
      );
    })
    ?.click();
"

(
  "${AB_A[@]}" fill textarea "Reply exactly ok-provider-a." >/dev/null
  "${AB_A[@]}" eval "${click_run_js}" >/dev/null
) &
SEND_A_PID=$!
sleep 0.5
(
  "${AB_B[@]}" fill textarea "Reply exactly ok-provider-b." >/dev/null
  "${AB_B[@]}" eval "${click_run_js}" >/dev/null
) &
SEND_B_PID=$!
wait "${SEND_A_PID}"
wait "${SEND_B_PID}"

ARTIFACT_DIR="${ARTIFACT_DIR}" node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs'

const path = `${process.env.ARTIFACT_DIR}/captures.json`
const deadline = Date.now() + 60_000
let captures = []
while (Date.now() < deadline) {
  try {
    captures = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    captures = []
  }
  const messages = captures.filter((capture) =>
    capture.url?.includes('/v1/messages?beta=true') &&
    capture.body?.stream === true
  )
  if (
    messages.some((capture) => capture.provider === 'provider-a' && capture.respondedAt) &&
    messages.some((capture) => capture.provider === 'provider-b' && capture.respondedAt)
  ) {
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
}

const messages = captures.filter((capture) =>
  capture.url?.includes('/v1/messages?beta=true') &&
  capture.body?.stream === true
)
const a = messages.find((capture) => capture.provider === 'provider-a')
const b = messages.find((capture) => capture.provider === 'provider-b')
if (!a) throw new Error('No request captured for provider A')
if (!b) throw new Error('No request captured for provider B')
if (!a.respondedAt || !b.respondedAt) throw new Error('Provider requests did not both complete')

if (a.headers.authorization !== 'Bearer token-provider-a-only') {
  throw new Error(`Provider A auth mismatch: ${a.headers.authorization}`)
}
if (b.headers.authorization !== 'Bearer token-provider-b-only') {
  throw new Error(`Provider B auth mismatch: ${b.headers.authorization}`)
}
if (a.body.model !== 'parallel-model-a') {
  throw new Error(`Provider A model mismatch: ${a.body.model}`)
}
if (b.body.model !== 'parallel-model-b') {
  throw new Error(`Provider B model mismatch: ${b.body.model}`)
}
if (a.headers.authorization.includes('provider-b') || b.headers.authorization.includes('provider-a')) {
  throw new Error('Provider auth values crossed sessions')
}

const latestReceive = Math.max(a.receivedAt, b.receivedAt)
const earliestResponse = Math.min(a.respondedAt, b.respondedAt)
if (!(latestReceive < earliestResponse)) {
  throw new Error('Provider requests were not in flight concurrently')
}

console.log(JSON.stringify({
  ok: true,
  providerA: { url: a.url, model: a.body.model, receivedAt: a.receivedAt, respondedAt: a.respondedAt },
  providerB: { url: b.url, model: b.body.model, receivedAt: b.receivedAt, respondedAt: b.respondedAt },
  overlapMs: earliestResponse - latestReceive,
}, null, 2))
NODE

"${AB_A[@]}" screenshot "${ARTIFACT_DIR}/provider-a-final.png" >/dev/null || true
"${AB_B[@]}" screenshot "${ARTIFACT_DIR}/provider-b-final.png" >/dev/null || true

echo "Parallel provider UI E2E passed. Artifacts: ${ARTIFACT_DIR}"
