import * as fs from 'node:fs'
import * as path from 'node:path'
import type { SavedProvider } from '../types/provider.js'
import { getAgentSdkProviderError } from '../../shared/providerRuntime.js'
import { resolveBundledCliPathFromExecPath } from '../../utils/desktopBundledCli.js'

export type ConversationRuntime = 'claude-code' | 'agent-sdk'

export function resolveOfficialAgentSdkModel(provider: SavedProvider, selected?: string): string {
  const model = selected?.trim() || provider.models.main.trim()
  if (/\[1m\]$/i.test(model)) return model
  const supports1m = (['main', 'fable', 'haiku', 'sonnet', 'opus'] as const)
    .some(slot => provider.models[slot]?.trim() === model && provider.model1mSupport?.[slot])
  return supports1m ? `${model}[1m]` : model
}

function markerPath(configDir: string, sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session identifier')
  return path.join(configDir, 'cc-haha', 'session-runtimes', `${sessionId}.json`)
}

// Missing markers are the forward migration for all pre-SDK sessions. Never
// reinterpret an existing CLI transcript as an SDK session after a provider edit.
export function readConversationRuntime(configDir: string, sessionId: string): ConversationRuntime {
  const file = markerPath(configDir, sessionId)
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (record.version !== 1 || record.runtime !== 'agent-sdk') {
      throw new Error('Unsupported session runtime marker')
    }
    return 'agent-sdk'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'claude-code'
    throw error
  }
}

export function markAgentSdkSession(configDir: string, sessionId: string): void {
  const file = markerPath(configDir, sessionId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, runtime: 'agent-sdk' }) + '\n', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (readConversationRuntime(configDir, sessionId) !== 'agent-sdk') throw error
  }
}

export function assertConversationRuntime(input: {
  requested: ConversationRuntime
  recorded: ConversationRuntime
  hasMessages: boolean
  sideChat?: boolean
  teamWorker?: boolean
  lean?: boolean
}): void {
  if (input.recorded === 'agent-sdk' && input.requested !== 'agent-sdk') {
    throw new Error('This conversation uses the official Agent SDK. Select an Agent SDK provider, or start a new conversation.')
  }
  if (input.requested !== 'agent-sdk') return
  if (input.hasMessages && input.recorded !== 'agent-sdk') {
    throw new Error('Existing Claude Code conversations cannot switch to Agent SDK. Start a new conversation with the Agent SDK provider.')
  }
}

export function buildOfficialAgentSdkEnvironment(
  inherited: NodeJS.ProcessEnv,
  provider: SavedProvider,
  configDir: string,
): Record<string, string> {
  const invalid = getAgentSdkProviderError(provider)
  if (invalid) throw new Error(invalid)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && !/^(?:ANTHROPIC_|CLAUDE_|CLAUDECODE$|CC_HAHA_|ENABLE_TOOL_SEARCH$)/.test(key)) env[key] = value
  }
  // User-requested reasoning and workflow opt-outs are behavior controls, not
  // credentials or CLI identity. Keep their native environment precedence.
  for (const key of ['CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_DISABLE_WORKFLOWS']) {
    if (inherited[key] !== undefined) env[key] = inherited[key]!
  }
  // These are documented API-key/SDK options, not the fork's CLI identity,
  // OAuth tokens, system prompt billing line or internal permission switches.
  env.CLAUDE_CONFIG_DIR = configDir
  env.ANTHROPIC_API_KEY = provider.apiKey
  env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
  env.ENABLE_TOOL_SEARCH = provider.toolSearchEnabled === true ? 'true' : 'false'
  for (const slot of ['main', 'fable', 'haiku', 'sonnet', 'opus'] as const) {
    const model = provider.models[slot]?.trim()
    if (!model) continue
    const key = slot === 'main' ? 'ANTHROPIC_MODEL' : `ANTHROPIC_DEFAULT_${slot.toUpperCase()}_MODEL`
    env[key] = provider.model1mSupport?.[slot] && !/\[1m\]$/i.test(model) ? `${model}[1m]` : model
  }
  if (inherited.CC_HAHA_AGENT_SDK_EXECUTABLE) env.CC_HAHA_AGENT_SDK_EXECUTABLE = inherited.CC_HAHA_AGENT_SDK_EXECUTABLE
  return env
}

export function buildOfficialAgentSdkLaunchArgs(
  args: string[],
  options: { execPath?: string; appRoot?: string } = {},
): string[] {
  const execPath = options.execPath ?? process.execPath
  const bundled = resolveBundledCliPathFromExecPath(execPath)
  if (bundled && path.basename(bundled).startsWith('claude-sidecar')) {
    return [bundled, 'agent-sdk', ...(options.appRoot ? ['--app-root', options.appRoot] : []), ...args]
  }
  if (!/^bun(?:\.exe)?$/.test(path.basename(execPath))) {
    throw new Error('Official Agent SDK requires a current cc-haha sidecar build. Rebuild the desktop application first.')
  }
  return [execPath, '--no-env-file',
    `--config=${path.resolve(import.meta.dir, '../../entrypoints/officialAgentSdk.bunfig.toml')}`,
    path.resolve(import.meta.dir, '../../entrypoints/officialAgentSdk.ts'), ...args]
}
