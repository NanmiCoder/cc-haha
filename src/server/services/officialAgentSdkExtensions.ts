import { randomUUID } from 'node:crypto'
import { z } from 'zod/v4'
import { appendFile } from 'node:fs/promises'
import type { CanUseTool, ModelUsage, Options, Query, query } from '@anthropic-ai/claude-agent-sdk/core'
import type { OfficialAgentSdkConfig, OfficialAgentSdkExtensions } from './officialAgentSdkBridge.js'
import type { ToolUseContext } from '../../Tool.js'
import { createExtensionServer, type ExtensionTool } from './officialAgentSdkExtensionTools.js'
import { createOfficialAgentSdkTeamTools } from './officialAgentSdkTeams.js'
import { createOfficialAgentSdkWorkflowTools, writeOfficialWorkflowAgentMetadata } from './officialAgentSdkWorkflows.js'
import { sessionCollaborationTools } from '../../tools/SessionCollaborationTool/SessionCollaborationTool.js'
import { callSessionBridge, isSessionBridgeAvailable } from '../../tools/SessionCollaborationTool/bridge.js'
import { setCwdState, setOriginalCwd, switchSession } from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'
import { enableConfigs } from '../../utils/config.js'
import { loadStoredComputerUseConfig } from '../../utils/computerUse/preauthorizedConfig.js'

type Dependencies = {
  query: typeof query
  send?(message: Record<string, unknown>): void
  /** Native-helper injection is only used by isolated regression fixtures. */
  computer?: Awaited<ReturnType<typeof import('./officialAgentSdkComputer.js').createOfficialAgentSdkComputer>> | false
  teamCatalog?: NonNullable<Parameters<typeof createOfficialAgentSdkTeamTools>[1]>['catalog']
}

/** Add app capabilities through ordinary SDK MCP tools, without changing API identity. */
export async function createOfficialAgentSdkExtensions(config: OfficialAgentSdkConfig, dependencies: Dependencies): Promise<OfficialAgentSdkExtensions> {
  if (config.launchOptions.agentProfile === 'lean') return {}
  const session = { ...config, sessionId: config.hostSessionId || config.sessionId }
  const sideChat = session.sessionId.startsWith('side-')
  const teamWorker = Boolean(config.env.CC_HAHA_TEAM_WORKER)
  switchSession(session.sessionId as SessionId)
  setOriginalCwd(config.cwd)
  setCwdState(config.cwd)
  enableConfigs()
  let pendingReview = false
  let closed = false
  let canUseTool: CanUseTool | undefined
  let parentOptions: Options | undefined
  let notify: ((text: string) => void) | undefined
  Object.defineProperty(session, 'model', { get: () => parentOptions?.model ?? config.model })
  Object.defineProperty(session, 'effort', { get: () => parentOptions?.effort ?? config.effort })
  const children = new Set<Query>()
  const childUsage = new Map<string, { totalCostUSD: number; modelUsage: Record<string, ModelUsage>; durationApiMs: number }>()
  const requestReview = () => { pendingReview = true }
  const tools = sideChat ? [] : await createOfficialAgentSdkTeamTools(session, { catalog: dependencies.teamCatalog, requestReview })
  const workflows = await createOfficialAgentSdkWorkflowTools(session, {
    send: dependencies.send,
    canNotify: () => config.transport === 'websocket' && Boolean(notify) && !closed,
    notify(text) { if (!closed) notify?.(text) },
    async runAgent(params) {
      if (closed || params.abortController.signal.aborted) throw new Error('Workflow cancelled')
      if (!parentOptions || !canUseTool) throw new Error('The official SDK workflow runtime is not initialized')
      const id = randomUUID()
      const transcript = await writeOfficialWorkflowAgentMetadata(session, params, id)
      params.onAgentId(id)
      let worktree: import('../../utils/worktree.js').AgentWorktree | undefined
      if (params.opts?.isolation === 'worktree') {
        worktree = (await (await import('../../utils/worktree.js')).createAgentWorktreeIfSupported(`sdk-${id.slice(0, 12)}`)).worktree
      }
      const {
        sessionId: _sessionId, resume: _resume, resumeSessionAt: _resumeAt, forkSession: _fork,
        abortController: _parentAbort, toolAliases: _aliases,
        allowedTools: _allowed, mcpServers: servers, ...base
      } = parentOptions
      const externalMcp = Object.fromEntries(Object.entries(servers ?? {}).filter(([, server]) => server.type !== 'sdk'))
      // A connected SDK MCP instance belongs to one Query. Give each child
      // its own server for app context reads; mutation/orchestration remains
      // with the owning parent or a separately approved team worker.
      const childTools = tools.filter(tool => tool.readOnly === true)
      const childServer = childTools.length ? createExtensionServer('cc_haha', childTools) : undefined
      const options: Options = {
        ...base,
        mcpServers: { ...externalMcp, ...(childServer ? { cc_haha: childServer } : {}) }, abortController: params.abortController,
        cwd: worktree?.worktreePath ?? config.cwd, canUseTool,
        sessionId: id, persistSession: false,
        model: params.opts?.model ?? session.model,
        ...(params.opts?.effort ? { effort: params.opts.effort as Options['effort'] } : {}),
        ...(params.opts?.agentType ? { agent: params.opts.agentType } : {}),
        ...(params.opts?.schema ? { outputFormat: { type: 'json_schema', schema: params.opts.schema as Record<string, unknown> } } : {}),
        includePartialMessages: false,
      }
      let child: Query | undefined
      let value: unknown
      let gotResult = false
      let tokens = 0
      let toolCalls = 0
      try {
        child = dependencies.query({ prompt: params.prompt, options })
        children.add(child)
        for await (const message of child) {
          await appendFile(transcript, JSON.stringify({ ...message, cwd: options.cwd, sessionId: session.sessionId, timestamp: new Date().toISOString() }) + '\n')
          if (message.type === 'assistant') {
            for (const block of message.message.content) if (block.type === 'tool_use') toolCalls++
            tokens += (message.message.usage?.output_tokens ?? 0)
            params.onProgress({ tokens, toolCalls })
          }
          if (message.type === 'result') {
            gotResult = true
            childUsage.set(id, { totalCostUSD: message.total_cost_usd ?? 0, modelUsage: message.modelUsage ?? {}, durationApiMs: message.duration_api_ms ?? 0 })
            if (message.is_error || message.subtype !== 'success') throw new Error('errors' in message ? message.errors.join('; ') : 'Workflow agent failed')
            value = message.structured_output ?? message.result
            tokens = (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0)
          }
        }
        if (params.abortController.signal.aborted) throw new Error('Workflow agent cancelled')
        if (!gotResult) throw new Error('Workflow agent exited without a result')
        return { agentId: id, value, tokens, toolCalls, ...(worktree ? { worktreePath: worktree.worktreePath } : {}) }
      } finally {
        if (child) { children.delete(child); child.close() }
        await childServer?.instance.close()
        if (worktree) {
          const { hasWorktreeChanges, removeAgentWorktree } = await import('../../utils/worktree.js')
          if (!await hasWorktreeChanges(worktree.worktreePath)) {
            await removeAgentWorktree(worktree.worktreePath, worktree.worktreeBranch, worktree.gitRoot, worktree.hookBased)
          }
        }
      }
    },
  })
  if (!sideChat && !teamWorker) tools.push(...workflows.tools)
  if (isSessionBridgeAvailable()) {
    for (const tool of sessionCollaborationTools) {
      if ((sideChat || teamWorker) && !tool.isReadOnly?.({} as any)) continue
      tools.push({
        name: tool.name, description: await tool.description({} as any), schema: tool.inputSchema,
        readOnly: tool.isReadOnly?.({} as any) === true,
        async call(input, signal, toolUseId) {
          const controller = new AbortController()
          const abort = () => controller.abort(signal.reason)
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
          try {
            // No fabricated human message IDs: an explicit model choice that
            // cannot be attributed to a desktop user message takes the normal
            // human review card path.
            const result = await tool.call(input, { messages: [], toolUseId, abortController: controller } as unknown as ToolUseContext, undefined as never, undefined as never)
            if (result.data && typeof result.data === 'object' && 'requiresReview' in result.data && result.data.requiresReview) requestReview()
            return result.data
          } finally { signal.removeEventListener('abort', abort) }
        },
      } as ExtensionTool)
    }
    if (!sideChat && !teamWorker) {
      const taskId = z.string().min(1).max(200)
      const scheduling: Array<{ name: string; action: string; description: string; schema: z.ZodType; readOnly?: boolean }> = [
        { name: 'CronCreate', action: 'cron-create', description: 'Create a persistent cc-hh scheduled task only when the human asks for a schedule. Uses this conversation provider/model/project and runs through the desktop scheduler. cron is a five-field expression in local time; recurring defaults true.', schema: z.strictObject({ name: z.string().max(200).optional(), prompt: z.string().min(1).max(32000), cron: z.string().min(1).max(200), recurring: z.boolean().optional() }) },
        { name: 'CronList', action: 'cron-list', description: 'List the cc-hh scheduled tasks.', schema: z.strictObject({}), readOnly: true },
        { name: 'CronUpdate', action: 'cron-update', description: 'Update an existing cc-hh scheduled task requested by the human.', schema: z.strictObject({ taskId, name: z.string().max(200).optional(), prompt: z.string().min(1).max(32000).optional(), cron: z.string().min(1).max(200).optional(), enabled: z.boolean().optional(), recurring: z.boolean().optional() }) },
        { name: 'CronDelete', action: 'cron-delete', description: 'Delete a cc-hh scheduled task when the human asks to cancel it.', schema: z.strictObject({ taskId }) },
        ...(config.env.CC_HAHA_AGENT_TEAMS_ENABLED === '1' ? [{ name: 'TeamDelete', action: 'team-delete', description: 'Stop and remove the team led by this conversation through the desktop supervisor. Call only when the user wants to end that team.', schema: z.strictObject({ teamName: z.string().min(1).max(200) }) }] : []),
      ]
      tools.push(...scheduling.map(tool => ({ ...tool, call(input: unknown, signal: AbortSignal) { return callSessionBridge(tool.action, input, signal) } })))
    }
  }
  const server = createExtensionServer('cc_haha', tools)
  const computer = dependencies.computer === false ? undefined : dependencies.computer ?? (
    process.platform === 'darwin' || process.platform === 'win32'
      ? await (await import('./officialAgentSdkComputer.js')).createOfficialAgentSdkComputer()
      : undefined
  )
  const computerEnabled = computer ? (await loadStoredComputerUseConfig()).enabled : false
  return {
    mcpServers: { cc_haha: server, ...(computer ? { cc_haha_computer: computer.server } : {}) },
    // These tools still enforce Settings and OS consent at every operation.
    // Other app tools retain the native SDK's normal tool approval handling.
    allowedTools: computer ? ['mcp__cc_haha_computer__*'] : [],
    // Ordinary SDK task tools keep their native session scope. Approved app
    // workers use the shared team list; leaders explicitly call the MCP task
    // names while coordinating a team.
    toolAliases: Object.fromEntries(tools.filter(tool => teamWorker || !/^Task(?:Create|List|Get|Update)$/.test(tool.name)).map(tool => [tool.name, `mcp__cc_haha__${tool.name}`])),
    appendSystemPrompt: [
      sideChat ? 'This is an ephemeral cc-hh side chat. Use normal file/search tools for the current question; do not create teams, workflows, schedules or delegated conversations.' : 'cc-hh app integration: use the cc_haha MCP tools for app teams, shared team tasks, saved workflows and desktop conversation collaboration. Normal isolated Agent subcalls still use the official Agent tool. TeamCreate/TeamPlan only prepare drafts; only the human can approve in the team panel. End the turn after a pending review, and never spawn workers to bypass review. For an app team, use mcp__cc_haha__TaskList/TaskGet/TaskCreate/TaskUpdate for the shared task list and SendMessage to report results. Do not create teams unless the user requested team work.',
      computerEnabled ? 'Computer Use is enabled by the user in cc-hh Settings. Use mcp__cc_haha_computer__js; start with exactly await cua.getApp("App Name") to bind a native app and read the returned API documentation and AX state. Use screenshots when needed, only observed element handles/coordinates, and observe after actions. The JavaScript state persists. js_reset clears it. Prefer configured browser MCPs for browser automation when available.' : '',
    ].filter(Boolean).join('\n'),
    configure(context) { canUseTool = context.canUseTool; parentOptions = context.options; notify = context.notify },
    async beforeUserMessage(context) { if (context?.isHumanInput === true) pendingReview = false },
    transformPrompt: sideChat || teamWorker ? async text => text : workflows.transformPrompt,
    hooks: {
      PreToolUse: [{ hooks: [async () => pendingReview ? {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'A cc-hh plan is awaiting human review. End this turn and wait for the user.' },
      } : {}] }],
    },
    async onTurnEnd() { await computer?.onTurnEnd() },
    stopTask: workflows.stopTask,
    backgroundTasks: workflows.backgroundTasks,
    async interrupt() {
      await workflows.interrupt()
      for (const child of children) child.close()
      await computer?.onTurnEnd()
    },
    usage() {
      let totalCostUSD = 0
      let durationApiMs = 0
      const modelUsage: Record<string, ModelUsage> = {}
      const counters = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'webSearchRequests', 'costUSD'] as const
      for (const usage of childUsage.values()) {
        totalCostUSD += usage.totalCostUSD
        durationApiMs += usage.durationApiMs
        for (const [model, next] of Object.entries(usage.modelUsage)) {
          const previous = modelUsage[model]
          modelUsage[model] = { ...next }
          for (const key of counters) modelUsage[model]![key] = (previous?.[key] ?? 0) + (next[key] ?? 0)
        }
      }
      return { totalCostUSD, modelUsage, durationApiMs }
    },
    async close() {
      if (closed) return
      closed = true
      await workflows.interrupt()
      for (const child of children) child.close()
      await Promise.all([computer?.close(), server.instance.close()])
    },
  }
}
