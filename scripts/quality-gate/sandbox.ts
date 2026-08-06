import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../pr/test-environment'

/**
 * Quality-gate sandboxing for lanes that boot the real product server.
 *
 * Baseline cases, desktop smoke, and provider smoke all spawn `src/server/index.ts`.
 * Every one of those code paths resolves user state through
 * `process.env.CLAUDE_CONFIG_DIR || homedir()/.claude`, so inheriting the parent
 * environment makes a QA run read *and write* the developer's real transcripts,
 * session index, diagnostics, and `settings.json`. This module gives those lanes a
 * throwaway HOME while still letting them exercise a provider the user actually
 * configured: provider state is *copied in*, never written back.
 */

/** Files under `<config>/cc-haha/` that carry provider identity and credentials. */
export const SEEDABLE_PROVIDER_STATE_FILES = [
  'providers.json',
  'settings.json',
  'oauth.json',
  'openai-oauth.json',
  'grok-oauth.json',
] as const

/**
 * Environment names a live lane needs even though `createSandboxedTestEnvironment`
 * strips everything outside its safe list: proxy reachability for users behind a
 * corporate gateway, and the env-only provider target used by provider smoke.
 */
export const LIVE_PASSTHROUGH_ENV_NAMES = [
  'ALL_PROXY',
  'all_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'QUALITY_GATE_PROVIDER_API_FORMAT',
  'QUALITY_GATE_PROVIDER_API_KEY',
  'QUALITY_GATE_PROVIDER_AUTH_STRATEGY',
  'QUALITY_GATE_PROVIDER_BASE_URL',
  'QUALITY_GATE_PROVIDER_MODEL',
  'CC_HAHA_SYSTEM_PROXY_URL',
] as const

export type UserStateFingerprint = Record<string, string>

export type QualityGateSandbox = {
  home: string
  configDir: string
  env: Record<string, string>
  /** Fingerprint of the real config dir taken before the lane ran. */
  guardedBefore: UserStateFingerprint
  /** Re-reads the real config dir and reports anything the lane mutated. */
  detectUserStateMutations(): string[]
  cleanup(): void
}

export function realUserConfigDir(source: NodeJS.ProcessEnv = process.env) {
  return source.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/**
 * Build the environment for a sandboxed live lane.
 *
 * `createSandboxedTestEnvironment` already redirects HOME, XDG, TEMP, and
 * CLAUDE_CONFIG_DIR; this layer re-adds the handful of names a live provider call
 * genuinely needs and drops `NODE_ENV=test` so the server behaves like production.
 */
export function buildSandboxLaneEnv(
  sandboxHome: string,
  overrides: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const passthrough: Record<string, string> = {}
  for (const name of LIVE_PASSTHROUGH_ENV_NAMES) {
    const value = source[name]
    if (typeof value === 'string' && value.length > 0) {
      passthrough[name] = value
    }
  }

  const env = createSandboxedTestEnvironment(sandboxHome, { ...passthrough, ...overrides }, source)
  if (!('NODE_ENV' in overrides)) {
    delete env.NODE_ENV
  }
  return env
}

/**
 * Copy provider identity and credentials from the developer's real config into a
 * sandbox config dir. Regenerable state (`db/`, `diagnostics/`) is deliberately left
 * behind so a QA run never inherits a stale local index.
 */
export function seedProviderState(
  sourceConfigDir: string,
  sandboxConfigDir: string,
  files: readonly string[] = SEEDABLE_PROVIDER_STATE_FILES,
): string[] {
  const sourceDir = join(sourceConfigDir, 'cc-haha')
  const targetDir = join(sandboxConfigDir, 'cc-haha')
  if (!existsSync(sourceDir)) {
    return []
  }

  mkdirSync(targetDir, { recursive: true })
  const copied: string[] = []
  for (const file of files) {
    const sourcePath = join(sourceDir, file)
    if (!existsSync(sourcePath)) continue
    cpSync(sourcePath, join(targetDir, file))
    copied.push(file)
  }
  return copied
}

/**
 * Config-relative files a quality-gate lane must never write.
 *
 * Deliberately narrow. A full walk of `~/.claude` would also pick up writes from
 * the developer's own concurrently running Claude Code session (`projects/`,
 * `file-history/`, `plugins/`), turning the guard into noise. These paths are only
 * written by an explicit settings or provider mutation, which is exactly the class
 * of leak this guard exists to catch. Transcript isolation is proved positively
 * instead — see `sandboxTranscriptEvidence`.
 */
export const GUARDED_USER_STATE_PATHS = [
  'settings.json',
  'cc-haha/providers.json',
  'cc-haha/settings.json',
  'cc-haha/oauth.json',
  'cc-haha/openai-oauth.json',
  'cc-haha/grok-oauth.json',
] as const

/**
 * Snapshot the guarded slice of the developer's real config directory so a lane can
 * prove it did not write to it. Size + mtime is enough: every write through the
 * product code path rewrites the whole file.
 */
export function fingerprintUserState(
  configDir: string,
  guardedPaths: readonly string[] = GUARDED_USER_STATE_PATHS,
): UserStateFingerprint {
  const fingerprint: UserStateFingerprint = {}
  for (const guardedPath of guardedPaths) {
    const fullPath = join(configDir, ...guardedPath.split('/'))
    try {
      const stat = statSync(fullPath)
      if (!stat.isFile()) continue
      fingerprint[guardedPath] = `${stat.size}:${stat.mtimeMs}`
    } catch {
      // Absent files stay absent from the fingerprint; creation is reported as a mutation.
    }
  }
  return fingerprint
}

/**
 * Positive evidence that session transcripts landed inside the sandbox rather than
 * the developer's real config directory.
 */
export function sandboxTranscriptEvidence(sandboxConfigDir: string): {
  projectDirs: string[]
  transcriptFiles: number
} {
  const projectsRoot = join(sandboxConfigDir, 'projects')
  if (!existsSync(projectsRoot)) {
    return { projectDirs: [], transcriptFiles: 0 }
  }

  const projectDirs: string[] = []
  let transcriptFiles = 0
  for (const entry of readdirSync(projectsRoot)) {
    const projectDir = join(projectsRoot, entry)
    try {
      if (!statSync(projectDir).isDirectory()) continue
    } catch {
      continue
    }
    projectDirs.push(entry)
    for (const file of readdirSync(projectDir)) {
      if (file.endsWith('.jsonl')) transcriptFiles += 1
    }
  }
  return { projectDirs: projectDirs.sort(), transcriptFiles }
}

export function describeUserStateMutations(
  before: UserStateFingerprint,
  after: UserStateFingerprint,
): string[] {
  const mutations: string[] = []
  for (const [path, signature] of Object.entries(before)) {
    if (!(path in after)) {
      mutations.push(`deleted: ${path}`)
      continue
    }
    if (after[path] !== signature) {
      mutations.push(`modified: ${path}`)
    }
  }
  for (const path of Object.keys(after)) {
    if (!(path in before)) {
      mutations.push(`created: ${path}`)
    }
  }
  return mutations.sort()
}

/**
 * Attach sandbox evidence to a lane result and fail the lane if it wrote to the
 * developer's real config. A leak is a gate failure, not a warning: the whole point
 * of the sandbox is that a QA run leaves user state untouched.
 */
export function applyUserStateGuard<T extends { status: string; error?: string }>(
  result: T,
  sandbox: Pick<QualityGateSandbox, 'configDir' | 'detectUserStateMutations'>,
  artifactDir: string,
): T {
  const mutations = sandbox.detectUserStateMutations()
  const transcripts = sandboxTranscriptEvidence(sandbox.configDir)
  writeFileSync(
    join(artifactDir, 'user-state-guard.json'),
    JSON.stringify({
      sandboxConfigDir: sandbox.configDir,
      guardedPaths: GUARDED_USER_STATE_PATHS,
      realConfigMutations: mutations,
      sandboxTranscripts: transcripts,
    }, null, 2) + '\n',
  )

  if (mutations.length === 0) {
    return result
  }

  const message = `quality gate wrote to the developer's real config: ${mutations.join(', ')}`
  return {
    ...result,
    status: 'failed',
    error: result.error ? `${result.error}; ${message}` : message,
  }
}

export function createQualityGateSandbox(options: {
  label: string
  seedProviders?: boolean
  sourceConfigDir?: string
  envOverrides?: Record<string, string>
  source?: NodeJS.ProcessEnv
}): QualityGateSandbox {
  const source = options.source ?? process.env
  const sourceConfigDir = options.sourceConfigDir ?? realUserConfigDir(source)
  const home = mkdtempSync(join(tmpdir(), `cc-haha-qa-${options.label}-`))
  const env = buildSandboxLaneEnv(home, options.envOverrides ?? {}, source)
  const configDir = env.CLAUDE_CONFIG_DIR
  mkdirSync(configDir, { recursive: true })

  if (options.seedProviders) {
    seedProviderState(sourceConfigDir, configDir)
  }

  const guardedBefore = fingerprintUserState(sourceConfigDir)

  return {
    home,
    configDir,
    env,
    guardedBefore,
    detectUserStateMutations() {
      return describeUserStateMutations(guardedBefore, fingerprintUserState(sourceConfigDir))
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true })
    },
  }
}
