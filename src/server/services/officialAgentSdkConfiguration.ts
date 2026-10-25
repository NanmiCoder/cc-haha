import { isAbsolute, join } from 'node:path'
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { HOOK_EVENTS, type Options, type Settings } from '@anthropic-ai/claude-agent-sdk/core'

export type OfficialAgentSdkLaunchOptions = Pick<Options,
  'agent' | 'agents' | 'tools' | 'disallowedTools' | 'maxTurns' | 'additionalDirectories' | 'plugins'> & {
  appendSystemPrompt?: string
  agentProfile?: 'standard' | 'lean'
  agentHooks?: Settings['hooks']
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0)
}

/** Only the host's documented launch options cross this boundary, never arbitrary settings or credentials. */
export function parseOfficialAgentSdkLaunchOptions(value: string | undefined): OfficialAgentSdkLaunchOptions {
  if (value === undefined) return {}
  const parsed: unknown = JSON.parse(value)
  const keys = new Set(['agent', 'agents', 'tools', 'disallowedTools', 'maxTurns', 'additionalDirectories', 'plugins', 'appendSystemPrompt', 'agentProfile', 'agentHooks'])
  if (!record(parsed) || Object.keys(parsed).some(key => !keys.has(key))) throw new Error('Invalid official Agent SDK launch options')
  if (parsed.agentProfile !== undefined && !['standard', 'lean'].includes(String(parsed.agentProfile))) throw new Error('Invalid SDK agent profile')
  if (parsed.agentProfile === 'lean' && (parsed.agent || parsed.agents)) throw new Error('Lean sessions do not support agent definitions')
  for (const key of ['agent', 'appendSystemPrompt']) {
    if (parsed[key] !== undefined && typeof parsed[key] !== 'string') throw new Error(`Invalid SDK ${key}`)
  }
  for (const key of ['disallowedTools', 'additionalDirectories']) {
    if (parsed[key] !== undefined && !strings(parsed[key])) throw new Error(`Invalid SDK ${key}`)
  }
  if (strings(parsed.additionalDirectories) && parsed.additionalDirectories.some(path => !isAbsolute(path))) throw new Error('SDK additional directories must be absolute')
  if (parsed.tools !== undefined && !strings(parsed.tools) &&
    !(record(parsed.tools) && parsed.tools.type === 'preset' && parsed.tools.preset === 'claude_code' && Object.keys(parsed.tools).length === 2)) {
    throw new Error('Invalid SDK tools')
  }
  if (parsed.maxTurns !== undefined && (!Number.isInteger(parsed.maxTurns) || Number(parsed.maxTurns) < 1)) throw new Error('Invalid SDK maxTurns')
  if (parsed.agents !== undefined) {
    const agentKeys = new Set(['description', 'prompt', 'model', 'tools', 'disallowedTools', 'skills', 'maxTurns', 'background', 'memory', 'effort', 'permissionMode', 'omitClaudeMd', 'mcpServers'])
    if (!record(parsed.agents)) throw new Error('Invalid SDK agents')
    for (const [name, agent] of Object.entries(parsed.agents)) {
      if (!name || !record(agent) || Object.keys(agent).some(key => !agentKeys.has(key)) ||
        typeof agent.description !== 'string' || typeof agent.prompt !== 'string') throw new Error('Invalid SDK agent definition')
      if (agent.model !== undefined && typeof agent.model !== 'string') throw new Error('Invalid SDK agent model')
      for (const key of ['tools', 'disallowedTools', 'skills']) if (agent[key] !== undefined && !strings(agent[key])) throw new Error(`Invalid SDK agent ${key}`)
      if (agent.maxTurns !== undefined && (!Number.isInteger(agent.maxTurns) || Number(agent.maxTurns) < 1)) throw new Error('Invalid SDK agent maxTurns')
      if (agent.omitClaudeMd !== undefined && typeof agent.omitClaudeMd !== 'boolean') throw new Error('Invalid SDK agent omitClaudeMd')
      if (agent.permissionMode !== undefined && !['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'].includes(String(agent.permissionMode))) throw new Error('Invalid SDK agent permission mode')
      if (agent.mcpServers !== undefined && (!Array.isArray(agent.mcpServers) || !agent.mcpServers.every(server => typeof server === 'string' || (record(server) && Object.values(server).every(record))))) throw new Error('Invalid SDK agent MCP servers')
      if (agent.background !== undefined && typeof agent.background !== 'boolean') throw new Error('Invalid SDK agent background')
      if (agent.memory !== undefined && !['user', 'project', 'local'].includes(String(agent.memory))) throw new Error('Invalid SDK agent memory')
      if (agent.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(String(agent.effort)) &&
        !(Number.isInteger(agent.effort) && Number(agent.effort) >= 0)) throw new Error('Invalid SDK agent effort')
    }
  }
  if (parsed.plugins !== undefined && (!Array.isArray(parsed.plugins) || !parsed.plugins.every(plugin =>
    record(plugin) && plugin.type === 'local' && typeof plugin.path === 'string' && isAbsolute(plugin.path) &&
    Object.keys(plugin).every(key => ['type', 'path', 'skipMcpDiscovery'].includes(key)) &&
    (plugin.skipMcpDiscovery === undefined || typeof plugin.skipMcpDiscovery === 'boolean')))) throw new Error('Invalid SDK plugins')
  if (parsed.agentHooks !== undefined) validateAgentHooks(parsed.agentHooks)
  return parsed as OfficialAgentSdkLaunchOptions
}

function validateAgentHooks(value: unknown): void {
  if (!record(value)) throw new Error('Invalid SDK agent hooks')
  const hookKeys: Record<string, string[]> = {
    command: ['command', 'args', 'shell', 'onFailure', 'async', 'asyncRewake'],
    prompt: ['prompt', 'model', 'continueOnBlock'], agent: ['prompt', 'model'],
    http: ['url', 'headers', 'allowedEnvVars', 'onFailure'], mcp_tool: ['server', 'tool', 'input'],
  }
  for (const [event, matchers] of Object.entries(value)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event) || !Array.isArray(matchers)) throw new Error('Invalid SDK agent hook event')
    for (const matcher of matchers) {
      if (!record(matcher) || Object.keys(matcher).some(key => !['matcher', 'hooks'].includes(key)) ||
        (matcher.matcher !== undefined && typeof matcher.matcher !== 'string') || !Array.isArray(matcher.hooks)) throw new Error('Invalid SDK agent hook matcher')
      for (const hook of matcher.hooks) {
        if (!record(hook) || typeof hook.type !== 'string' || !hookKeys[hook.type]) throw new Error('Invalid SDK agent hook type')
        const keys = new Set(['type', 'if', 'timeout', 'statusMessage', 'once', ...hookKeys[hook.type]!])
        if (Object.keys(hook).some(key => !keys.has(key))) throw new Error('Unsupported SDK agent hook field')
        for (const key of ['command', 'prompt', 'url', 'server', 'tool'].filter(key => hookKeys[hook.type as string]!.includes(key))) {
          if (typeof hook[key] !== 'string' || !hook[key]) throw new Error(`Invalid SDK agent hook ${key}`)
        }
        for (const key of ['if', 'statusMessage', 'model']) if (hook[key] !== undefined && typeof hook[key] !== 'string') throw new Error(`Invalid SDK agent hook ${key}`)
        for (const key of ['once', 'async', 'asyncRewake', 'continueOnBlock']) if (hook[key] !== undefined && typeof hook[key] !== 'boolean') throw new Error(`Invalid SDK agent hook ${key}`)
        for (const key of ['args', 'allowedEnvVars']) if (hook[key] !== undefined && !strings(hook[key])) throw new Error(`Invalid SDK agent hook ${key}`)
        if (hook.timeout !== undefined && (typeof hook.timeout !== 'number' || !Number.isFinite(hook.timeout) || hook.timeout < 0)) throw new Error('Invalid SDK agent hook timeout')
        if (hook.shell !== undefined && !['bash', 'powershell'].includes(String(hook.shell))) throw new Error('Invalid SDK agent hook shell')
        if (hook.onFailure !== undefined && !['continue', 'block'].includes(String(hook.onFailure))) throw new Error('Invalid SDK agent hook failure policy')
        if (hook.headers !== undefined && (!record(hook.headers) || Object.values(hook.headers).some(value => typeof value !== 'string'))) throw new Error('Invalid SDK agent hook headers')
        if (hook.input !== undefined && !record(hook.input)) throw new Error('Invalid SDK agent hook input')
      }
    }
  }
}

/**
 * Load native project/user features while pinning the provider chosen in cc-haha.
 * Flag settings override user-controlled settings; managed policy remains above
 * this layer. No files are rewritten and unrelated hook/MCP environment survives.
 */
export function officialAgentSdkProviderSettings(env: NodeJS.ProcessEnv): NonNullable<Exclude<Options['settings'], string>> {
  const keys = [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE',
    'ENABLE_TOOL_SEARCH',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'API_TIMEOUT_MS', 'CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS',
    'CLAUDE_STREAM_MAX_DURATION_MS', 'CLAUDE_STREAM_TOOL_INPUT_MAX_DURATION_MS',
  ]
  return {
    env: Object.fromEntries(keys.map(key => [key, env[key] ?? ''])),
    apiKeyHelper: '',
  }
}

/** The SDK serializes inline settings into argv. Keep credentials in a private file instead. */
export function createOfficialAgentSdkSettingsFile(settings: Settings): { path: string; updateEnv(env: Record<string, string>): void; close(): void } {
  const directory = mkdtempSync(join(tmpdir(), 'cc-haha-sdk-settings-'))
  const path = join(directory, 'settings.json')
  let closed = false
  let current = settings
  const updateEnv = (env: Record<string, string>) => {
    if (closed) throw new Error('Official SDK settings have closed')
    const next = { ...current, env: { ...current.env, ...env } }
    const temporary = join(directory, `${crypto.randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, path)
      current = next
    } finally { rmSync(temporary, { force: true }) }
  }
  const close = () => {
    if (closed) return
    closed = true
    process.off('exit', close)
    rmSync(directory, { recursive: true, force: true })
  }
  try {
    chmodSync(directory, 0o700)
    writeFileSync(path, JSON.stringify(settings), { mode: 0o600, flag: 'wx' })
    process.once('exit', close)
    return { path, updateEnv, close }
  } catch (error) {
    close()
    throw error
  }
}
