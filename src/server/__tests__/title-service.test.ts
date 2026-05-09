import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { generateTitle, parseGeneratedTitleText, saveAiTitle } from '../services/titleService.js'
import { sessionService } from '../services/sessionService.js'

describe('titleService', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined

  beforeEach(async () => {
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'title-service-test-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
  })

  afterEach(async () => {
    restoreEnv('CLAUDE_CONFIG_DIR', originalConfigDir)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('sends disabled thinking for opted-in providers when desktop thinking is off', async () => {
    let requestBody: Record<string, unknown> | null = null
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        requestBody = await req.json() as Record<string, unknown>
        return Response.json({
          content: [{ type: 'text', text: '{"title":"Trace ok"}' }],
        })
      },
    })

    try {
      const providerId = 'deepseek-test'
      await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
      await fs.writeFile(
        path.join(tmpDir, 'settings.json'),
        JSON.stringify({ alwaysThinkingEnabled: false }, null, 2),
      )
      await fs.writeFile(
        path.join(tmpDir, 'cc-haha', 'providers.json'),
        JSON.stringify({
          activeId: providerId,
          providers: [
            {
              id: providerId,
              presetId: 'deepseek',
              name: 'DeepSeek',
              apiKey: 'test-key',
              baseUrl: `http://127.0.0.1:${server.port}/anthropic`,
              apiFormat: 'anthropic',
              models: {
                main: 'deepseek-v4-pro',
                haiku: 'deepseek-v4-pro',
                sonnet: 'deepseek-v4-pro',
                opus: 'deepseek-v4-pro',
              },
            },
          ],
        }, null, 2),
      )

      await expect(generateTitle('请只回复 trace-ok')).resolves.toBe('Trace ok')
      expect(requestBody?.thinking).toEqual({ type: 'disabled' })
    } finally {
      server.stop(true)
    }
  })

  test('parses JSON title responses wrapped in markdown fences', () => {
    expect(parseGeneratedTitleText('```json\n{"title":"Write bash script"}\n```'))
      .toBe('Write bash script')
  })

  test('parses escaped JSON title responses', () => {
    expect(parseGeneratedTitleText('```json\n{\\"title\\":\\"Write bash script\\"}\n```'))
      .toBe('Write bash script')
  })

  test('rejects incomplete JSON title fragments instead of using them as titles', () => {
    expect(parseGeneratedTitleText('```json\n{\\"title\\":')).toBeNull()
  })

  test('does not persist automatic titles over a user custom title', async () => {
    const { sessionId } = await sessionService.createSession(os.tmpdir())
    await sessionService.renameSession(sessionId, 'My fixed name')

    await expect(saveAiTitle(sessionId, 'Automatic topic')).resolves.toBe(false)

    const detail = await sessionService.getSession(sessionId)
    expect(detail?.title).toBe('My fixed name')

    const found = await sessionService.findSessionFile(sessionId)
    expect(found).not.toBeNull()
    const content = await fs.readFile(found!.filePath, 'utf-8')
    expect(content).not.toContain('"type":"ai-title"')
  })
})

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}
