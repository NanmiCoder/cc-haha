import { createHash } from 'node:crypto'
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveHostTriple } from '../electron/services/sidecarManager'
import { extractArchive, getArchiveExtractCommands } from './prepare-ripgrep'

export const CLOUDFLARED_VERSION = '2026.10.6'
export const CLOUDFLARED_LICENSE_FILES = ['LICENSE', 'NOTICE'] as const
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))

export type CloudflaredAsset = {
  name: string
  sha256: string
  architecture: 'amd64' | 'arm64'
  archive: boolean
  compatibility?: 'windows-x64-emulation'
}

const assets: Record<string, CloudflaredAsset> = {
  'x86_64-apple-darwin': { name: 'cloudflared-darwin-amd64.tgz', sha256: '6c04a13835ca5ff29a0c6f58d17d1f3956aad1b7df1631f5b5efbc06269deded', architecture: 'amd64', archive: true },
  'aarch64-apple-darwin': { name: 'cloudflared-darwin-arm64.tgz', sha256: 'ea1e5105d35bbe16cee5b2f7b4742059ada341fbd35938ed827c24b85efa51c8', architecture: 'arm64', archive: true },
  'x86_64-unknown-linux-gnu': { name: 'cloudflared-linux-amd64', sha256: '1d356dac769d0dbf62ebe588c4034824bbff98d5790c2f844cc99e0e2f57462d', architecture: 'amd64', archive: false },
  'aarch64-unknown-linux-gnu': { name: 'cloudflared-linux-arm64', sha256: '0ae0e179475b2c77651a718d2b376e0151f4fca5954702a84f02843a4d5fcac0', architecture: 'arm64', archive: false },
  'x86_64-pc-windows-msvc': { name: 'cloudflared-windows-amd64.exe', sha256: 'd521b3bf68982165f0d06d76732f22d9a105ef057ff3ae4c0986f3a23190950f', architecture: 'amd64', archive: false },
  // Cloudflare does not publish a native Windows ARM64 asset. Windows 11 ARM
  // runs the official x64 executable through its built-in x64 compatibility.
  'aarch64-pc-windows-msvc': { name: 'cloudflared-windows-amd64.exe', sha256: 'd521b3bf68982165f0d06d76732f22d9a105ef057ff3ae4c0986f3a23190950f', architecture: 'amd64', archive: false, compatibility: 'windows-x64-emulation' },
}

export function getCloudflaredAsset(targetTriple: string): CloudflaredAsset {
  const asset = assets[targetTriple]
  if (!asset) throw new Error(`[prepare-cloudflared] Unsupported target triple: ${targetTriple}`)
  return { ...asset }
}

export function getBundledCloudflaredName(targetTriple: string): string {
  getCloudflaredAsset(targetTriple)
  return `cloudflared-${targetTriple}${targetTriple.includes('windows') ? '.exe' : ''}`
}

export function getCloudflaredDownloadUrl(targetTriple: string): string {
  return `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${getCloudflaredAsset(targetTriple).name}`
}

export async function stageCloudflaredLicenses(binariesDir: string): Promise<string> {
  const destination = path.join(binariesDir, 'cloudflared-licenses')
  await mkdir(destination, { recursive: true })
  await Promise.all(CLOUDFLARED_LICENSE_FILES.map(file => copyFile(path.join(scriptDirectory, 'cloudflared-licenses', file), path.join(destination, file))))
  return destination
}

type Preparation = { targetTriple: string, desktopRoot?: string, archivePath?: string }
type PreparationDependencies = {
  /** A deterministic fixture can replace the release metadata, never a CLI flag or environment variable. */
  asset?: CloudflaredAsset
  download?: (url: string) => Promise<Uint8Array>
  extract?: (archive: string, destination: string) => Promise<void>
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const paths = ({ desktopRoot = path.resolve(scriptDirectory, '..'), targetTriple }: Preparation) => {
  const binariesDir = path.join(desktopRoot, 'src-tauri', 'binaries')
  const binary = path.join(binariesDir, getBundledCloudflaredName(targetTriple))
  return { binariesDir, binary, manifest: `${binary}.json` }
}

/** Offline build gate. No downloads or user-installed executable fallbacks are allowed here. */
export async function assertPreparedCloudflared(options: Preparation, asset = getCloudflaredAsset(options.targetTriple)): Promise<string> {
  const locations = paths(options)
  try {
    const manifest = JSON.parse(await readFile(locations.manifest, 'utf8')) as Record<string, unknown>
    if (manifest.version !== CLOUDFLARED_VERSION || manifest.targetTriple !== options.targetTriple ||
      manifest.asset !== asset.name || manifest.assetSha256 !== asset.sha256 ||
      typeof manifest.binarySha256 !== 'string' || digest(await readFile(locations.binary)) !== manifest.binarySha256) throw new Error('Unverified connector')
    await access(locations.binary, constants.X_OK)
    for (const file of CLOUDFLARED_LICENSE_FILES) await readFile(path.join(locations.binariesDir, 'cloudflared-licenses', file))
    return locations.binary
  } catch {
    throw new Error(`[prepare-cloudflared] Verified cloudflared ${CLOUDFLARED_VERSION} is missing for ${options.targetTriple}; run bun run prepare:cloudflared --target-triple ${options.targetTriple} before the offline build`)
  }
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`[prepare-cloudflared] Download failed (${response.status})`)
  return new Uint8Array(await response.arrayBuffer())
}

/** Explicit build dependency preparation. Official release asset digests are pinned above. */
export async function prepareCloudflared(
  options: Preparation,
  dependencies: PreparationDependencies = {},
): Promise<string> {
  const officialAsset = getCloudflaredAsset(options.targetTriple)
  const asset = dependencies.asset ?? officialAsset
  const locations = paths(options)
  if (!options.archivePath) {
    try { return await assertPreparedCloudflared(options, asset) } catch { /* Explicit preparation can repair its regenerable cache. */ }
  }
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'cc-haha-prepare-cloudflared-'))
  let stagedBinary: string | undefined
  let stagedManifest: string | undefined
  try {
    const archive = path.join(temporaryDirectory, asset.name)
    if (options.archivePath) await copyFile(path.resolve(options.archivePath), archive)
    else await writeFile(archive, await (dependencies.download ?? download)(getCloudflaredDownloadUrl(options.targetTriple)))
    const actualDigest = digest(await readFile(archive))
    if (actualDigest !== asset.sha256) throw new Error(`[prepare-cloudflared] SHA256 mismatch for ${asset.name}: expected ${asset.sha256}, got ${actualDigest}`)

    let executable = archive
    if (asset.archive) {
      const extractedDirectory = path.join(temporaryDirectory, 'extracted')
      await mkdir(extractedDirectory)
      if (dependencies.extract) await dependencies.extract(archive, extractedDirectory)
      else await extractArchive(getArchiveExtractCommands(archive, extractedDirectory), asset.name)
      executable = path.join(extractedDirectory, 'cloudflared')
    }
    const executableDigest = digest(await readFile(executable))
    await mkdir(locations.binariesDir, { recursive: true })
    // Stage before replacing the active cache so interrupted preparation never
    // leaves the runtime trying to spawn a partially downloaded executable.
    const suffix = path.basename(temporaryDirectory)
    stagedBinary = `${locations.binary}.${suffix}.tmp`
    stagedManifest = `${locations.manifest}.${suffix}.tmp`
    await copyFile(executable, stagedBinary)
    await chmod(stagedBinary, 0o755)
    await writeFile(stagedManifest, `${JSON.stringify({
      version: CLOUDFLARED_VERSION,
      targetTriple: options.targetTriple,
      asset: asset.name,
      assetArchitecture: asset.architecture,
      ...(asset.compatibility ? { compatibility: asset.compatibility } : {}),
      assetSha256: asset.sha256,
      binarySha256: executableDigest,
    }, null, 2)}\n`)
    await stageCloudflaredLicenses(locations.binariesDir)
    await rename(stagedBinary, locations.binary)
    await rename(stagedManifest, locations.manifest)
    console.log(`[prepare-cloudflared] ${locations.binary} (${CLOUDFLARED_VERSION})`)
    return locations.binary
  } finally {
    await Promise.all([stagedBinary, stagedManifest].filter((file): file is string => !!file).map(file => rm(file, { force: true })))
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const targetIndex = args.indexOf('--target-triple')
  const targetTriple = targetIndex >= 0 ? args[targetIndex + 1] :
    process.env.SIDECAR_TARGET_TRIPLE ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? process.env.CARGO_BUILD_TARGET ?? resolveHostTriple()
  if (!targetTriple) throw new Error('[prepare-cloudflared] --target-triple needs a value')
  await prepareCloudflared({ targetTriple, archivePath: process.env.CC_HAHA_CLOUDFLARED_ARCHIVE })
}
