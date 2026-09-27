import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ConversationService } from '../services/conversationService.js'
import { ProviderService } from '../services/providerService.js'
import { sessionService } from '../services/sessionService.js'
import { normalizeAskUserQuestionToolResult } from '../ws/cliMessageParsing.js'

describe('automatic AskUserQuestion answers', () => {
  let configDir: string
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-question-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.HOME = configDir
    process.env.USERPROFILE = configDir
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    await fs.rm(configDir, { recursive: true, force: true })
  })

  function createPendingService() {
    const service = new ConversationService()
    const sent: any[] = []
    const callbacks: any[] = []
    const request = {
      toolName: 'AskUserQuestion',
      input: {
        questions: [{
          question: 'Which scope?',
          options: [
            { label: 'Local (Recommended)', description: 'Use this project' },
            { label: 'Global', description: 'Use every project' },
          ],
        }],
      },
    }
    const session = {
      sdkSocket: { send(line: string) { sent.push(JSON.parse(line)) } },
      pendingOutbound: [],
      pendingPermissionRequests: new Map([['req-1', request]]),
      outputCallbacks: [(message: unknown) => callbacks.push(message)],
    }
    ;(service as any).sessions.set('session-1', session)
    return { service, session, request, sent, callbacks }
  }

  it('keeps old settings without the new field disabled and preserves unknown data', async () => {
    await fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ futureField: { keep: true } }))
    const { service, session, request, sent } = createPendingService()

    await (service as any).autoAnswerQuestion('session-1', session, 'req-1', request)

    expect(sent).toHaveLength(0)
    expect(JSON.parse(await fs.readFile(path.join(configDir, 'settings.json'), 'utf8')))
      .toEqual({ futureField: { keep: true } })
  })

  it('uses the unique recommended option and marks the answer as automatic', async () => {
    await fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify({
      autoQuestion: { enabled: true, timeoutMinutes: 5 },
    }))
    const { service, session, request, sent, callbacks } = createPendingService()
    ;(request.input as any).metadata = { source: 'remember' }

    await (service as any).scheduleAutoQuestionAnswer('session-1', session, 'req-1', request)
    expect(request).toHaveProperty('autoAnswerTimer')

    await (service as any).autoAnswerQuestion('session-1', session, 'req-1', request)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'control_response',
      response: {
        request_id: 'req-1',
        response: {
          behavior: 'allow',
          updatedInput: {
            answers: { 'Which scope?': 'Local (Recommended)' },
            metadata: { source: 'remember', autoAnswered: true },
          },
        },
      },
    })
    expect(callbacks).toContainEqual({
      type: 'control_response',
      response: { request_id: 'req-1', response: { behavior: 'allow' } },
    })
    expect(service.respondToPermission('session-1', 'req-1', true)).toBe(false)
    expect(sent).toHaveLength(1)
  })

  it('does not answer after the user has resolved the request', async () => {
    await fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify({
      autoQuestion: { enabled: true, timeoutMinutes: 5 },
    }))
    const { service, session, request, sent } = createPendingService()

    expect(service.respondToPermission('session-1', 'req-1', true, undefined, {
      ...request.input,
      answers: { 'Which scope?': 'Global' },
    })).toBe(true)
    await (service as any).autoAnswerQuestion('session-1', session, 'req-1', request)

    expect(sent).toHaveLength(1)
    expect(sent[0].response.response.updatedInput.answers).toEqual({ 'Which scope?': 'Global' })
  })

  it('does not submit if automatic answering is disabled during decision work', async () => {
    const settingsPath = path.join(configDir, 'settings.json')
    await fs.writeFile(settingsPath, JSON.stringify({ autoQuestion: { enabled: true, timeoutMinutes: 5 } }))
    let releaseHistory!: () => void
    let enteredHistory!: () => void
    const entered = new Promise<void>((resolve) => { enteredHistory = resolve })
    const history = spyOn(sessionService, 'getSessionHistoryPage').mockImplementation(async () => {
      enteredHistory()
      await new Promise<void>((resolve) => { releaseHistory = resolve })
      return { messages: [] } as never
    })
    try {
      const { service, session, request, sent } = createPendingService()
      const deciding = (service as any).autoAnswerQuestion('session-1', session, 'req-1', request)
      await entered
      await fs.writeFile(settingsPath, JSON.stringify({ autoQuestion: { enabled: false, timeoutMinutes: 5 } }))
      releaseHistory()
      await deciding
      expect(sent).toHaveLength(0)
    } finally {
      history.mockRestore()
    }
  })

  it('removes an untrusted automatic marker from a manual answer', () => {
    const { service, request, sent } = createPendingService()
    expect(service.respondToPermission('session-1', 'req-1', true, undefined, {
      ...request.input,
      answers: { 'Which scope?': 'Global' },
      metadata: { source: 'remember', autoAnswered: true },
    })).toBe(true)
    expect(sent[0].response.response.updatedInput.metadata).toEqual({ source: 'remember' })
  })

  it('reschedules a waiting question from its original creation time', async () => {
    await fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify({
      autoQuestion: { enabled: true, timeoutMinutes: 5 },
    }))
    const { service, session, request } = createPendingService()
    ;(request as any).autoAnswerCreatedAt = Date.now() - 4 * 60_000
    await (service as any).scheduleAutoQuestionAnswer('session-1', session, 'req-1', request)
    const initialTimer = (request as any).autoAnswerTimer
    service.refreshAutoQuestionSettings()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect((request as any).autoAnswerTimer).toBeDefined()
    expect((request as any).autoAnswerTimer).not.toBe(initialTimer)
    service.cancelAutoQuestionAnswer('session-1', 'req-1')
  })

  it('cancels the deadline when the user interacts with the question', async () => {
    await fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify({
      autoQuestion: { enabled: true, timeoutMinutes: 5 },
    }))
    const { service, session, request, sent } = createPendingService()
    await (service as any).scheduleAutoQuestionAnswer('session-1', session, 'req-1', request)

    service.cancelAutoQuestionAnswer('session-1', 'req-1')
    await (service as any).autoAnswerQuestion('session-1', session, 'req-1', request)

    expect(sent).toHaveLength(0)
    expect(service.getPendingPermissionRequests('session-1')).toHaveLength(1)
  })

  it('does not schedule a deadline when interaction arrives during the settings read', async () => {
    await fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify({
      autoQuestion: { enabled: true, timeoutMinutes: 5 },
    }))
    const { service, session, request } = createPendingService()

    const scheduling = (service as any).scheduleAutoQuestionAnswer('session-1', session, 'req-1', request)
    service.cancelAutoQuestionAnswer('session-1', 'req-1')
    await scheduling

    expect((request as any).autoAnswerTimer).toBeUndefined()
  })

  it('leaves an unmarked question open when the session provider cannot be identified', async () => {
    await fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify({
      autoQuestion: { enabled: true, timeoutMinutes: 5 },
    }))
    const { service, session, request, sent } = createPendingService()
    ;(session as any).usesOfficialOAuth = false
    request.input.questions[0]!.options[0]!.label = 'Local'

    await (service as any).autoAnswerQuestion('session-1', session, 'req-1', request)

    expect(sent).toHaveLength(0)
    expect(service.getPendingPermissionRequests('session-1')).toHaveLength(1)
  })

  it('does not send conversation context to a provider edited after session launch', async () => {
    await fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify({
      autoQuestion: { enabled: true, timeoutMinutes: 5 },
    }))
    const providers = new ProviderService()
    const provider = await providers.addProvider({
      presetId: 'custom', name: 'Original', apiKey: 'old-fake-key',
      baseUrl: 'https://old.invalid', apiFormat: 'anthropic',
      models: { main: 'large', haiku: 'small', sonnet: 'large', opus: 'large' },
    })
    const { service, session, request, sent } = createPendingService()
    ;(session as any).providerId = provider.id
    ;(session as any).providerConfigFingerprint = JSON.stringify(provider)
    request.input.questions[0]!.options[0]!.label = 'Local'
    await providers.updateProvider(provider.id, { apiKey: 'new-fake-key', baseUrl: 'https://new.invalid' })
    const history = spyOn(sessionService, 'getSessionHistoryPage').mockResolvedValue({
      messages: [{ type: 'user', content: 'Choose based on this project.' }],
    } as never)
    try {
      await (service as any).autoAnswerQuestion('session-1', session, 'req-1', request)
      expect(sent).toHaveLength(0)
      expect(service.getPendingPermissionRequests('session-1')).toHaveLength(1)
    } finally {
      history.mockRestore()
    }
  })

  it('keeps a subagent question open when its own transcript is unavailable', async () => {
    await fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify({
      autoQuestion: { enabled: true, timeoutMinutes: 5 },
    }))
    const { service, session, request, sent } = createPendingService()
    request.input.questions[0]!.options[0]!.label = 'Local'
    ;(request as any).agentId = 'agent-1'
    const root = spyOn(sessionService, 'getSessionHistoryPage').mockResolvedValue({
      messages: [{ type: 'user', content: 'Parent context only.' }],
    } as never)
    const agent = spyOn(sessionService, 'getSubagentTranscript').mockResolvedValue({
      messages: [], taskNotifications: [],
    })
    try {
      await (service as any).autoAnswerQuestion('session-1', session, 'req-1', request)
      expect(agent).toHaveBeenCalledWith('session-1', 'agent-1', { bounded: true })
      expect(sent).toHaveLength(0)
    } finally {
      root.mockRestore()
      agent.mockRestore()
    }
  })

  it('preserves automatic provenance in the desktop tool result', () => {
    expect(normalizeAskUserQuestionToolResult('', {
      questions: [{ question: 'Which scope?' }],
      answers: { 'Which scope?': 'Local' },
      selectionSource: 'automatic',
    })).toEqual({
      questions: [{ question: 'Which scope?' }],
      answers: { 'Which scope?': 'Local' },
      selectionSource: 'automatic',
    })
  })
})
