import { existsSync } from 'node:fs'
import path from 'node:path'

/** Source launches use the SDK's own dependency resolver; compiled launches
 * must use the official runtime staged next to this sidecar, outside Bunfs. */
export function resolveBundledAgentSdkExecutable(options: {
  moduleUrl?: string
  execPath?: string
  platform?: NodeJS.Platform
} = {}): string | undefined {
  const moduleUrl = options.moduleUrl ?? import.meta.url
  if (!moduleUrl.includes('$bunfs') && !moduleUrl.includes('~BUN')) return undefined
  const binaryName = (options.platform ?? process.platform) === 'win32' ? 'claude.exe' : 'claude'
  const executable = path.join(
    path.dirname(options.execPath ?? process.execPath),
    'official-agent-sdk',
    binaryName,
  )
  if (!existsSync(executable)) {
    throw new Error('The bundled official Agent SDK runtime is missing. Rebuild or reinstall the desktop app.')
  }
  return executable
}
