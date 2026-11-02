import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const AGENT_DESKTOP_UPSTREAM_COMMIT = '9eb9b296192fcb70bda25e918cd6dd66abfa3d0d'
export const AGENT_DESKTOP_LICENSE_FILES = [
  'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES', 'UPSTREAM.json', 'PATCHES.md',
] as const

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
type BuildProfile = 'debug' | 'release'
type CommandRunner = (args: string[], options: {
  cwd: string
  env: NodeJS.ProcessEnv
}) => Promise<void>

export function nativeAgentDesktopTarget(targetTriple: string): {
  platform: 'win32' | 'linux'
  binaries: string[]
  packages: string[]
} | null {
  if (['aarch64-apple-darwin', 'x86_64-apple-darwin'].includes(targetTriple)) return null
  if (/^(x86_64|aarch64)-pc-windows-msvc$/.test(targetTriple)) {
    return { platform: 'win32', binaries: ['agent-desktop.exe'], packages: ['agent-desktop'] }
  }
  if (/^(x86_64|aarch64)-unknown-linux-(gnu|musl)$/.test(targetTriple)) {
    return {
      platform: 'linux',
      binaries: ['agent-desktop', 'agent-desktop-linux-clipboard-owner'],
      packages: ['agent-desktop', 'agent-desktop-linux'],
    }
  }
  throw new Error(`[native-agent-desktop] Unsupported target triple: ${targetTriple}`)
}

async function runCommand(args: string[], options: {
  cwd: string
  env: NodeJS.ProcessEnv
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { ...options, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`[native-agent-desktop] cargo failed (${signal ?? code})`))
    })
  })
}

export async function stageNativeAgentDesktopLicenses(
  sourceRoot: string,
  binariesDir: string,
): Promise<void> {
  const destination = path.join(binariesDir, 'agent-desktop-licenses')
  await mkdir(destination, { recursive: true })
  await Promise.all(AGENT_DESKTOP_LICENSE_FILES.map(name =>
    copyFile(path.join(sourceRoot, name), path.join(destination, name)),
  ))
}

export async function buildNativeAgentDesktop({
  repoRoot = path.resolve(scriptDirectory, '../..'),
  binariesDir = path.join(repoRoot, 'desktop/src-tauri/binaries'),
  targetTriple,
  profile = 'release',
  env = process.env,
  run = runCommand,
}: {
  repoRoot?: string
  binariesDir?: string
  targetTriple: string
  profile?: BuildProfile
  env?: NodeJS.ProcessEnv
  run?: CommandRunner
}): Promise<string[]> {
  const target = nativeAgentDesktopTarget(targetTriple)
  if (!target) return []

  const sourceRoot = path.join(repoRoot, 'native/agent-desktop')
  const upstream = JSON.parse(await readFile(path.join(sourceRoot, 'UPSTREAM.json'), 'utf8')) as {
    commit?: string
    version?: string
  }
  if (upstream.commit !== AGENT_DESKTOP_UPSTREAM_COMMIT) {
    throw new Error('[native-agent-desktop] Vendored upstream commit does not match the build pin')
  }
  const targetRoot = path.join(sourceRoot, 'target')
  const args = [
    'cargo', '+stable', 'build', '--locked', '--offline',
    '--manifest-path', path.join(sourceRoot, 'Cargo.toml'),
    '--target-dir', targetRoot, '--target', targetTriple,
  ]
  if (profile === 'release') args.push('--release')
  for (const packageName of target.packages) args.push('-p', packageName)
  for (const binary of target.binaries) args.push('--bin', binary.replace(/\.exe$/, ''))
  await run(args, { cwd: sourceRoot, env: { ...env, CARGO_NET_OFFLINE: 'true' } })

  await mkdir(binariesDir, { recursive: true })
  const built = target.binaries.map(name => ({
    source: path.join(targetRoot, targetTriple, profile, name),
    destination: path.join(binariesDir, name),
  }))
  for (const binary of built) {
    if (!(await stat(binary.source)).isFile()) {
      throw new Error(`[native-agent-desktop] Missing executable: ${binary.source}`)
    }
    await copyFile(binary.source, binary.destination)
    await chmod(binary.destination, 0o755)
  }
  await stageNativeAgentDesktopLicenses(sourceRoot, binariesDir)
  await writeFile(path.join(binariesDir, 'agent-desktop-manifest.json'), `${JSON.stringify({
    commit: upstream.commit, version: upstream.version, targetTriple, profile,
    binaries: target.binaries,
  }, null, 2)}\n`)
  console.log(`[native-agent-desktop] Staged ${target.binaries.join(', ')} for ${targetTriple}`)
  return built.map(binary => binary.destination)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const targetIndex = args.indexOf('--target-triple')
  const targetTriple = targetIndex >= 0 ? args[targetIndex + 1] : process.env.SIDECAR_TARGET_TRIPLE
  if (!targetTriple) throw new Error('[native-agent-desktop] Pass --target-triple or set SIDECAR_TARGET_TRIPLE')
  await buildNativeAgentDesktop({ targetTriple, profile: args.includes('--debug') ? 'debug' : 'release' })
}
