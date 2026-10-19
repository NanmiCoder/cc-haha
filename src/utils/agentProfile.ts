import { type FileHandle, open } from 'fs/promises'
import { resolve } from 'path'
import { isEnvTruthy } from './envUtils.js'
import { exitWithError } from './process.js'
import { LITE_READ_BUF_SIZE } from './sessionStoragePortable.js'

/** Process-local experimental agent configuration. Never persisted to settings. */
export type AgentProfile = 'standard' | 'lean'

export const AGENT_PROFILES = {
  standard: { toolNames: null, mcp: true },
  lean: { toolNames: ['Bash', 'PowerShell', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Skill'], mcp: false },
} as const

export const LEAN_MCP_UNAVAILABLE = '--agent-profile lean does not use MCP servers.'

let agentProfile: AgentProfile = 'standard'

export function getAgentProfile(): AgentProfile {
  return agentProfile
}

export function setAgentProfile(profile: AgentProfile): void {
  agentProfile = profile
}

/** Lean has no MCP runtime: no server is configured, connected or awaited, whatever its source. */
export function isAgentProfileMcpEnabled(): boolean {
  return AGENT_PROFILES[agentProfile].mcp
}

/** Intersect the already-authorized tool pool; never grant tool access. */
export function filterAgentProfileTools<
  T extends { name: string, isMcp?: boolean, mcpInfo?: unknown },
>(tools: readonly T[]): readonly T[] {
  const names = AGENT_PROFILES[agentProfile].toolNames
  return names === null ? tools : tools.filter(tool => !tool.isMcp && !tool.mcpInfo && (names as readonly string[]).includes(tool.name))
}

export function validateAgentProfileOptions(
  options: Record<string, unknown>,
  profile: AgentProfile = agentProfile,
): string | undefined {
  if (profile !== 'lean') return
  if (options.permissionMode === 'plan') return '--agent-profile lean does not support --permission-mode plan.'
  if (!options.print) return '--agent-profile lean requires --print.'
  if (options.resume !== undefined && (typeof options.resume !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.resume))) {
    return '--agent-profile lean requires a UUID for --resume.'
  }
  const conflicts: Record<string, string> = {
    continue: '--continue', forkSession: '--fork-session',
    fromPr: '--from-pr', resumeSessionAt: '--resume-session-at', rewindFiles: '--rewind-files',
    teleport: '--teleport', remote: '--remote', bare: '--bare',
    agent: '--agent (including the agent setting)', agents: '--agents',
    agentId: '--agent-id', agentName: '--agent-name', teamName: '--team-name', agentType: '--agent-type',
    systemPrompt: '--system-prompt', systemPromptFile: '--system-prompt-file',
    jsonSchema: '--json-schema', advisor: '--advisor', chrome: '--chrome',
    mcpConfig: '--mcp-config',
  }
  for (const [key, flag] of Object.entries(conflicts)) {
    if (options[key] !== undefined && options[key] !== false && options[key] !== null) {
      return `--agent-profile lean cannot be combined with ${flag}.`
    }
  }
}

/** SDK initialization must not bypass the CLI's profile contract. */
export function validateAgentProfileInitialize(
  request: { systemPrompt?: unknown, agents?: unknown, jsonSchema?: unknown, sdkMcpServers?: unknown },
): string | undefined {
  if (agentProfile !== 'lean') return
  if (request.systemPrompt !== undefined || request.agents !== undefined || request.jsonSchema !== undefined) {
    return '--agent-profile lean does not support SDK systemPrompt, agents, or jsonSchema overrides.'
  }
  if (Array.isArray(request.sdkMcpServers) && request.sdkMcpServers.length > 0) return LEAN_MCP_UNAVAILABLE
}

/** Out-of-band SDK controls cannot activate capabilities omitted by the profile. */
export function validateAgentProfileControlRequest(
  subtype: string,
  request?: { mode?: unknown, servers?: unknown },
): string | undefined {
  if (agentProfile === 'lean' && subtype === 'set_permission_mode' && request?.mode === 'plan') {
    return '--agent-profile lean does not support plan mode.'
  }
  if (agentProfile === 'lean' && subtype === 'send_agent_message') {
    return '--agent-profile lean does not support SDK send_agent_message or resuming subagents.'
  }
  if (agentProfile === 'lean' && subtype === 'mcp_set_servers' &&
    request?.servers && typeof request.servers === 'object' && Object.keys(request.servers).length > 0) {
    return LEAN_MCP_UNAVAILABLE
  }
}

/** Validate before selecting a profile so rejected startup leaves no partial state. */
export function initializeAgentProfile(
  options: Record<string, unknown> & { agentProfile?: string },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const profile = options.agentProfile ?? 'standard'
  if (profile !== 'standard' && profile !== 'lean') {
    exitWithError('Error: --agent-profile must be standard or lean.')
  }
  const error = validateAgentProfileOptions(options, profile)
  if (error) exitWithError(`Error: ${error}`)
  if (profile === 'lean' && (isEnvTruthy(env.CLAUDE_CODE_SIMPLE) || isEnvTruthy(env.CLAUDE_CODE_COORDINATOR_MODE))) {
    exitWithError('Error: --agent-profile lean cannot be combined with CLAUDE_CODE_SIMPLE or CLAUDE_CODE_COORDINATOR_MODE.')
  }
  setAgentProfile(profile)
}

/** Settings are resolved later than CLI arguments, but obey the same profile contract. */
export function assertAgentProfileSettingCompatible(
  kind: 'agent' | 'advisor',
  value: string | undefined,
): void {
  if (agentProfile !== 'lean' || !value) return
  const guidance = kind === 'agent' ? ' Remove the agent setting or use --agent-profile standard.' : ''
  exitWithError(`Error: --agent-profile lean cannot use an ${kind} selected in settings.${guidance}`)
}

/**
 * Every writer of a lean transcript records the profile within its first records
 * (desktop createSession and /clear on line 2, the CLI first when it materializes
 * the file, branching copies metadata first), and lean re-appends it at EOF on
 * resume, compaction and exit. So the profile lives in the same head/tail windows
 * readLiteMetadata uses, and resume cost stays independent of transcript size.
 */
const PROFILE_WINDOW_BYTES = LITE_READ_BUF_SIZE

async function readRange(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return buffer.subarray(0, filled)
}

/** Whole JSONL records in a window; a record cut by a window edge is never examined. */
function windowRecords(window: Buffer, startsAtRecord: boolean, endsAtEof: boolean): string[] {
  const start = startsAtRecord ? 0 : window.indexOf(0x0a) + 1
  const end = endsAtEof ? window.length : window.lastIndexOf(0x0a)
  // No record starts inside the window, or none ends inside it.
  if ((!startsAtRecord && start === 0) || end < start) return []
  return window.toString('utf8', start, end).split('\n')
}

/** Additive session metadata migration: historical transcripts without this field are standard. */
export async function readSessionAgentProfile(path: string): Promise<AgentProfile> {
  const handle = await open(path, 'r')
  let records: string[]
  try {
    const { size } = await handle.stat()
    if (size <= 2 * PROFILE_WINDOW_BYTES) {
      records = windowRecords(await readRange(handle, 0, size), true, true)
    } else {
      // The byte before the tail window tells whether that window starts on a record.
      records = [
        ...windowRecords(await readRange(handle, 0, PROFILE_WINDOW_BYTES), true, false),
        ...windowRecords(await readRange(handle, size - PROFILE_WINDOW_BYTES - 1, PROFILE_WINDOW_BYTES + 1), false, true),
      ]
    }
  } finally {
    await handle.close()
  }
  let profile: AgentProfile | undefined
  for (const record of records) {
    if (!record.includes('"session-meta"')) continue
    let entry: unknown
    try {
      entry = JSON.parse(record)
    } catch {
      continue // An unparseable record (e.g. an append in progress) never carried a profile.
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const { type, agentProfile: stored } = entry as Record<string, unknown>
    if (type !== 'session-meta' || stored === undefined) continue
    if (stored !== 'standard' && stored !== 'lean') {
      throw new Error('Invalid agent profile in session metadata.')
    }
    if (profile && profile !== stored) {
      throw new Error('Conflicting agent profiles in session metadata.')
    }
    profile = stored
  }
  return profile ?? 'standard'
}

// Startup resolution, reused once by the matching load-time assertion so a
// resume reads the transcript's profile windows once rather than twice.
let resolvedSessionProfile: { path: string, profile: AgentProfile } | undefined

export function resetSessionAgentProfileCacheForTesting(): void {
  resolvedSessionProfile = undefined
}

/** Resolve from disk before any tools or prompts are assembled. An explicit flag cannot rewrite history. */
export async function initializeSessionAgentProfile(
  options: Record<string, unknown> & { agentProfile?: string },
): Promise<void> {
  let resolved = options.agentProfile
  resolvedSessionProfile = undefined
  if (typeof options.resume === 'string') {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.resume)
    if (isUuid || options.resume.endsWith('.jsonl')) {
      const { getTranscriptPathForSession } = await import('./sessionStorage.js')
      const path = isUuid ? getTranscriptPathForSession(options.resume) : options.resume
      try {
        const stored = await readSessionAgentProfile(path)
        if (resolved !== undefined && resolved !== stored) {
          exitWithError(`Error: This session uses --agent-profile ${stored}; its profile cannot be changed.`)
        }
        resolved = stored
        resolvedSessionProfile = { path: resolve(path), profile: stored }
      } catch (error) {
        // Preserve the existing missing-session diagnostic; malformed profile metadata must fail closed.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  initializeAgentProfile({ ...options, agentProfile: resolved })
}

/** Recovery paths (picker/continue/remote) may not silently restore lean into a standard runtime. */
export async function assertSessionAgentProfile(path: string): Promise<void> {
  const startup = resolvedSessionProfile
  resolvedSessionProfile = undefined
  const stored = startup?.path === resolve(path) ? startup.profile : await readSessionAgentProfile(path)
  if (stored !== getAgentProfile()) {
    throw new Error(`This session uses --agent-profile ${stored}. Resume it with --print --resume <session-id>; its profile cannot be changed.`)
  }
}

/** Skills load instructions only; they cannot add another runtime or connector. */
export function isLeanCompatibleSkill(command: {
  type: string, context?: string, source?: string, loadedFrom?: string,
}): boolean {
  return command.type === 'prompt' && command.context !== 'fork' &&
    command.source !== 'mcp' && command.loadedFrom !== 'mcp' && command.source !== 'builtin'
}

/** Local commands must not activate runtimes or tools omitted by lean. */
const leanLocalCommands = new Set(['clear', 'compact', 'cost', 'context', 'help', 'model', 'permissions', 'status'])

export function isAgentProfileCommandSupported(command: {
  name: string, type: string, context?: string, source?: string, loadedFrom?: string,
}): boolean {
  if (agentProfile !== 'lean') return true
  return command.type === 'prompt'
    ? isLeanCompatibleSkill(command)
    : leanLocalCommands.has(command.name)
}
