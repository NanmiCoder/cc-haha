// @vitest-environment node
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  CLOUDFLARED_LICENSE_FILES,
  CLOUDFLARED_VERSION,
  assertPreparedCloudflared,
  getBundledCloudflaredName,
  getCloudflaredAsset,
  getCloudflaredDownloadUrl,
  prepareCloudflared,
  stageCloudflaredLicenses,
} from './prepare-cloudflared'

const temporaryDirectories: string[] = []
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture(targetTriple = 'x86_64-unknown-linux-gnu') {
  const desktopRoot = await mkdtemp(path.join(tmpdir(), 'prepare-cloudflared-test-'))
  temporaryDirectories.push(desktopRoot)
  const bytes = Buffer.from('an isolated fake executable for the fixture')
  const asset = { ...getCloudflaredAsset(targetTriple), sha256: sha256(bytes) }
  const options = { desktopRoot, targetTriple }
  const download = vi.fn(async () => bytes)
  return { bytes, asset, options, download, desktopRoot }
}

describe('pinned Cloudflare release assets', () => {
  it.each([
    'aarch64-apple-darwin', 'x86_64-apple-darwin',
    'aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu',
    'x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc',
  ])('maps %s to an official checksummed asset and the runtime filename', target => {
    const asset = getCloudflaredAsset(target)
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(getCloudflaredDownloadUrl(target)).toBe(`https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.name}`)
    expect(getBundledCloudflaredName(target)).toBe(`cloudflared-${target}${target.includes('windows') ? '.exe' : ''}`)
  })

  it('records x64 emulation for Windows ARM64 rather than inventing an upstream asset', () => {
    expect(getCloudflaredAsset('aarch64-pc-windows-msvc')).toEqual({
      ...getCloudflaredAsset('x86_64-pc-windows-msvc'), compatibility: 'windows-x64-emulation',
    })
    expect(getCloudflaredDownloadUrl('aarch64-pc-windows-msvc')).toContain('cloudflared-windows-amd64.exe')
  })

  it.each(['armv7-unknown-linux-gnu', '../../outside-workspace'])('rejects unsupported or unsafe target names: %s', target => {
    expect(() => getCloudflaredAsset(target)).toThrow('Unsupported target triple')
    expect(() => getBundledCloudflaredName(target)).toThrow('Unsupported target triple')
  })

  it('stages the complete upstream license and distribution notice', async () => {
    const f = await fixture()
    const directory = await stageCloudflaredLicenses(f.desktopRoot)
    for (const file of CLOUDFLARED_LICENSE_FILES) expect((await readFile(path.join(directory, file), 'utf8')).length).toBeGreaterThan(100)
    expect(await readFile(path.join(directory, 'LICENSE'), 'utf8')).toContain('Apache License')
    expect(await readFile(path.join(directory, 'NOTICE'), 'utf8')).toContain(CLOUDFLARED_VERSION)
  })
})

describe('verified connector preparation', () => {
  it('stages verified bytes, executable permissions, provenance, and an offline-checkable cache', async () => {
    const f = await fixture()
    const binary = await prepareCloudflared(f.options, { asset: f.asset, download: f.download })
    expect(await readFile(binary)).toEqual(f.bytes)
    expect(f.download).toHaveBeenCalledExactlyOnceWith(getCloudflaredDownloadUrl(f.options.targetTriple))
    expect(JSON.parse(await readFile(`${binary}.json`, 'utf8'))).toMatchObject({
      version: CLOUDFLARED_VERSION, targetTriple: f.options.targetTriple,
      asset: f.asset.name, assetArchitecture: f.asset.architecture,
      assetSha256: f.asset.sha256, binarySha256: sha256(f.bytes),
    })
    if (process.platform !== 'win32') expect((await stat(binary)).mode & 0o777).toBe(0o755)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('public network forbidden'))
    expect(await assertPreparedCloudflared(f.options, f.asset)).toBe(binary)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reuses a verified cache without downloading again', async () => {
    const f = await fixture()
    const dependencies = { asset: f.asset, download: f.download }
    const binary = await prepareCloudflared(f.options, dependencies)
    expect(await prepareCloudflared(f.options, dependencies)).toBe(binary)
    expect(f.download).toHaveBeenCalledTimes(1)
  })

  it('requires explicit preparation when its binary is missing or corrupted', async () => {
    const f = await fixture()
    await expect(assertPreparedCloudflared(f.options)).rejects.toThrow('run bun run prepare:cloudflared')
    const binary = await prepareCloudflared(f.options, { asset: f.asset, download: f.download })
    await writeFile(binary, 'tampered binary')
    await expect(assertPreparedCloudflared(f.options, f.asset)).rejects.toThrow('Verified cloudflared')
  })

  it('rejects stale or altered release provenance even when the binary is still present', async () => {
    const f = await fixture()
    const binary = await prepareCloudflared(f.options, { asset: f.asset, download: f.download })
    const manifest = JSON.parse(await readFile(`${binary}.json`, 'utf8'))
    await writeFile(`${binary}.json`, JSON.stringify({ ...manifest, version: 'old-release' }))
    await expect(assertPreparedCloudflared(f.options, f.asset)).rejects.toThrow('Verified cloudflared')
  })

  it.skipIf(process.platform === 'win32')('rejects a cached connector that has lost executable permissions', async () => {
    const f = await fixture()
    const binary = await prepareCloudflared(f.options, { asset: f.asset, download: f.download })
    await chmod(binary, 0o600)
    await expect(assertPreparedCloudflared(f.options, f.asset)).rejects.toThrow('Verified cloudflared')
  })

  it('never replaces a valid executable with a download that fails the pinned checksum', async () => {
    const f = await fixture()
    const binary = await prepareCloudflared(f.options, { asset: f.asset, download: f.download })
    const archivePath = path.join(f.desktopRoot, 'bad-download')
    await writeFile(archivePath, 'not the verified asset')
    await expect(prepareCloudflared({ ...f.options, archivePath }, { asset: f.asset })).rejects.toThrow('SHA256 mismatch')
    expect(await readFile(binary)).toEqual(f.bytes)
  })

  it('extracts macOS archives only after verifying the downloaded archive', async () => {
    const f = await fixture('aarch64-apple-darwin')
    const extract = vi.fn(async (archive: string, destination: string) => {
      expect(await readFile(archive)).toEqual(f.bytes)
      await writeFile(path.join(destination, 'cloudflared'), 'extracted executable')
    })
    const binary = await prepareCloudflared(f.options, { asset: f.asset, download: f.download, extract })
    expect(extract).toHaveBeenCalledTimes(1)
    expect(await readFile(binary, 'utf8')).toBe('extracted executable')
    expect(JSON.parse(await readFile(`${binary}.json`, 'utf8')).binarySha256).toBe(sha256('extracted executable'))
  })

  it('does not extract an unverified archive', async () => {
    const f = await fixture('aarch64-apple-darwin')
    const extract = vi.fn(async () => {})
    await expect(prepareCloudflared(f.options, { asset: { ...f.asset, sha256: '0'.repeat(64) }, download: f.download, extract })).rejects.toThrow('SHA256 mismatch')
    expect(extract).not.toHaveBeenCalled()
  })

  it('rejects a caller-supplied local archive that does not match the official release', async () => {
    const f = await fixture()
    const archivePath = path.join(f.desktopRoot, 'local-cloudflared')
    await writeFile(archivePath, f.bytes)
    await expect(prepareCloudflared({ ...f.options, archivePath })).rejects.toThrow('SHA256 mismatch')
  })
})
