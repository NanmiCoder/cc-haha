import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import type { AppModeConfig, AppModeSetInput } from '../../src/lib/desktopHost/types'

const APP_MODE_FILE = 'app-mode.json'

export type AppModeAppLike = {
  getPath(name: 'exe' | 'home' | 'userData'): string
}

type PersistedAppModeConfig = {
  mode?: string
  portable_dir?: string | null
}

export function systemClaudeConfigDir(app: AppModeAppLike): string {
  return path.join(app.getPath('home'), '.claude')
}

function readAppModeConfig(configDir: string): PersistedAppModeConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, APP_MODE_FILE), 'utf8')) as PersistedAppModeConfig
    return {
      mode: typeof parsed.mode === 'string' ? parsed.mode.toLowerCase() : 'default',
      portable_dir: typeof parsed.portable_dir === 'string' ? parsed.portable_dir.trim() : null,
    }
  } catch {
    return null
  }
}

function writeAppModeConfig(configDir: string, config: PersistedAppModeConfig): void {
  fs.mkdirSync(configDir, { recursive: true })
  const target = path.join(configDir, APP_MODE_FILE)
  const temporary = path.join(configDir, `.${APP_MODE_FILE}.${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2))
    fs.renameSync(temporary, target)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function assertWritableDataDir(configDir: string): void {
  try {
    fs.mkdirSync(configDir, { recursive: true })
    const probeDir = fs.mkdtempSync(path.join(configDir, '.cc-haha-write-test-'))
    try {
      fs.writeFileSync(path.join(probeDir, 'probe'), '')
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true })
    }
  } catch {
    throw new Error(`Data storage directory is not writable: ${configDir}`)
  }
}

function resolveWithExistingAncestor(inputPath: string): string {
  let existingPath = path.resolve(inputPath)
  const missingSegments: string[] = []
  while (!fs.existsSync(existingPath)) {
    const parent = path.dirname(existingPath)
    if (parent === existingPath) return path.resolve(inputPath)
    missingSegments.unshift(path.basename(existingPath))
    existingPath = parent
  }
  return path.join(fs.realpathSync.native(existingPath), ...missingSegments)
}

function isPathAtOrBelow(parentDir: string, candidateDir: string): boolean {
  const relative = path.relative(
    resolveWithExistingAncestor(parentDir),
    resolveWithExistingAncestor(candidateDir),
  )
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function normalizedCustomDir(app: AppModeAppLike, value: string | null | undefined): string {
  const selectedDir = value?.trim()
  if (!selectedDir) throw new Error('Choose an absolute custom data directory')
  if (!path.isAbsolute(selectedDir)) throw new Error('Custom data storage must use an absolute path')

  const normalized = path.resolve(selectedDir)
  if (isPathAtOrBelow(path.dirname(app.getPath('exe')), normalized)) {
    throw new Error('Custom data storage must stay outside the application install directory')
  }
  return normalized
}

function externallyControlled(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CLAUDE_CONFIG_DIR && env.CC_HAHA_APP_PORTABLE_DIR !== '1')
}

export function determineStartupPortableDir(
  app: AppModeAppLike,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.CLAUDE_CONFIG_DIR) return null

  const config = readAppModeConfig(app.getPath('userData'))
  if (config?.mode !== 'portable' || !config.portable_dir || !path.isAbsolute(config.portable_dir)) return null

  try {
    return normalizedCustomDir(app, config.portable_dir)
  } catch {
    return null
  }
}

export function applyStartupPortableMode(
  app: AppModeAppLike,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // app.relaunch() inherits process.env. Discard the previous app-managed
  // selection so the persisted two-mode record remains authoritative.
  if (env.CC_HAHA_APP_PORTABLE_DIR === '1') {
    delete env.CLAUDE_CONFIG_DIR
    delete env.CC_HAHA_APP_PORTABLE_DIR
    delete env.WEBVIEW2_USER_DATA_FOLDER
  }
  if (env.CLAUDE_CONFIG_DIR) {
    env.CLAUDE_CONFIG_DIR = normalizedCustomDir(app, env.CLAUDE_CONFIG_DIR)
    return null
  }
  const customDir = determineStartupPortableDir(app, env)
  if (!customDir) return null

  const webViewDataDir = path.join(customDir, 'EBWebView')
  fs.mkdirSync(webViewDataDir, { recursive: true })
  env.CLAUDE_CONFIG_DIR = customDir
  env.CC_HAHA_APP_PORTABLE_DIR = '1'
  env.WEBVIEW2_USER_DATA_FOLDER = webViewDataDir
  return customDir
}

export function getAppMode(
  app: AppModeAppLike,
  env: NodeJS.ProcessEnv = process.env,
): AppModeConfig {
  const envConfigDir = env.CLAUDE_CONFIG_DIR
    ? normalizedCustomDir(app, env.CLAUDE_CONFIG_DIR)
    : null
  const persistedCustomDir = envConfigDir ? null : determineStartupPortableDir(app, env)
  const customDir = envConfigDir || persistedCustomDir
  if (customDir) {
    return {
      mode: 'portable',
      portableDir: customDir,
      activeConfigDir: customDir,
      configDirSource: envConfigDir && env.CC_HAHA_APP_PORTABLE_DIR !== '1'
        ? 'environment'
        : 'portable',
    }
  }

  return {
    mode: 'default',
    portableDir: null,
    activeConfigDir: systemClaudeConfigDir(app),
    configDirSource: 'system',
  }
}

export function setAppMode(
  app: AppModeAppLike,
  input: AppModeSetInput,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (externallyControlled(env)) {
    throw new Error('CLAUDE_CONFIG_DIR is controlled by the launch environment')
  }

  if (input.mode === 'default') {
    writeAppModeConfig(app.getPath('userData'), { mode: 'default', portable_dir: null })
    return
  }
  if (input.mode !== 'portable') throw new Error(`Unsupported app mode: ${String(input.mode)}`)

  const selectedDir = normalizedCustomDir(app, input.portableDir)
  if (fs.existsSync(selectedDir) && !fs.statSync(selectedDir).isDirectory()) {
    throw new Error(`Custom data storage path is not a directory: ${selectedDir}`)
  }
  assertWritableDataDir(selectedDir)
  writeAppModeConfig(app.getPath('userData'), {
    mode: 'portable',
    portable_dir: selectedDir,
  })
}
