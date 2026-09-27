import { mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sanitizePath } from '../../../utils/sessionStoragePortable.js'
// Deterministic worker protocol fixture. Never contacts anything except loopback.
const args = process.argv.slice(2)
const arg = (name: string) => args[args.indexOf(name) + 1]
const sdk = new WebSocket(arg('--sdk-url')!)
sdk.onmessage = async event => {
  for (const line of String(event.data).trim().split('\n')) {
    const message = JSON.parse(line)
    if (message.type === 'control_request') {
      if (arg('--agent-name') === 'reader') await new Promise(resolve => setTimeout(resolve, 100))
      if (sdk.readyState !== WebSocket.OPEN) continue
      sdk.send(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } }))
    } else if (message.type === 'user') {
      if (JSON.stringify(message.message?.content).includes('FIXTURE_SHUTDOWN')) { sdk.close(); setTimeout(() => process.exit(0), 5); continue }
      const url = new URL(process.env.ANTHROPIC_BASE_URL!)
      if (url.hostname !== '127.0.0.1') throw new Error('Fixture refuses non-loopback upstream')
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', authorization: process.env.ANTHROPIC_AUTH_TOKEN ?? '' }, body: JSON.stringify({ model: arg('--model'), preset: JSON.parse(arg('--agents')!), presetType: process.env.CC_HAHA_TEAM_WORKER_PRESET_TYPE, presetSource: process.env.CC_HAHA_TEAM_WORKER_PRESET_SOURCE, omitClaudeMd: process.env.CC_HAHA_TEAM_WORKER_OMIT_CLAUDE_MD, subagentOverride: process.env.CLAUDE_CODE_SUBAGENT_MODEL }) })
      const text = await response.text()
      if (!args.includes('--no-session-persistence')) {
        const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', sanitizePath(process.cwd()))
        await mkdir(dir, { recursive: true })
        await appendFile(join(dir, `${arg('--session-id')}.jsonl`), JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: arg('--session-id'), cwd: process.cwd(), teamName: arg('--team-name'), agentName: arg('--agent-name'), entrypoint: process.env.CC_HAHA_TRANSCRIPT_ENTRYPOINT, message: { role: 'assistant', content: [{ type: 'text', text }], model: arg('--model') } }) + '\n')
      }
      sdk.send(JSON.stringify({ type: 'result', subtype: 'success', result: text }))
    }
  }
}
