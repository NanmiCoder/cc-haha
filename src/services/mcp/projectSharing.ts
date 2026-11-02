import { createHash } from 'crypto'
import { dirname, join } from 'path'
import { getGlobalConfig, refreshGlobalConfigFromDisk, saveGlobalConfig } from '../../utils/config.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getProjectMcpDirectoryIdentity,
  findProjectMcpRegistryKey,
  readProjectMcpJsonSnapshot,
  resolveProjectMcpDirectory,
  resolveProjectMcpDirectorySync,
  validateMcpConfigForWrite,
  withProjectMcpConfigLock,
  writeMcpjsonFile,
} from './config.js'
import { type McpServerConfig, McpServerConfigSchema } from './types.js'

export type ProjectMcpSelection = {
  projectPath: string
  requestedPath?: string
  revision: string | null
  selected: boolean
  conflict?: boolean
  error?: string
  configHash?: string
}

export type ProjectMcpSelectionTarget = {
  projectPath: string
  selected: boolean
  expectedRevision: string | null
}

export type ProjectMcpSelectionResult = {
  projectPath: string
  selected: boolean
  success: boolean
  revision?: string | null
  persisted?: boolean
  error?: string
  configHash?: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stableConfig(value: unknown): string {
  return jsonStringify(value, (_key, entry: unknown) => isRecord(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))
    : entry)
}

function hashRawConfig(value: unknown): string {
  return createHash('sha256').update(stableConfig(value)).digest('hex')
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  // Do not expose system errors, raw JSON or server credentials to the UI.
  return [
    'Project path must be an absolute directory path',
    'Project directory is unavailable',
    'Project directory identity could not be verified',
    'Project directory identity changed',
    'Cannot read project .mcp.json',
    'Project .mcp.json must contain a valid JSON object',
    'Project .mcp.json mcpServers must be an object',
    'Project .mcp.json changed; reload the project list and retry',
    'A different MCP server already uses this name in the project',
    'Project MCP server configuration is invalid',
    'Project MCP configuration lock was lost',
    'STDIO MCP executable is unavailable in this project; check command, PATH and executable permissions',
  ].includes(message) ? message : 'Could not update project MCP configuration'
}

async function readSource(name: string, sourceCwd: string | undefined) {
  if (!sourceCwd) return undefined
  const projectPath = await resolveProjectMcpDirectory(sourceCwd)
  const snapshot = readProjectMcpJsonSnapshot(join(projectPath, '.mcp.json'))
  const raw = snapshot.servers[name]
  if (!Object.hasOwn(snapshot.servers, name)) return { projectPath }
  const parsed = McpServerConfigSchema().safeParse(raw)
  if (!parsed.success || !isRecord(raw)) throw new Error('Project MCP server configuration is invalid')
  return { projectPath, raw, config: parsed.data }
}

/** Declarative file membership, deliberately separate from runtime scope precedence. */
export async function listProjectMcpSelections(
  name: string,
  projectPaths: string[],
  sourceCwd?: string,
  configHashes?: string[],
): Promise<{ projects: ProjectMcpSelection[]; config?: McpServerConfig; sourceConfig?: Record<string, unknown> }> {
  refreshGlobalConfigFromDisk()
  const candidates = [...projectPaths, ...Object.keys(getGlobalConfig().projects ?? {}), ...(sourceCwd ? [sourceCwd] : [])]
  let source: Awaited<ReturnType<typeof readSource>>
  try {
    source = await readSource(name, sourceCwd)
  } catch {
    // The source's own project row reports the precise read/parse error below.
  }
  // Reloads keep the editor's original and successfully saved fingerprints.
  // Today's source file must not silently add a replacement to that membership.
  const membership = new Set(configHashes ?? (source?.raw ? [hashRawConfig(source.raw)] : []))
  const seen = new Set<string>()
  const projects: ProjectMcpSelection[] = []
  for (const candidate of candidates) {
    let projectPath = candidate
    try {
      projectPath = await resolveProjectMcpDirectory(candidate)
      const identity = getProjectMcpDirectoryIdentity(projectPath)
      if (seen.has(identity)) continue
      seen.add(identity)
      const snapshot = readProjectMcpJsonSnapshot(join(projectPath, '.mcp.json'))
      const exists = Object.hasOwn(snapshot.servers, name)
      const configHash = exists ? hashRawConfig(snapshot.servers[name]) : undefined
      const selected = configHash !== undefined && membership.has(configHash)
      const isSource = sourceCwd && getProjectMcpDirectoryIdentity(source?.projectPath ?? sourceCwd) === identity
      const invalidSource = configHashes === undefined && isSource && (!source?.config || !exists)
      projects.push({
        projectPath,
        ...(candidate !== projectPath ? { requestedPath: candidate } : {}),
        revision: snapshot.revision,
        selected,
        ...(configHash ? { configHash } : {}),
        ...(exists && !selected ? { conflict: true } : {}),
        ...(invalidSource ? { error: 'Project MCP server configuration is missing or invalid' } : {}),
      })
    } catch (error) {
      const identity = getProjectMcpDirectoryIdentity(projectPath)
      if (!seen.has(identity)) seen.add(identity)
      else if (projects.some(project => getProjectMcpDirectoryIdentity(project.projectPath) === identity)) continue
      projects.push({ projectPath, ...(candidate !== projectPath ? { requestedPath: candidate } : {}), revision: null, selected: false, error: describeError(error) })
    }
  }
  return { projects, ...(source?.config ? { config: source.config, sourceConfig: source.raw } : {}) }
}

/** Editable fields change together; extension fields and unexposed OAuth fields survive. */
function mergeEditableConfig(base: Record<string, unknown> | undefined, config: McpServerConfig): Record<string, unknown> {
  const merged = { ...base }
  for (const key of ['type', 'command', 'args', 'env', 'url', 'headers', 'headersHelper', 'oauth']) delete merged[key]
  Object.assign(merged, config)
  if (config.type === 'http' || config.type === 'sse') {
    const oauth = isRecord(base?.oauth) ? { ...base.oauth } : {}
    delete oauth.clientId
    delete oauth.callbackPort
    Object.assign(oauth, config.oauth)
    if (Object.keys(oauth).length) merged.oauth = oauth
  }
  return merged
}

function registerTarget(projectPath: string) {
  resolveProjectMcpDirectorySync(projectPath)
  let existingRegistration = false
  saveGlobalConfig(current => {
    const alias = findProjectMcpRegistryKey(projectPath, current.projects ?? {})
    if (alias) {
      existingRegistration = true
      return current
    }
    return {
      ...current,
      projects: {
        ...current.projects,
        [projectPath]: { allowedTools: [], mcpContextUris: [], projectOnboardingSeenCount: 0 },
      },
    }
  })
  if (!existingRegistration && !getGlobalConfig().projects?.[projectPath]) throw new Error('Project discovery registration failed')
}

export async function updateProjectMcpSelections(
  name: string,
  config: McpServerConfig,
  targets: ProjectMcpSelectionTarget[],
  sourceCwd?: string,
  sourceConfig?: unknown,
  preflight?: (config: McpServerConfig, projectPath: string) => Promise<boolean>,
): Promise<ProjectMcpSelectionResult[]> {
  if (!targets.length) return []
  const validated = targets.some(target => target.selected) ? await validateMcpConfigForWrite(name, config) : config
  let sourceRaw: Record<string, unknown> | undefined
  if (sourceConfig !== undefined) {
    if (!isRecord(sourceConfig) || !McpServerConfigSchema().safeParse(sourceConfig).success) {
      throw new Error('Invalid source MCP configuration snapshot')
    }
    sourceRaw = sourceConfig
  } else {
    try {
      sourceRaw = (await readSource(name, sourceCwd))?.raw
    } catch {
      // Legacy callers can still retry without an ephemeral source snapshot.
    }
  }
  const resolved = await Promise.all(targets.map(async target => {
    try {
      return { target, projectPath: await resolveProjectMcpDirectory(target.projectPath) }
    } catch (error) {
      return { target, error: describeError(error) }
    }
  }))
  const counts = new Map<string, number>()
  for (const entry of resolved) {
    if (!entry.projectPath) continue
    const identity = getProjectMcpDirectoryIdentity(entry.projectPath)
    counts.set(identity, (counts.get(identity) ?? 0) + 1)
  }
  const results: ProjectMcpSelectionResult[] = []
  for (const entry of resolved) {
    const { target } = entry
    const projectPath = entry.projectPath ?? target.projectPath
    const result: ProjectMcpSelectionResult = { projectPath, selected: target.selected, success: false }
    if (entry.error || (counts.get(getProjectMcpDirectoryIdentity(projectPath)) ?? 0) > 1) {
      results.push({ ...result, error: entry.error ?? 'Duplicate project target' })
      continue
    }
    let persisted = false
    let registering = false
    let savedConfigHash: string | null | undefined
    try {
      result.revision = await withProjectMcpConfigLock(projectPath, async (file, assertLockHeld) => {
        const snapshot = readProjectMcpJsonSnapshot(file)
        if (snapshot.revision !== target.expectedRevision) {
          throw new Error('Project .mcp.json changed; reload the project list and retry')
        }
        const exists = Object.hasOwn(snapshot.servers, name)
        if (target.selected) {
          const existing = snapshot.servers[name]
          if (exists && !isRecord(existing)) throw new Error('Project MCP server configuration is invalid')
          if (exists && !sourceCwd && sourceConfig === undefined) {
            if (stableConfig(existing) !== stableConfig(validated)) {
              throw new Error('A different MCP server already uses this name in the project')
            }
          }
          if (preflight && !await preflight(validated, dirname(file))) {
            throw new Error('STDIO MCP executable is unavailable in this project; check command, PATH and executable permissions')
          }
          if (exists && !sourceCwd && sourceConfig === undefined) {
            persisted = true
            savedConfigHash = hashRawConfig(existing)
            return snapshot.revision
          }
          snapshot.servers[name] = mergeEditableConfig(isRecord(existing) ? existing : sourceRaw, validated)
          snapshot.config.mcpServers = snapshot.servers
        } else {
          if (!exists) {
            savedConfigHash = null
            return snapshot.revision
          }
          delete snapshot.servers[name]
        }
        await writeMcpjsonFile(snapshot.config, file, { expectedRevision: snapshot.revision, assertLockHeld })
        persisted = true
        const saved = readProjectMcpJsonSnapshot(file)
        savedConfigHash = Object.hasOwn(saved.servers, name) ? hashRawConfig(saved.servers[name]) : null
        return saved.revision
      })
      if (target.selected) {
        registering = true
        registerTarget(projectPath)
      }
      result.success = true
      result.configHash = savedConfigHash
    } catch (error) {
      result.error = persisted
        ? registering
          ? 'MCP configuration was saved, but project discovery registration failed; reload and retry'
          : 'MCP configuration was saved, but finalization failed; reload and retry'
        : describeError(error)
      if (persisted) result.persisted = true
      if (persisted && savedConfigHash !== undefined) result.configHash = savedConfigHash
      if (persisted && result.revision === undefined) {
        try {
          const saved = readProjectMcpJsonSnapshot(join(projectPath, '.mcp.json'))
          result.revision = saved.revision
          result.configHash = Object.hasOwn(saved.servers, name) ? hashRawConfig(saved.servers[name]) : null
        } catch { /* No trustworthy revision is available. */ }
      }
    }
    results.push(result)
  }
  return results
}
