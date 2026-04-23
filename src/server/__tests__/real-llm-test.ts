/**
 * Real LLM Integration Test
 *
 * 真实调用 MiniMax API，验证完整的 WebSocket 对话流：
 * Server → CLI subprocess → MiniMax API → streaming response → WebSocket → client
 *
 * 使用 .env 中的 MiniMax 配置。
 */

const SERVER_PORT = 19876
const BASE_URL = `http://127.0.0.1:${SERVER_PORT}`
const WS_URL = `ws://127.0.0.1:${SERVER_PORT}`

// Generate a valid UUID for session ID (CLI requires UUID format)
function uuid(): string {
  return crypto.randomUUID()
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Test helpers ──────────────────────────────────────────────────────────

type ServerMsg = {
  type: string
  [key: string]: any
}

function createWebSocket(sessionId: string): Promise<{
  ws: WebSocket
  messages: ServerMsg[]
  waitForType: (type: string, timeoutMs?: number) => Promise<ServerMsg>
  waitForAny: (types: string[], timeoutMs?: number) => Promise<ServerMsg>
  close: () => void
}> {
  return new Promise((resolve, reject) => {
    const messages: ServerMsg[] = []
    const waiters: Array<{
      types: string[]
      resolve: (msg: ServerMsg) => void
      reject: (err: Error) => void
    }> = []

    const ws = new WebSocket(`${WS_URL}/ws/${sessionId}`)

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMsg
        messages.push(msg)
        // Check waiters
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].types.includes(msg.type)) {
            waiters[i].resolve(msg)
            waiters.splice(i, 1)
          }
        }
      } catch (e) {
        console.error('Failed to parse WS message:', event.data)
      }
    }

    ws.onerror = (event) => {
      reject(new Error(`WebSocket error`))
    }

    ws.onopen = () => {
      resolve({
        ws,
        messages,
        waitForType(type: string, timeoutMs = 60000) {
          // Check existing messages first
          const existing = messages.find((m) => m.type === type)
          if (existing) return Promise.resolve(existing)

          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              rej(
                new Error(
                  `Timeout waiting for message type "${type}" after ${timeoutMs}ms. Got: ${messages.map((m) => m.type).join(', ')}`
                )
              )
            }, timeoutMs)
            waiters.push({
              types: [type],
              resolve: (msg) => {
                clearTimeout(timer)
                res(msg)
              },
              reject: rej,
            })
          })
        },
        waitForAny(types: string[], timeoutMs = 60000) {
          const existing = messages.find((m) => types.includes(m.type))
          if (existing) return Promise.resolve(existing)

          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              rej(
                new Error(
                  `Timeout waiting for any of [${types.join(', ')}] after ${timeoutMs}ms. Got: ${messages.map((m) => m.type).join(', ')}`
                )
              )
            }, timeoutMs)
            waiters.push({
              types,
              resolve: (msg) => {
                clearTimeout(timer)
                res(msg)
              },
              reject: rej,
            })
          })
        },
        close() {
          ws.close()
        },
      })
    }
  })
}

// ─── Tests ─────────────────────────────────────────────────────────────────

let server: ReturnType<typeof import('../index.js').startServer> | null = null

async function startTestServer() {
  const { startServer } = await import('../index.js')
  server = startServer(SERVER_PORT, '127.0.0.1')
  await sleep(500) // Let server start
  console.log(`\n✅ Server started on port ${SERVER_PORT}`)
}

async function stopTestServer() {
  if (server) {
    server.stop(true)
    server = null
    await sleep(200)
    console.log('✅ Server stopped')
  }
}

// ── Test 1: REST API health check ──────────────────────────────────────

async function testHealthCheck() {
  console.log('\n── Test 1: Health Check ──')
  const res = await fetch(`${BASE_URL}/health`)
  const body = await res.json()
  if (res.status !== 200 || body.status !== 'ok') {
    throw new Error(`Health check failed: ${JSON.stringify(body)}`)
  }
  console.log('✅ Health check passed')
}

// ── Test 2: REST API sessions ──────────────────────────────────────────

async function testSessionsApi() {
  console.log('\n── Test 2: Sessions API ──')
  const res = await fetch(`${BASE_URL}/api/sessions`)
  if (res.status !== 200) {
    throw new Error(`Sessions API failed: ${res.status}`)
  }
  const body = await res.json()
  console.log(`✅ Sessions API returned ${body.sessions?.length ?? 0} sessions`)
}

// ── Test 3: REST API settings ──────────────────────────────────────────

async function testSettingsApi() {
  console.log('\n── Test 3: Settings API ──')
  const res = await fetch(`${BASE_URL}/api/settings`)
  if (res.status !== 200) {
    throw new Error(`Settings API failed: ${res.status}`)
  }
  const body = await res.json()
  console.log(`✅ Settings API returned:`, Object.keys(body.settings || body))
}

// ── Test 4: REST API models ────────────────────────────────────────────

async function testModelsApi() {
  console.log('\n── Test 4: Models API ──')
  const res = await fetch(`${BASE_URL}/api/models`)
  if (res.status !== 200) {
    throw new Error(`Models API failed: ${res.status}`)
  }
  const body = await res.json()
  console.log(`✅ Models API returned:`, body)
}

// ── Test 5: WebSocket connection ───────────────────────────────────────

async function testWebSocketConnect() {
  console.log('\n── Test 5: WebSocket Connect ──')
  const sessionId = uuid()
  const client = await createWebSocket(sessionId)
  const connMsg = await client.waitForType('connected', 5000)
  if (connMsg.sessionId !== sessionId) {
    throw new Error(`Session ID mismatch: ${connMsg.sessionId} !== ${sessionId}`)
  }
  client.close()
  await sleep(200)
  console.log('✅ WebSocket connected and received session ID')
}

// ── Test 6: WebSocket ping/pong ────────────────────────────────────────

async function testWebSocketPing() {
  console.log('\n── Test 6: WebSocket Ping/Pong ──')
  const sessionId = uuid()
  const client = await createWebSocket(sessionId)
  await client.waitForType('connected', 5000)

  client.ws.send(JSON.stringify({ type: 'ping' }))
  const pong = await client.waitForType('pong', 5000)
  if (pong.type !== 'pong') {
    throw new Error('Pong not received')
  }
  client.close()
  await sleep(200)
  console.log('✅ Ping/Pong works')
}

// ── Test 7: Real LLM chat (the critical test!) ────────────────────────

async function testRealLLMChat() {
  console.log('\n── Test 7: Real LLM Chat (MiniMax API) ──')
  console.log('   This will spawn a CLI subprocess and call the real API...')

  const sessionId = uuid()
  const client = await createWebSocket(sessionId)
  await client.waitForType('connected', 5000)
  console.log(`   Session: ${sessionId}`)

  // Send a simple message
  client.ws.send(
    JSON.stringify({
      type: 'user_message',
      content: 'Say "hello world" and nothing else. Keep it short.',
    })
  )

  console.log('   Message sent, waiting for response...')

  // We should get a status:thinking first
  const statusMsg = await client.waitForType('status', 10000)
  console.log(`   Got status: ${statusMsg.state} ${statusMsg.verb || ''}`)

  // Wait for either content_delta (success) or error
  const responseMsg = await client.waitForAny(
    ['content_delta', 'content_start', 'error', 'message_complete'],
    120000 // 2 minutes for LLM response
  )

  console.log(`   Got response type: ${responseMsg.type}`)

  if (responseMsg.type === 'error') {
    console.log(`   ❌ Error: ${responseMsg.message} (code: ${responseMsg.code})`)
    throw new Error(`LLM returned error: ${responseMsg.message}`)
  }

  // Collect all messages until message_complete
  let fullText = ''
  if (responseMsg.type === 'content_delta' && responseMsg.text) {
    fullText += responseMsg.text
  }

  // Wait for message_complete
  try {
    const complete = await client.waitForType('message_complete', 120000)
    console.log(`   Usage: input=${complete.usage?.input_tokens}, output=${complete.usage?.output_tokens}`)
  } catch {
    console.log('   Warning: message_complete not received within timeout')
  }

  // Gather all content_delta text
  for (const msg of client.messages) {
    if (msg.type === 'content_delta' && msg.text) {
      if (!fullText.includes(msg.text)) {
        fullText += msg.text
      }
    }
  }

  console.log(`   Response text: "${fullText.substring(0, 200)}"`)

  if (fullText.length === 0) {
    // Check all messages for debugging
    console.log('   All messages received:')
    for (const msg of client.messages) {
      console.log(`     ${msg.type}: ${JSON.stringify(msg).substring(0, 150)}`)
    }
    throw new Error('No content received from LLM')
  }

  client.close()
  await sleep(500)
  console.log('✅ Real LLM chat works! Got response from MiniMax API')
}

// ── Test 8: Scheduled tasks CRUD ───────────────────────────────────────

async function testScheduledTasks() {
  console.log('\n── Test 8: Scheduled Tasks CRUD ──')

  // Create
  const createRes = await fetch(`${BASE_URL}/api/scheduled-tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Test Task',
      prompt: 'Test prompt',
      cron: '0 9 * * *',
    }),
  })
  if (createRes.status !== 201) {
    const body = await createRes.text()
    throw new Error(`Create scheduled task failed: ${createRes.status} ${body}`)
  }
  const { task } = await createRes.json()
  console.log(`   Created task: ${task.id}`)

  // List
  const listRes = await fetch(`${BASE_URL}/api/scheduled-tasks`)
  const listBody = await listRes.json()
  const found = listBody.tasks?.find((t: any) => t.id === task.id)
  if (!found) throw new Error('Created task not found in list')
  console.log(`   Listed ${listBody.tasks.length} tasks`)

  // Update
  const updateRes = await fetch(`${BASE_URL}/api/scheduled-tasks/${task.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Updated Task' }),
  })
  if (updateRes.status !== 200) throw new Error(`Update failed: ${updateRes.status}`)

  // Delete
  const deleteRes = await fetch(`${BASE_URL}/api/scheduled-tasks/${task.id}`, {
    method: 'DELETE',
  })
  if (deleteRes.status !== 200) throw new Error(`Delete failed: ${deleteRes.status}`)

  console.log('✅ Scheduled Tasks CRUD works')
}

// ── Test 9: Settings read/write ────────────────────────────────────────

async function testSettingsReadWrite() {
  console.log('\n── Test 9: Settings Read/Write ──')

  // Read current
  const readRes = await fetch(`${BASE_URL}/api/settings`)
  const original = await readRes.json()

  // Update via /api/settings/user
  const updateRes = await fetch(`${BASE_URL}/api/settings/user`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testKey_integration: true }),
  })
  if (updateRes.status !== 200) throw new Error(`Settings update failed: ${updateRes.status}`)

  // Read back
  const readBack = await fetch(`${BASE_URL}/api/settings/user`)
  const updated = await readBack.json()

  // Clean up: remove test key via overwrite
  const cleanSettings = { ...updated }
  delete cleanSettings.testKey_integration
  await fetch(`${BASE_URL}/api/settings/user`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cleanSettings),
  })

  console.log('✅ Settings read/write works')
}

// ── Test 10: Permission mode ──────────────────────────────────────────

async function testPermissionMode() {
  console.log('\n── Test 10: Permission Mode ──')
  const res = await fetch(`${BASE_URL}/api/permissions/mode`)
  if (res.status !== 200) throw new Error(`Permissions failed: ${res.status}`)
  const body = await res.json()
  console.log(`   Current mode: ${body.mode || body.permissionMode || JSON.stringify(body)}`)
  console.log('✅ Permission mode API works')
}

// ── Test 11: Search API ────────────────────────────────────────────────

async function testSearchApi() {
  console.log('\n── Test 11: Search API ──')
  const res = await fetch(`${BASE_URL}/api/search/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'test' }),
  })
  if (res.status !== 200) throw new Error(`Search failed: ${res.status}`)
  const body = await res.json()
  console.log(`   Search results: ${body.results?.length ?? 0}`)
  console.log('✅ Search API works')
}

// ── Test 12: Agents API ────────────────────────────────────────────────

async function testAgentsApi() {
  console.log('\n── Test 12: Agents API ──')
  const res = await fetch(`${BASE_URL}/api/agents`)
  if (res.status !== 200) throw new Error(`Agents failed: ${res.status}`)
  const body = await res.json()
  console.log(`   Active agents: ${body.activeAgents?.length ?? body.agents?.length ?? 0}`)
  console.log('✅ Agents API works')
}

// ── Test 13: Teams API ─────────────────────────────────────────────────

async function testTeamsApi() {
  console.log('\n── Test 13: Teams API ──')
  const res = await fetch(`${BASE_URL}/api/teams`)
  if (res.status !== 200) throw new Error(`Teams failed: ${res.status}`)
  const body = await res.json()
  console.log(`   Teams: ${body.teams?.length ?? 0}`)
  console.log('✅ Teams API works')
}

// ── Test 14: Tasks API ─────────────────────────────────────────────────

async function testTasksApi() {
  console.log('\n── Test 14: Tasks API ──')
  const res = await fetch(`${BASE_URL}/api/tasks`)
  if (res.status !== 200) throw new Error(`Tasks failed: ${res.status}`)
  const body = await res.json()
  console.log(`   Tasks: ${body.tasks?.length ?? 0}`)
  console.log('✅ Tasks API works')
}

// ── Test 15: Status/Diagnostics API ────────────────────────────────────

async function testStatusApi() {
  console.log('\n── Test 15: Status API ──')
  const res = await fetch(`${BASE_URL}/api/status`)
  if (res.status !== 200) throw new Error(`Status failed: ${res.status}`)
  const body = await res.json()
  console.log(`   Status: ${body.status || JSON.stringify(body).substring(0, 100)}`)
  console.log('✅ Status API works')
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║  Real LLM Integration Test — MiniMax API via CLI       ║')
  console.log('╚══════════════════════════════════════════════════════════╝')

  const failures: string[] = []

  try {
    await startTestServer()

    // REST API tests (fast, run first)
    const restTests = [
      testHealthCheck,
      testSessionsApi,
      testSettingsApi,
      testModelsApi,
      testScheduledTasks,
      testSettingsReadWrite,
      testPermissionMode,
      testSearchApi,
      testAgentsApi,
      testTeamsApi,
      testTasksApi,
      testStatusApi,
    ]

    for (const test of restTests) {
      try {
        await test()
      } catch (err: any) {
        console.log(`❌ ${test.name} FAILED: ${err.message}`)
        failures.push(`${test.name}: ${err.message}`)
      }
    }

    // WebSocket tests
    const wsTests = [testWebSocketConnect, testWebSocketPing]

    for (const test of wsTests) {
      try {
        await test()
      } catch (err: any) {
        console.log(`❌ ${test.name} FAILED: ${err.message}`)
        failures.push(`${test.name}: ${err.message}`)
      }
    }

    // Real LLM test (slow, run last)
    try {
      await testRealLLMChat()
    } catch (err: any) {
      console.log(`❌ testRealLLMChat FAILED: ${err.message}`)
      failures.push(`testRealLLMChat: ${err.message}`)
    }
  } finally {
    await stopTestServer()
  }

  // Summary
  console.log('\n' + '═'.repeat(60))
  if (failures.length === 0) {
    console.log('🎉 ALL TESTS PASSED!')
  } else {
    console.log(`⚠️  ${failures.length} TEST(S) FAILED:`)
    for (const f of failures) {
      console.log(`   ❌ ${f}`)
    }
  }
  console.log('═'.repeat(60))

  process.exit(failures.length > 0 ? 1 : 0)
}

main()
