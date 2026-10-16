import { afterEach, describe, expect, test } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  extractArchive,
  getArchiveExtractCommands,
  getBundledRipgrepName,
  getRipgrepAsset,
  getRipgrepDownloadUrl,
  prepareRipgrep,
  RIPGREP_LICENSE_FILES,
  RIPGREP_VERSION,
  stageRipgrepLicenses,
} from './prepare-ripgrep'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir =>
    rm(dir, { recursive: true, force: true })))
})

const supportedTargets = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'aarch64-pc-windows-msvc',
  'x86_64-pc-windows-msvc',
  'aarch64-unknown-linux-gnu',
  'x86_64-unknown-linux-gnu',
]

describe('prepare-ripgrep target mapping', () => {
  test('pins checksummed official assets for every desktop release target', () => {
    for (const target of supportedTargets) {
      const asset = getRipgrepAsset(target)
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(asset.archiveName).toContain(`ripgrep-${RIPGREP_VERSION}-`)
      expect(getRipgrepDownloadUrl(target)).toBe(
        `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${asset.archiveName}`,
      )
    }
  })

  test('uses a static musl archive for the x64 Linux release', () => {
    expect(getRipgrepAsset('x86_64-unknown-linux-gnu').assetTriple).toBe(
      'x86_64-unknown-linux-musl',
    )
  })

  test('stages executables beside the matching sidecar', () => {
    expect(getBundledRipgrepName('aarch64-apple-darwin')).toBe(
      'rg',
    )
    expect(getBundledRipgrepName('x86_64-pc-windows-msvc')).toBe(
      'rg.exe',
    )
  })

  test('rejects unsupported targets', () => {
    expect(() => getRipgrepAsset('armv7-unknown-linux-gnu')).toThrow(
      'Unsupported target triple',
    )
  })

  test('stages the pinned ripgrep license set for offline builds', async () => {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'cc-haha-ripgrep-licenses-'))
    tempDirs.push(fixtureDir)

    const licensesDir = await stageRipgrepLicenses(fixtureDir)

    for (const fileName of RIPGREP_LICENSE_FILES) {
      expect(await readFile(path.join(licensesDir, fileName), 'utf8')).not.toHaveLength(0)
    }
  })

  test('rejects a local archive that does not match the pinned checksum', async () => {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'cc-haha-ripgrep-test-'))
    tempDirs.push(fixtureDir)
    const archivePath = path.join(fixtureDir, 'ripgrep.tar.gz')
    await writeFile(archivePath, 'not an official ripgrep archive')

    await expect(prepareRipgrep({
      targetTriple: 'aarch64-apple-darwin',
      archivePath,
    })).rejects.toThrow('SHA256 mismatch')
  })
})

describe('prepare-ripgrep archive extraction', () => {
  test('keeps tar for tarballs on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(getArchiveExtractCommands('/t/rg.tar.gz', '/t/out', platform)).toEqual([
        ['tar', '-xf', '/t/rg.tar.gz', '-C', '/t/out'],
      ])
    }
  })

  test('never hands a Windows zip to a PATH-resolved tar', () => {
    const commands = getArchiveExtractCommands(
      "C:\\Users\\O'Brien\\rg.zip",
      'C:\\Temp\\out',
      'win32',
      { SystemRoot: 'D:\\Windows' },
    )
    expect(commands.map(command => command[0])).toEqual([
      'D:\\Windows\\System32\\tar.exe',
      'powershell',
    ])
    expect(commands[1]?.at(-1)).toBe(
      "Expand-Archive -LiteralPath 'C:\\Users\\O''Brien\\rg.zip' -DestinationPath 'C:\\Temp\\out' -Force",
    )
  })

  test('tries unzip and then tar for zips off Windows', () => {
    expect(getArchiveExtractCommands('/t/rg.zip', '/t/out', 'darwin')).toEqual([
      ['unzip', '-q', '-o', '/t/rg.zip', '-d', '/t/out'],
      ['tar', '-xf', '/t/rg.zip', '-C', '/t/out'],
    ])
  })

  test('falls through when an extractor is missing or fails', async () => {
    const attempted: string[] = []
    await extractArchive([['missing'], ['broken'], ['works']], 'rg.zip', async ([command]) => {
      attempted.push(command!)
      if (command === 'missing') throw new Error('Executable not found in $PATH')
      return command === 'broken' ? 1 : 0
    })
    expect(attempted).toEqual(['missing', 'broken', 'works'])
  })

  test('reports every attempt when no extractor succeeds', async () => {
    await expect(extractArchive([['missing'], ['broken']], 'rg.zip', async ([command]) => {
      if (command === 'missing') throw new Error('Executable not found in $PATH')
      return 2
    })).rejects.toThrow(
      'Failed to extract rg.zip (missing: Executable not found in $PATH; broken exited 2)',
    )
  })
})
