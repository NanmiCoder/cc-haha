import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'
import type { ToolUseContext } from '../../Tool.js'
import { executeWorkflowScript, prepareWorkflowScript } from '../../utils/workflows/runtime.js'
import { findWorkflowByName, loadWorkflows } from '../../utils/workflows/discovery.js'
import { createRunJournal } from '../../utils/workflows/journal.js'
import { createWorkflowSharedCounters } from '../../utils/workflows/harness.js'
import { createWorkflowRunId, getWorkflowScriptPath, getWorkflowTranscriptDir } from '../../utils/workflows/paths.js'
import { areWorkflowsEnabled, describeWorkflowSizeGuideline } from '../../utils/workflows/enabled.js'
import { getProjectDir } from '../../utils/sessionStorage.js'
import type { WorkflowAgentRunParams, WorkflowAgentRunResult } from '../../utils/workflows/runWorkflowAgent.js'
import type { WorkflowProgressEvent } from '../../utils/workflows/types.js'
import { getTaskOutputPath, writeTaskOutput } from '../../utils/task/diskOutput.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { appendOfficialUltracodeReminder, type OfficialWorkflowInputContext } from './officialAgentSdkUltracode.js'
import type { ExtensionTool } from './officialAgentSdkExtensionTools.js'
import type { ExtensionSessionConfig } from './officialAgentSdkTeams.js'

export async function createOfficialAgentSdkWorkflowTools(config: ExtensionSessionConfig, deps: {
  runAgent(params: WorkflowAgentRunParams): Promise<WorkflowAgentRunResult>
  send?(event: Record<string, unknown>): void
  notify?(text: string): void
  canNotify?(): boolean
}): Promise<{ tools: ExtensionTool[]; transformPrompt(text: string, context?: OfficialWorkflowInputContext): Promise<string>; stopTask(taskId: string): Promise<boolean>; backgroundTasks(toolUseId?: string): Promise<boolean>; interrupt(): Promise<void> }> {
  const active = new Map<string, { controller: AbortController; toolUseId?: string; background(): boolean }>()
  const canBackground = () => Boolean(deps.notify) && deps.canNotify?.() !== false && !isEnvTruthy(config.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)
  const schema = z.strictObject({
    script: z.string().max(262144).optional(), scriptPath: z.string().optional(), name: z.string().optional(),
    run_in_background: z.boolean().optional().describe('Return immediately with a task ID and receive a completion notification. The workflow keeps running until completion or Stop.'),
    args: z.unknown().optional(), resumeFromRunId: z.string().regex(/^wf_[a-f0-9]{8}-[a-f0-9]{3}$/).optional(),
  }).refine(value => [value.script, value.scriptPath, value.name].filter(value => value !== undefined).length === 1, 'Provide exactly one of script, scriptPath or name')
  const tools: ExtensionTool[] = [{
    name: 'Workflow',
    description: 'Run a cc-hh JavaScript workflow only when the human asks for a workflow or orchestration. A script begins with export const meta={name,description,phases:[{title}]}; globals: agent(prompt,{label,phase,schema,model,effort,agentType,isolation}), parallel([()=>agent(...)]), pipeline(items,...stages), phase(title), log(text), args, workflow(name,args). No filesystem/network/Date.now/Math.random in script. Subagents use the official Agent SDK with the session model and permissions. Calls return results and a resumable run ID. Set run_in_background:true to continue the parent conversation while the workflow runs; otherwise the call waits, and the user can move it to the background. Stop cancels actual agents. A keyword ultracode system-reminder opts in only this human turn. A reminder saying Ultracode is on or still on is standing opt-in: use workflows for each substantive human task, and return to ordinary opt-in when it says Ultracode is off. Conversational or trivial mechanical work may be handled directly. Choose focused parallel review, independent verification, or staged implementation according to the human request; respect explicit scope and budget. Prefer one ordinary Agent call for isolated delegated work. ' + describeWorkflowSizeGuideline(),
    schema,
    async call(input, signal, toolUseId) {
      resetSettingsCache()
      if (!areWorkflowsEnabled()) throw new Error('Workflows are disabled in Settings')
      if (input.run_in_background && !canBackground()) throw new Error('Background workflows are unavailable in this session')
      const script = input.script ?? (input.scriptPath ? await readFile(input.scriptPath, 'utf8') : (await findWorkflowByName(input.name, config.cwd))?.script)
      if (!script) throw new Error('Workflow not found')
      const prepared = prepareWorkflowScript(script)
      if ('error' in prepared) throw new Error(prepared.error)
      const runId = input.resumeFromRunId ?? createWorkflowRunId()
      const taskId = `workflow-${randomUUID()}`
      const scriptPath = getWorkflowScriptPath(runId, prepared.meta.name)
      const transcriptDir = getWorkflowTranscriptDir(runId)
      await mkdir(dirname(scriptPath), { recursive: true })
      await writeFile(scriptPath, script)
      const journal = createRunJournal(runId)
      const shared = createWorkflowSharedCounters()
      const controller = new AbortController()
      let backgrounded = false
      let release!: (value: Record<string, unknown>) => void
      const background = new Promise<Record<string, unknown>>(resolve => { release = resolve })
      const backgroundTask = () => {
        if (backgrounded || !canBackground() || controller.signal.aborted) return false
        backgrounded = true
        signal.removeEventListener('abort', abort)
        release({ status: 'async_launched', taskType: 'local_workflow', taskId, runId, workflowName: prepared.meta.name, scriptPath, transcriptDir, outputFile: getTaskOutputPath(taskId) })
        return true
      }
      const abort = () => controller.abort(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      active.set(taskId, { controller, toolUseId, background: backgroundTask })
      const controllers = new Set<AbortController>()
      const startTime = Date.now()
      const progress: WorkflowProgressEvent[] = []
      let totalTokens = 0
      let totalToolCalls = 0
      const context = { abortController: controller, options: { mainLoopModel: config.model, tools: [] } } as unknown as ToolUseContext
      deps.send?.({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId,
        task_type: 'local_workflow', description: prepared.meta.description, workflow_run_id: runId, workflow_name: prepared.meta.name,
        session_id: config.sessionId, uuid: randomUUID() })
      const onProgress = (event: WorkflowProgressEvent) => {
        if (event.type === 'workflow_agent') {
          const old = progress.findIndex(item => item.type === 'workflow_agent' && item.index === event.index)
          if (old >= 0) progress[old] = event
          else progress.push(event)
        } else progress.push(event)
        deps.send?.({ type: 'system', subtype: 'task_progress', task_id: taskId, tool_use_id: toolUseId,
          description: prepared.meta.description, summary: prepared.meta.name, workflow_run_id: runId,
          workflow_progress: progress.filter(item => item.type !== 'workflow_log'),
          usage: { total_tokens: totalTokens, tool_uses: totalToolCalls, duration_ms: Date.now() - startTime } })
      }
      const execute = async (source: string, args: unknown, nested: boolean) => {
        const compiled = prepareWorkflowScript(source)
        if ('error' in compiled) throw new Error(compiled.error)
        return executeWorkflowScript({
          vmScript: compiled.vmScript, toolUseContext: context,
          canUseTool: (() => { throw new Error('Workflow permissions are handled by the official SDK') }) as any,
          runId, workflowName: compiled.meta.name, args,
          seedPhaseTitles: compiled.meta.phases?.map(phase => phase.title),
          journal, journalSnapshot: input.resumeFromRunId ? await journal.load() : undefined, shared,
          onProgress, onAgentController(_key, value) { if (value) controllers.add(value) },
          runAgentImpl: async params => {
            const result = await deps.runAgent(params)
            totalTokens += result.tokens
            totalToolCalls += result.toolCalls
            return result
          },
          ...(!nested ? { runNestedWorkflow: async (name: unknown, nestedArgs: unknown) => {
            let nestedScript: string | undefined
            if (typeof name === 'string') nestedScript = (await findWorkflowByName(name, config.cwd))?.script
            else if (name && typeof name === 'object' && 'scriptPath' in name && typeof name.scriptPath === 'string') nestedScript = await readFile(name.scriptPath, 'utf8')
            if (!nestedScript) throw new Error('Nested workflow not found')
            const outcome = await execute(nestedScript, nestedArgs, true)
            if (outcome.error) throw new Error(outcome.error)
            return outcome.result
          } } : {}),
        })
      }
      const executeTask = async () => {
        try {
          const outcome = await execute(script, input.args, false)
          const status = controller.signal.aborted ? 'stopped' : outcome.error ? 'failed' : 'completed'
          const outputFile = getTaskOutputPath(taskId)
          await writeTaskOutput(taskId, JSON.stringify({ ...outcome, status, workflowName: prepared.meta.name, workflowRunId: runId, workflowProgress: progress, totalTokens, totalToolCalls }))
          deps.send?.({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: toolUseId,
            status, summary: `${prepared.meta.name}: ${outcome.error || status}`, output_file: outputFile,
            workflow_run_id: runId, usage: { total_tokens: totalTokens, tool_uses: totalToolCalls, duration_ms: outcome.durationMs } })
          const result = { taskType: 'local_workflow', taskId, runId, workflowName: prepared.meta.name, status, scriptPath, transcriptDir, ...outcome }
          if (backgrounded) deps.notify?.(`<task-notification>\n${JSON.stringify({ task_id: taskId, status, summary: `${prepared.meta.name}: ${status}`, output_file: outputFile })}\n</task-notification>`)
          return result
        } catch (error) {
          const status = controller.signal.aborted ? 'stopped' : 'failed'
          const message = error instanceof Error ? error.message : 'Workflow failed'
          // Setup/IO failures must settle the task card too; they must never
          // become an unhandled rejection after the tool returned early.
          deps.send?.({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: toolUseId, status, summary: message, workflow_run_id: runId })
          if (backgrounded) deps.notify?.(`<task-notification>\n${JSON.stringify({ task_id: taskId, status, error: message })}\n</task-notification>`)
          return { taskType: 'local_workflow', taskId, runId, workflowName: prepared.meta.name, status, error: message, scriptPath, transcriptDir }
        } finally {
          active.delete(taskId)
          signal.removeEventListener('abort', abort)
          controller.abort()
          for (const child of controllers) child.abort()
        }
      }
      if (input.run_in_background) backgroundTask()
      return Promise.race([executeTask(), background])
    },
  }]
  return {
    tools,
    async stopTask(taskId) {
      const task = active.get(taskId)
      if (!task) return false
      task.controller.abort(new Error('The user stopped this workflow'))
      return true
    },
    async backgroundTasks(toolUseId) {
      if (!canBackground()) return false
      let changed = false
      for (const task of active.values()) {
        if (toolUseId !== undefined && task.toolUseId !== toolUseId) continue
        changed = task.background() || changed
      }
      return changed
    },
    async interrupt() { for (const task of active.values()) task.controller.abort(new Error('The user interrupted this turn')) },
    async transformPrompt(text, context) {
      if (context?.isHumanInput !== true) return text
      resetSettingsCache()
      const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec((context.humanText ?? text).trim())
      if (!match || !areWorkflowsEnabled()) return appendOfficialUltracodeReminder(text, context)
      const workflow = (await loadWorkflows(config.cwd)).find(item => item.name === match[1])
      if (!workflow) return appendOfficialUltracodeReminder(text, context)
      return `Run the saved cc-hh workflow ${JSON.stringify(workflow.name)} by calling mcp__cc_haha__Workflow exactly once with {name:${JSON.stringify(workflow.name)}${match[2] ? `,args:${JSON.stringify(match[2])}` : ''}}. Use its saved script. Report the result.`
    },
  }
}

/** Preserve the app's existing worker-transcript/phase projection format. */
export async function writeOfficialWorkflowAgentMetadata(config: ExtensionSessionConfig, params: WorkflowAgentRunParams, agentId: string) {
  const dir = join(getProjectDir(config.cwd), config.sessionId, 'subagents')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: params.opts?.agentType ?? 'workflow', description: params.opts?.label ?? params.prompt.slice(0, 100), workflow: params.workflow }))
  return join(dir, `agent-${agentId}.jsonl`)
}
