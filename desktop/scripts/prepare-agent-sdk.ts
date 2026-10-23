import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const TARGET_PACKAGES: Record<string, string> = {
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
  'x86_64-pc-windows-msvc': 'win32-x64',
  'aarch64-pc-windows-msvc': 'win32-arm64',
  'x86_64-unknown-linux-gnu': 'linux-x64',
  'aarch64-unknown-linux-gnu': 'linux-arm64',
  'x86_64-unknown-linux-musl': 'linux-x64-musl',
  'aarch64-unknown-linux-musl': 'linux-arm64-musl',
}

export function getAgentSdkPlatformPackage(targetTriple: string): string {
  const target = TARGET_PACKAGES[targetTriple]
  if (!target) throw new Error(`Unsupported official Agent SDK target: ${targetTriple}`)
  return `@anthropic-ai/claude-agent-sdk-${target}`
}

/**
 * The SDK's JavaScript is compiled into the sidecar, but its official native
 * runtime must remain a real executable. Stage the exact optional dependency
 * declared by the SDK; never substitute a system Claude Code installation.
 * Keeping it outside the Bun filesystem also preserves the vendor signature.
 */
export async function stageAgentSdkRuntime(options: {
  repoRoot: string
  binariesDir: string
  targetTriple: string
}): Promise<string> {
  const require = createRequire(path.join(options.repoRoot, 'package.json'))
  const sdkRoot = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk'))
  const sdk = JSON.parse(await readFile(path.join(sdkRoot, 'package.json'), 'utf8')) as {
    version: string
    optionalDependencies: Record<string, string>
  }
  const packageName = getAgentSdkPlatformPackage(options.targetTriple)
  const expectedVersion = sdk.optionalDependencies[packageName]
  if (!expectedVersion) {
    throw new Error(`Agent SDK ${sdk.version} has no runtime for ${options.targetTriple}`)
  }
  let packagePath: string
  let runtime: { name: string; version: string }
  try {
    packagePath = require.resolve(`${packageName}/package.json`)
    runtime = JSON.parse(await readFile(packagePath, 'utf8')) as typeof runtime
  } catch {
    throw new Error(
      `Missing ${packageName}@${expectedVersion}. Install the official optional dependency for ${options.targetTriple} before building (cross builds require the target platform package).`,
    )
  }
  if (runtime.name !== packageName || runtime.version !== expectedVersion) {
    throw new Error(`Agent SDK runtime mismatch: expected ${packageName}@${expectedVersion}, found ${runtime.name}@${runtime.version}`)
  }
  const runtimeRoot = path.dirname(packagePath)
  const binaryName = options.targetTriple.includes('windows') ? 'claude.exe' : 'claude'
  const destination = path.join(options.binariesDir, 'official-agent-sdk')
  const staging = `${destination}.staging`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    // Include the vendor notices alongside the unmodified native executable.
    for (const file of [binaryName, 'package.json', 'README.md', 'LICENSE.md']) {
      await copyFile(path.join(runtimeRoot, file), path.join(staging, file))
    }
    await copyFile(path.join(sdkRoot, 'README.md'), path.join(staging, 'SDK-README.md'))
    await chmod(path.join(staging, binaryName), 0o755)
    await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify({
      sdkVersion: sdk.version,
      runtimePackage: packageName,
      runtimeVersion: runtime.version,
      targetTriple: options.targetTriple,
    }, null, 2)}\n`)
    await rm(destination, { recursive: true, force: true })
    await rename(staging, destination)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return path.join(destination, binaryName)
}
