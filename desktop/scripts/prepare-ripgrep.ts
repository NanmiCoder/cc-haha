import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const RIPGREP_VERSION = '15.1.0'
export const RIPGREP_LICENSE_FILES = ['COPYING', 'LICENSE-MIT', 'UNLICENSE'] as const
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const ripgrepLicenseSourceDirectory = path.join(scriptDirectory, 'ripgrep-licenses')

type RipgrepAsset = {
  assetTriple: string
  archiveName: string
  sha256: string
  executableName: 'rg' | 'rg.exe'
}

const RIPGREP_ASSETS: Record<string, RipgrepAsset> = {
  'aarch64-apple-darwin': {
    assetTriple: 'aarch64-apple-darwin',
    archiveName: `ripgrep-${RIPGREP_VERSION}-aarch64-apple-darwin.tar.gz`,
    sha256: '378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715',
    executableName: 'rg',
  },
  'x86_64-apple-darwin': {
    assetTriple: 'x86_64-apple-darwin',
    archiveName: `ripgrep-${RIPGREP_VERSION}-x86_64-apple-darwin.tar.gz`,
    sha256: '64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882',
    executableName: 'rg',
  },
  'aarch64-pc-windows-msvc': {
    assetTriple: 'aarch64-pc-windows-msvc',
    archiveName: `ripgrep-${RIPGREP_VERSION}-aarch64-pc-windows-msvc.zip`,
    sha256: '00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e',
    executableName: 'rg.exe',
  },
  'x86_64-pc-windows-msvc': {
    assetTriple: 'x86_64-pc-windows-msvc',
    archiveName: `ripgrep-${RIPGREP_VERSION}-x86_64-pc-windows-msvc.zip`,
    sha256: '124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a',
    executableName: 'rg.exe',
  },
  'aarch64-unknown-linux-gnu': {
    assetTriple: 'aarch64-unknown-linux-gnu',
    archiveName: `ripgrep-${RIPGREP_VERSION}-aarch64-unknown-linux-gnu.tar.gz`,
    sha256: '2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e',
    executableName: 'rg',
  },
  // The official musl build is static PIE and is the most portable x64 Linux asset.
  'x86_64-unknown-linux-gnu': {
    assetTriple: 'x86_64-unknown-linux-musl',
    archiveName: `ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    sha256: '1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599',
    executableName: 'rg',
  },
}

export function getRipgrepAsset(targetTriple: string): RipgrepAsset {
  const asset = RIPGREP_ASSETS[targetTriple]
  if (!asset) {
    throw new Error(`[prepare-ripgrep] Unsupported target triple: ${targetTriple}`)
  }
  return asset
}

export function getBundledRipgrepName(targetTriple: string): string {
  return targetTriple.includes('windows') ? 'rg.exe' : 'rg'
}

export function getRipgrepDownloadUrl(targetTriple: string): string {
  const asset = getRipgrepAsset(targetTriple)
  return `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${asset.archiveName}`
}

export async function stageRipgrepLicenses(binariesDir: string): Promise<string> {
  const licensesDir = path.join(binariesDir, 'ripgrep-licenses')
  await mkdir(licensesDir, { recursive: true })
  await Promise.all(RIPGREP_LICENSE_FILES.map(fileName =>
    copyFile(
      path.join(ripgrepLicenseSourceDirectory, fileName),
      path.join(licensesDir, fileName),
    )))
  return licensesDir
}

export async function prepareRipgrep({
  targetTriple,
  archivePath = process.env.CC_HAHA_RIPGREP_ARCHIVE,
}: {
  targetTriple: string
  archivePath?: string
}): Promise<string> {
  const asset = getRipgrepAsset(targetTriple)
  const desktopRoot = path.resolve(scriptDirectory, '..')
  const binariesDir = path.join(desktopRoot, 'src-tauri', 'binaries')
  const temporaryDir = await mkdtemp(path.join(tmpdir(), 'cc-haha-ripgrep-'))

  try {
    const downloadedArchive = path.join(temporaryDir, asset.archiveName)
    if (archivePath) {
      await copyFile(path.resolve(archivePath), downloadedArchive)
    } else {
      const response = await fetch(getRipgrepDownloadUrl(targetTriple), {
        redirect: 'follow',
      })
      if (!response.ok) {
        throw new Error(
          `[prepare-ripgrep] Download failed (${response.status} ${response.statusText})`,
        )
      }
      await writeFile(downloadedArchive, Buffer.from(await response.arrayBuffer()))
    }

    const archiveHash = createHash('sha256')
      .update(await readFile(downloadedArchive))
      .digest('hex')
    if (archiveHash !== asset.sha256) {
      throw new Error(
        `[prepare-ripgrep] SHA256 mismatch for ${asset.archiveName}: expected ${asset.sha256}, got ${archiveHash}`,
      )
    }

    const extractDir = path.join(temporaryDir, 'extracted')
    await mkdir(extractDir, { recursive: true })
    // GNU tar cannot read zip archives ("This does not look like a tar
    // archive") and Git Bash on Windows ships GNU tar as `tar`, so dispatch
    // on extension: zip goes to unzip, with Expand-Archive as the fallback
    // when unzip is unavailable.
    const isZip = downloadedArchive.toLowerCase().endsWith('.zip')
    let extract = Bun.spawn(
      isZip
        ? ['unzip', '-q', '-o', downloadedArchive, '-d', extractDir]
        : ['tar', '-xf', downloadedArchive, '-C', extractDir],
      {
        stdout: 'inherit',
        stderr: 'inherit',
      },
    )
    let extractExit = await extract.exited
    if (extractExit !== 0 && isZip && process.platform === 'win32') {
      extract = Bun.spawn(
        [
          'powershell',
          '-NoLogo',
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${downloadedArchive}' -DestinationPath '${extractDir}' -Force`,
        ],
        { stdout: 'inherit', stderr: 'inherit' },
      )
      extractExit = await extract.exited
    }
    if (extractExit !== 0) {
      throw new Error(`[prepare-ripgrep] Failed to extract ${asset.archiveName} (exit ${extractExit})`)
    }

    const archiveRoot = path.join(
      extractDir,
      `ripgrep-${RIPGREP_VERSION}-${asset.assetTriple}`,
    )
    const extractedExecutable = path.join(archiveRoot, asset.executableName)
    const destination = path.join(binariesDir, getBundledRipgrepName(targetTriple))
    await mkdir(binariesDir, { recursive: true })

    for (const entry of await readdir(binariesDir)) {
      if (
        (entry === 'rg' || entry === 'rg.exe' || entry.startsWith('rg-')) &&
        entry !== path.basename(destination)
      ) {
        await rm(path.join(binariesDir, entry), { force: true })
      }
    }

    await copyFile(extractedExecutable, destination)
    await chmod(destination, 0o755)
    await writeFile(
      path.join(binariesDir, 'ripgrep-manifest.json'),
      `${JSON.stringify({
        version: RIPGREP_VERSION,
        targetTriple,
        archiveName: asset.archiveName,
        sha256: asset.sha256,
      }, null, 2)}\n`,
    )

    await stageRipgrepLicenses(binariesDir)

    console.log(`[prepare-ripgrep] ${destination}`)
    return destination
  } finally {
    await rm(temporaryDir, { recursive: true, force: true })
  }
}

function parseTargetTriple(argv: string[]): string | null {
  const index = argv.indexOf('--target-triple')
  if (index >= 0) return argv[index + 1] ?? null
  return process.env.SIDECAR_TARGET_TRIPLE ?? null
}

if (import.meta.main) {
  const targetTriple = parseTargetTriple(process.argv.slice(2))
  if (!targetTriple) {
    throw new Error('[prepare-ripgrep] Pass --target-triple or set SIDECAR_TARGET_TRIPLE')
  }
  await prepareRipgrep({ targetTriple })
}
