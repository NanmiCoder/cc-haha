// @vitest-environment node

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getAgentSdkPlatformPackage, stageAgentSdkRuntime } from './prepare-agent-sdk'

const fixtureRoots: string[] = []

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(targetTriple = 'aarch64-apple-darwin', runtimeVersion = '0.3.304') {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'cc-haha-sdk-package-'))
  fixtureRoots.push(repoRoot)
  const packageName = getAgentSdkPlatformPackage(targetTriple)
  const sdkRoot = path.join(repoRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
  const runtimeRoot = path.join(repoRoot, 'node_modules', packageName)
  const binariesDir = path.join(repoRoot, 'binaries')
  await Promise.all([sdkRoot, runtimeRoot, binariesDir].map(directory => mkdir(directory, { recursive: true })))
  await writeFile(path.join(repoRoot, 'package.json'), '{}')
  await writeFile(path.join(sdkRoot, 'package.json'), JSON.stringify({
    name: '@anthropic-ai/claude-agent-sdk',
    main: 'sdk.mjs',
    version: '0.3.304',
    optionalDependencies: { [packageName]: '0.3.304' },
  }))
  await writeFile(path.join(sdkRoot, 'sdk.mjs'), 'export {}')
  await writeFile(path.join(sdkRoot, 'README.md'), 'Official SDK notice')
  await writeFile(path.join(runtimeRoot, 'package.json'), JSON.stringify({ name: packageName, version: runtimeVersion }))
  const binaryName = targetTriple.includes('windows') ? 'claude.exe' : 'claude'
  await writeFile(path.join(runtimeRoot, binaryName), 'fixture official runtime bytes')
  await writeFile(path.join(runtimeRoot, 'README.md'), 'Official runtime README')
  await writeFile(path.join(runtimeRoot, 'LICENSE.md'), 'Official runtime license')
  return { repoRoot, binariesDir, targetTriple, runtimeRoot, packageName }
}

describe('official Agent SDK packaging', () => {
  it.each([
    ['aarch64-apple-darwin', 'darwin-arm64'],
    ['x86_64-apple-darwin', 'darwin-x64'],
    ['x86_64-pc-windows-msvc', 'win32-x64'],
    ['aarch64-pc-windows-msvc', 'win32-arm64'],
    ['x86_64-unknown-linux-gnu', 'linux-x64'],
    ['aarch64-unknown-linux-gnu', 'linux-arm64'],
    ['x86_64-unknown-linux-musl', 'linux-x64-musl'],
    ['aarch64-unknown-linux-musl', 'linux-arm64-musl'],
  ])('selects the official dependency for %s', (target, suffix) => {
    expect(getAgentSdkPlatformPackage(target)).toBe(`@anthropic-ai/claude-agent-sdk-${suffix}`)
  })

  it.each(['aarch64-apple-darwin', 'x86_64-pc-windows-msvc'])('stages the matching native runtime and vendor notices for %s', async target => {
    const options = await fixture(target)
    const executable = await stageAgentSdkRuntime(options)
    expect(path.basename(executable)).toBe(target.includes('windows') ? 'claude.exe' : 'claude')
    expect(await readFile(executable, 'utf8')).toBe('fixture official runtime bytes')
    if (process.platform !== 'win32') expect((await stat(executable)).mode & 0o111).toBe(0o111)
    const directory = path.dirname(executable)
    expect(await readFile(path.join(directory, 'LICENSE.md'), 'utf8')).toBe('Official runtime license')
    expect(await readFile(path.join(directory, 'SDK-README.md'), 'utf8')).toBe('Official SDK notice')
    expect(JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))).toEqual({
      sdkVersion: '0.3.304', runtimePackage: options.packageName, runtimeVersion: '0.3.304', targetTriple: target,
    })
  })

  it('fails instead of packaging an incompatible or global runtime', async () => {
    const options = await fixture('aarch64-apple-darwin', '0.3.303')
    await expect(stageAgentSdkRuntime(options)).rejects.toThrow('Agent SDK runtime mismatch')
    await rm(options.runtimeRoot, { recursive: true })
    await expect(stageAgentSdkRuntime(options)).rejects.toThrow('Missing @anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.304')
    expect(() => getAgentSdkPlatformPackage('unsupported-target')).toThrow('Unsupported official Agent SDK target')
  })

  it('keeps the last good staged runtime if the new package is incomplete', async () => {
    const options = await fixture()
    const executable = await stageAgentSdkRuntime(options)
    await rm(path.join(options.runtimeRoot, 'LICENSE.md'))
    await expect(stageAgentSdkRuntime(options)).rejects.toThrow()
    expect(await readFile(executable, 'utf8')).toBe('fixture official runtime bytes')
    await expect(stat(path.join(options.binariesDir, 'official-agent-sdk.staging'))).rejects.toThrow()
  })
})
