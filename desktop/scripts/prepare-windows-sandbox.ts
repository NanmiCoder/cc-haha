import { createHash } from 'node:crypto'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const CODEX_WINDOWS_SANDBOX_VERSION = '0.145.0'
export const CODEX_WINDOWS_X64_INTEGRITY =
  'sha512-u0h9lk094CaXRSqE34SBW2dRaQTPa6fASXqehczWH9QdsU62mBsiAgAdp6tCG4i+YzPmmhjD8FdXNnYGNmwuMg=='
export const CODEX_WINDOWS_ARM64_INTEGRITY =
  'sha512-sub61rjEFevi1i3Zx7nAd4JM5XxoNFqMqFc5LfTo2xSI8ixHjFvEYDFDXwXOftT04n3Ht1Wh271ioUZpDiEjEg=='

const PACKAGE_NAME = '@openai/codex'
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const licensePath = path.join(
  scriptDirectory,
  'codex-windows-sandbox-licenses',
  'LICENSE',
)

const requiredSourceFiles = [
  'codex.exe',
  'codex-windows-sandbox-setup.exe',
  'codex-command-runner.exe',
] as const

type WindowsSandboxAsset = {
  npmArch: 'x64' | 'arm64'
  integrity: string
}

const assets: Record<string, WindowsSandboxAsset> = {
  'x86_64-pc-windows-msvc': {
    npmArch: 'x64',
    integrity: CODEX_WINDOWS_X64_INTEGRITY,
  },
  'aarch64-pc-windows-msvc': {
    npmArch: 'arm64',
    integrity: CODEX_WINDOWS_ARM64_INTEGRITY,
  },
}

function getAsset(targetTriple: string): WindowsSandboxAsset {
  const asset = assets[targetTriple]
  if (!asset) {
    throw new Error(
      `[prepare-windows-sandbox] Unsupported target triple: ${targetTriple}`,
    )
  }
  return asset
}

export function windowsSandboxLauncherName(targetTriple: string): string {
  getAsset(targetTriple)
  return `cc-haha-windows-sandbox-${targetTriple}.exe`
}

export function windowsSandboxDownloadUrl(targetTriple: string): string {
  const asset = getAsset(targetTriple)
  return (
    'https://registry.npmjs.org/@openai/codex/-/' +
    `codex-${CODEX_WINDOWS_SANDBOX_VERSION}-win32-${asset.npmArch}.tgz`
  )
}

async function findFile(root: string, name: string): Promise<string> {
  const matches: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(entryPath)
      } else if (entry.name.toLowerCase() === name.toLowerCase()) {
        matches.push(entryPath)
      }
    }
  }
  await visit(root)
  if (matches.length !== 1) {
    throw new Error(
      `[prepare-windows-sandbox] Expected exactly one ${name}, found ${matches.length}`,
    )
  }
  return matches[0]!
}

async function verifyArchiveIntegrity(
  archivePath: string,
  expectedIntegrity: string,
  archiveName: string,
): Promise<void> {
  const actual =
    'sha512-' +
    createHash('sha512').update(await readFile(archivePath)).digest('base64')
  if (actual !== expectedIntegrity) {
    throw new Error(
      `[prepare-windows-sandbox] Integrity mismatch for ${archiveName}`,
    )
  }
}

export async function prepareWindowsSandboxRuntime({
  targetTriple,
  binariesDir,
  sourceDirectory = process.env.CC_HAHA_CODEX_WINDOWS_SANDBOX_BIN_DIR,
  archivePath = process.env.CC_HAHA_CODEX_WINDOWS_SANDBOX_ARCHIVE,
}: {
  targetTriple: string
  binariesDir?: string
  sourceDirectory?: string
  archivePath?: string
}): Promise<string[]> {
  const asset = getAsset(targetTriple)
  const archiveName =
    `codex-${CODEX_WINDOWS_SANDBOX_VERSION}-win32-${asset.npmArch}.tgz`
  const launcherName = windowsSandboxLauncherName(targetTriple)
  const desktopRoot = path.resolve(scriptDirectory, '..')
  const destinationRoot =
    binariesDir ?? path.join(desktopRoot, 'src-tauri', 'binaries')
  const temporaryDir = await mkdtemp(
    path.join(tmpdir(), 'cc-haha-windows-sandbox-'),
  )

  try {
    let sourceRoot: string
    let source: 'directory' | 'archive' | 'download'
    if (sourceDirectory) {
      sourceRoot = path.resolve(sourceDirectory)
      source = 'directory'
    } else {
      const downloadedArchive = path.join(temporaryDir, archiveName)
      if (archivePath) {
        await copyFile(path.resolve(archivePath), downloadedArchive)
        source = 'archive'
      } else {
        const response = await fetch(windowsSandboxDownloadUrl(targetTriple), {
          redirect: 'follow',
        })
        if (!response.ok) {
          throw new Error(
            `[prepare-windows-sandbox] Download failed (${response.status} ${response.statusText})`,
          )
        }
        await writeFile(
          downloadedArchive,
          Buffer.from(await response.arrayBuffer()),
        )
        source = 'download'
      }
      await verifyArchiveIntegrity(
        downloadedArchive,
        asset.integrity,
        archiveName,
      )
      sourceRoot = path.join(temporaryDir, 'extracted')
      await mkdir(sourceRoot, { recursive: true })
      const extract = Bun.spawn(
        ['tar', '-xf', downloadedArchive, '-C', sourceRoot],
        { stdout: 'inherit', stderr: 'inherit' },
      )
      const extractExit = await extract.exited
      if (extractExit !== 0) {
        throw new Error(
          `[prepare-windows-sandbox] Failed to extract ${archiveName} (exit ${extractExit})`,
        )
      }
    }

    const [codex, setupHelper, commandRunner] = await Promise.all(
      requiredSourceFiles.map(fileName => findFile(sourceRoot, fileName)),
    )
    await mkdir(destinationRoot, { recursive: true })
    const destinations = [
      path.join(destinationRoot, launcherName),
      path.join(destinationRoot, requiredSourceFiles[1]),
      path.join(destinationRoot, requiredSourceFiles[2]),
    ]
    await Promise.all([
      copyFile(codex, destinations[0]!),
      copyFile(setupHelper, destinations[1]!),
      copyFile(commandRunner, destinations[2]!),
    ])

    const licensesDir = path.join(
      destinationRoot,
      'codex-windows-sandbox-licenses',
    )
    await mkdir(licensesDir, { recursive: true })
    await copyFile(licensePath, path.join(licensesDir, 'LICENSE'))
    await writeFile(
      path.join(destinationRoot, 'windows-sandbox-manifest.json'),
      `${JSON.stringify(
        {
          version: CODEX_WINDOWS_SANDBOX_VERSION,
          targetTriple,
          package: `${PACKAGE_NAME}@${CODEX_WINDOWS_SANDBOX_VERSION}-win32-${asset.npmArch}`,
          integrity: asset.integrity,
          source,
          verified: source !== 'directory',
        },
        null,
        2,
      )}\n`,
    )

    console.log(
      `[prepare-windows-sandbox] staged ${CODEX_WINDOWS_SANDBOX_VERSION} for ${targetTriple}`,
    )
    return destinations
  } finally {
    await rm(temporaryDir, { recursive: true, force: true })
  }
}

async function hasPreparedRuntime(
  targetTriple: string,
  binariesDir: string,
): Promise<boolean> {
  try {
    const manifest = JSON.parse(
      await readFile(
        path.join(binariesDir, 'windows-sandbox-manifest.json'),
        'utf8',
      ),
    ) as { version?: string; targetTriple?: string; verified?: boolean }
    if (
      manifest.version !== CODEX_WINDOWS_SANDBOX_VERSION ||
      manifest.targetTriple !== targetTriple ||
      manifest.verified !== true
    ) {
      return false
    }
    const files = await Promise.all([
      stat(path.join(binariesDir, windowsSandboxLauncherName(targetTriple))),
      stat(path.join(binariesDir, requiredSourceFiles[1])),
      stat(path.join(binariesDir, requiredSourceFiles[2])),
    ])
    return files.every(file => file.isFile() && file.size > 0)
  } catch {
    return false
  }
}

export async function ensureWindowsSandboxRuntime({
  targetTriple,
  binariesDir,
}: {
  targetTriple: string
  binariesDir: string
}): Promise<void> {
  if (!targetTriple.includes('windows')) return
  if (await hasPreparedRuntime(targetTriple, binariesDir)) return
  await prepareWindowsSandboxRuntime({ targetTriple, binariesDir })
}

function parseTargetTriple(argv: string[]): string | null {
  const index = argv.indexOf('--target-triple')
  if (index >= 0) return argv[index + 1] ?? null
  return process.env.SIDECAR_TARGET_TRIPLE ?? null
}

if (import.meta.main) {
  const targetTriple = parseTargetTriple(process.argv.slice(2))
  if (!targetTriple) {
    throw new Error(
      '[prepare-windows-sandbox] Pass --target-triple or set SIDECAR_TARGET_TRIPLE',
    )
  }
  await prepareWindowsSandboxRuntime({ targetTriple })
}
