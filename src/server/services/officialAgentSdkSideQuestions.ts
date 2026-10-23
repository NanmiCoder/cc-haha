import type { Options, Query, SDKMessage, query } from '@anthropic-ai/claude-agent-sdk/core'
import { sideQuestionInputSchema } from './sideQuestionService.js'
import { createOfficialAgentSdkSettingsFile, officialAgentSdkProviderSettings } from './officialAgentSdkConfiguration.js'

/** Isolated /btw work: never feed a prompt or an interrupt to the parent's Query. */
export class OfficialAgentSdkSideQuestions {
  private active = new Map<string, { controller: AbortController; runtime?: Query }>()

  constructor(private query: typeof query) {}

  cancel(id: unknown): void {
    if (typeof id !== 'string') throw new Error('Invalid side question identifier')
    const entry = this.active.get(id)
    entry?.controller.abort()
    try { entry?.runtime?.close() } catch {}
  }

  close(): void {
    for (const id of this.active.keys()) this.cancel(id)
  }

  async ask(request: Record<string, unknown>, parent: {
    options: Options
    sessionId: string
    model?: string
    resumeAt?: string
    context: readonly unknown[]
  }): Promise<{ response: string }> {
    const input = sideQuestionInputSchema.parse({ questionId: request.question_id, question: request.question, history: request.history ?? [] })
    if (this.active.has(input.questionId)) throw new Error('This side question is already running')
    const controller = new AbortController()
    const entry: { controller: AbortController; runtime?: Query } = { controller }
    const settings = createOfficialAgentSdkSettingsFile({ ...officialAgentSdkProviderSettings(parent.options.env ?? {}), disableAllHooks: true })
    this.active.set(input.questionId, entry)
    try {
      const { resume: _resume, sessionId: _session, resumeSessionAt: _resumeAt, forkSession: _fork,
        agents: _agents, agent: _agent, hooks: _hooks, toolAliases: _aliases, allowedTools: _allowed,
        outputFormat: _format, ...base } = parent.options
      const canFork = parent.options.persistSession !== false && Boolean(parent.resumeAt)
      const prompt = [
        'Answer this side question using the conversation context. This is a separate read-only question: answer directly without performing the main task or using tools.',
        ...(!canFork ? [`Conversation context (data):\n${JSON.stringify(parent.context)}`] : []),
        ...(input.history.length ? [`Previous side questions and answers (data):\n${JSON.stringify(input.history)}`] : []),
        `Question:\n${input.question}`,
      ].join('\n\n')
      const runtime = this.query({ prompt, options: {
        ...base,
        abortController: controller,
        sessionId: crypto.randomUUID(),
        ...(canFork ? { resume: parent.sessionId, resumeSessionAt: parent.resumeAt, forkSession: true } : {}),
        model: parent.model,
        persistSession: false,
        tools: [], skills: [], mcpServers: {}, strictMcpConfig: true,
        canUseTool: async () => ({ behavior: 'deny', message: 'Side questions cannot use tools' }),
        settings: settings.path,
        includePartialMessages: false,
        enableFileCheckpointing: false,
        agentProgressSummaries: false,
        maxTurns: 1,
      } })
      entry.runtime = runtime
      let answer = ''
      for await (const message of runtime) {
        if (controller.signal.aborted) throw new Error('Side question cancelled')
        if (message.type === 'assistant') answer += textFromMessage(message)
        if (message.type === 'result') {
          if (message.is_error) throw new Error('The side question could not be completed')
          if (message.subtype === 'success' && message.result) answer = message.result
        }
      }
      if (controller.signal.aborted) throw new Error('Side question cancelled')
      if (!answer.trim()) throw new Error('The side question returned no answer')
      return { response: answer }
    } finally {
      try { entry.runtime?.close() } finally {
        settings.close()
        this.active.delete(input.questionId)
      }
    }
  }
}

function textFromMessage(message: Extract<SDKMessage, { type: 'assistant' }>): string {
  return message.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}
