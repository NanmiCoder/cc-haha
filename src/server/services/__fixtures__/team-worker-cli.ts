import { mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sanitizePath } from '../../../utils/sessionStoragePortable.js'
// Deterministic worker protocol fixture. Never contacts anything except loopback.
if (process.env.FIXTURE_LOAD_MANAGED_ENV === '1') {
  const { applyConfigEnvironmentVariables, applySafeConfigEnvironmentVariables } = await import('../../../utils/managedEnv.js')
  applySafeConfigEnvironmentVariables()
  applyConfigEnvironmentVariables()
}
const args = process.argv.slice(2)
const arg = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
// A restarted worker resumes its own transcript instead of starting a new one.
const sessionId = arg('--session-id') ?? arg('--resume')
async function recordRuntimeControl(event: Record<string, unknown>) {
  const path = process.env.FIXTURE_TEAM_RUNTIME_CONTROL_EVENTS
  if (!path) return
  await appendFile(path, JSON.stringify({ timestamp: Date.now(), pid: process.pid, sessionId, agent: arg('--agent-name'), ...event }) + '\n')
}
await recordRuntimeControl({ type: 'process-start', resumed: arg('--resume') ?? null, model: arg('--model') })
const sdk = new WebSocket(arg('--sdk-url')!)
sdk.onmessage = async event => {
  for (const line of String(event.data).trim().split('\n')) {
    const message = JSON.parse(line)
    if (message.type === 'control_request') {
      if (message.request?.subtype === 'team_runtime_resume') {
        await recordRuntimeControl({ type: 'resume-received', request: message.request })
        try {
          const delay = Number(process.env.FIXTURE_TEAM_RUNTIME_RESUME_DELAY_MS ?? 0)
          if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
          const { confirmTeamRuntimeResume } = await import('../../../utils/swarm/teamRuntimeSnapshot.js')
          const { readTeamFile } = await import('../../../utils/swarm/teamHelpers.js')
          // Use the same durable identity/epoch/request check as the real lead.
          const acknowledgement = confirmTeamRuntimeResume(readTeamFile(message.request.team_name), sessionId!, message.request)
          if (process.env.FIXTURE_TEAM_RUNTIME_RESUME_REJECT === '1') throw new Error('Fixture lead refused to release held team mail')
          if (sdk.readyState !== WebSocket.OPEN) continue
          await recordRuntimeControl({ type: 'resume-acknowledged', request: message.request, acknowledgement })
          sdk.send(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: acknowledgement } }))
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          await recordRuntimeControl({ type: 'resume-rejected', request: message.request, error: reason })
          if (sdk.readyState === WebSocket.OPEN) sdk.send(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: reason } }))
        }
        continue
      }
      // A member can die while it starts, as a crashing CLI does: a reason on stderr, no answer.
      if (message.request?.subtype === 'set_model' && arg('--agent-name') === process.env.FIXTURE_EXIT_ON_SET_MODEL) {
        process.stderr.write('Error: fixture member could not load its settings\n', () => process.exit(2))
        continue
      }
      if (arg('--agent-name') === 'reader') await new Promise(resolve => setTimeout(resolve, 100))
      if (sdk.readyState !== WebSocket.OPEN) continue
      sdk.send(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } }))
    } else if (message.type === 'user') {
      const content = JSON.stringify(message.message?.content)
      // A member that agrees to shut down tells the lead so, then leaves. The
      // approval is what the real CLI writes for a desktop member, backend included.
      if (content.includes('FIXTURE_APPROVE_SHUTDOWN')) {
        const { writeToMailbox } = await import('../../../utils/teammateMailbox.js')
        const from = arg('--agent-name')!
        await writeToMailbox('team-lead', { from, timestamp: new Date().toISOString(), text: JSON.stringify({ type: 'shutdown_approved', requestId: 'fixture', from, timestamp: new Date().toISOString(), paneId: '', backendType: 'process' }) }, arg('--team-name'))
        sdk.close(); setTimeout(() => process.exit(0), 5); continue
      }
      if (content.includes('FIXTURE_SHUTDOWN')) { sdk.close(); setTimeout(() => process.exit(0), 5); continue }
      // A test can make the lead's model call land late, as it does on a loaded runner.
      if (arg('--agent-name') === 'leader') await new Promise(resolve => setTimeout(resolve, Number(process.env.FIXTURE_LEAD_MODEL_DELAY_MS ?? 0)))
      const url = new URL(process.env.ANTHROPIC_BASE_URL!)
      if (url.hostname !== '127.0.0.1') throw new Error('Fixture refuses non-loopback upstream')
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', authorization: process.env.ANTHROPIC_AUTH_TOKEN ?? '' }, body: JSON.stringify({ model: arg('--model'), preset: arg('--agents') ? JSON.parse(arg('--agents')!) : null, presetType: process.env.CC_HAHA_TEAM_WORKER_PRESET_TYPE, presetSource: process.env.CC_HAHA_TEAM_WORKER_PRESET_SOURCE, omitClaudeMd: process.env.CC_HAHA_TEAM_WORKER_OMIT_CLAUDE_MD, subagentOverride: process.env.CLAUDE_CODE_SUBAGENT_MODEL, resumed: arg('--resume') ?? null, agent: arg('--agent-name') ?? null, prompt: message.message?.content }) })
      const text = await response.text()
      if (!args.includes('--no-session-persistence')) {
        const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', sanitizePath(process.cwd()))
        await mkdir(dir, { recursive: true })
        await appendFile(join(dir, `${sessionId}.jsonl`), JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId, cwd: process.cwd(), teamName: arg('--team-name'), agentName: arg('--agent-name'), entrypoint: process.env.CC_HAHA_TRANSCRIPT_ENTRYPOINT, message: { role: 'assistant', content: [{ type: 'text', text }], model: arg('--model') } }) + '\n')
      }
      // The upstream fixture decides how the turn ends, like a real provider.
      if (text.startsWith('FIXTURE_CRASH')) { sdk.close(); setTimeout(() => process.exit(1), 5); continue }
      if (text.startsWith('FIXTURE_ERROR:')) {
        sdk.send(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: text.slice('FIXTURE_ERROR:'.length) }))
        continue
      }
      sdk.send(JSON.stringify({ type: 'result', subtype: 'success', result: text }))
    }
  }
}
