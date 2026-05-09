import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleComputerUseApi } from '../api/computer-use.js'

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
let configDir: string | null = null

function makeRequest(method: string, body?: unknown): Request {
  return new Request('http://localhost/api/computer-use/authorized-apps', {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function callAuthorizedApps(method: string, body?: unknown): Promise<Response> {
  return handleComputerUseApi(
    makeRequest(method, body),
    new URL('http://localhost/api/computer-use/authorized-apps'),
    ['api', 'computer-use', 'authorized-apps'],
  )
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-computer-use-api-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(async () => {
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  }

  if (configDir) {
    await rm(configDir, { recursive: true, force: true })
    configDir = null
  }
})

describe('Computer Use API authorized app config', () => {
  it('defaults Computer Use enabled for existing users without config', async () => {
    const res = await callAuthorizedApps('GET')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      enabled: true,
      authorizedApps: [],
    })
  })

  it('persists the Computer Use enabled flag independently', async () => {
    const putRes = await callAuthorizedApps('PUT', { enabled: false })
    expect(putRes.status).toBe(200)

    const getRes = await callAuthorizedApps('GET')
    expect(await getRes.json()).toMatchObject({ enabled: false })

    const raw = await readFile(
      join(configDir!, 'cc-haha', 'computer-use-config.json'),
      'utf8',
    )
    expect(JSON.parse(raw)).toMatchObject({ enabled: false })
  })
})
