import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type AgentDesktopBinaryOptions = {
  platform?: NodeJS.Platform
  arch?: string
  binaryPath?: string
  projectRoot?: string
  appRoot?: string
  resourcesPath?: string
  exists?: (candidate: string) => boolean
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

export function resolveAgentDesktopBinary(options: AgentDesktopBinaryOptions = {}): string | null {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const file = platform === 'win32' ? 'agent-desktop.exe' : 'agent-desktop'
  const appRoot = options.appRoot ?? process.env.CLAUDE_APP_ROOT
  const resources = options.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const exists = options.exists ?? ((candidate: string) => {
    try {
      const info = statSync(candidate)
      if (!info.isFile()) return false
      accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK)
      return true
    } catch {
      return false
    }
  })
  if (options.binaryPath) return exists(options.binaryPath) ? path.resolve(options.binaryPath) : null

  const candidates: string[] = []
  if (appRoot) {
    const unpacked = appRoot.replace(/\.asar(?=$|[/\\])/, '.asar.unpacked')
    candidates.push(path.join(unpacked, 'src-tauri', 'binaries', file))
  }
  if (resources) {
    candidates.push(
      path.join(resources, 'app.asar.unpacked', 'src-tauri', 'binaries', file),
      path.join(resources, 'src-tauri', 'binaries', file),
    )
  }
  if (!appRoot?.includes('.asar')) {
    const root = options.projectRoot ?? projectRoot
    const target = path.join(root, 'native', 'agent-desktop', 'target')
    const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null
    const triple = cpu && (platform === 'win32' ? `${cpu}-pc-windows-msvc`
      : platform === 'linux' ? `${cpu}-unknown-linux-gnu`
        : platform === 'darwin' ? `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin` : null)
    candidates.push(path.join(root, 'desktop', 'src-tauri', 'binaries', file))
    for (const profile of ['release', 'debug']) {
      if (triple) candidates.push(path.join(target, triple, profile, file))
      candidates.push(path.join(target, profile, file))
    }
  }
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return null
}
