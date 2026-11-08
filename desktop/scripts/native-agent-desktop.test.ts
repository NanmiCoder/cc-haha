// @vitest-environment node

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_DESKTOP_LICENSE_FILES,
  AGENT_DESKTOP_UPSTREAM_COMMIT,
  buildNativeAgentDesktop,
  nativeAgentDesktopTarget,
} from './native-agent-desktop'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'native-agent-desktop-build-'))
  temporaryRoots.push(repoRoot)
  const sourceRoot = path.join(repoRoot, 'native/agent-desktop')
  const binariesDir = path.join(repoRoot, 'staged')
  await mkdir(sourceRoot, { recursive: true })
  await Promise.all(AGENT_DESKTOP_LICENSE_FILES.map(name =>
    writeFile(path.join(sourceRoot, name), name === 'UPSTREAM.json'
      ? JSON.stringify({ commit: AGENT_DESKTOP_UPSTREAM_COMMIT, version: '1.0.2' })
      : `license fixture ${name}\n`),
  ))
  return { repoRoot, sourceRoot, binariesDir }
}

describe('native agent-desktop sidecar build', () => {
  it('stages the Linux CLI, clipboard owner and notices from a locked offline build', async () => {
    const paths = await fixture()
    const targetTriple = 'aarch64-unknown-linux-gnu'
    let command: string[] = []
    await buildNativeAgentDesktop({
      ...paths,
      targetTriple,
      env: { CARGO_TARGET_DIR: '/unrelated-target', CARGO_NET_OFFLINE: 'false' },
      run: async (args, options) => {
        command = args
        expect(options.cwd).toBe(paths.sourceRoot)
        expect(options.env.CARGO_NET_OFFLINE).toBe('true')
        const output = path.join(paths.sourceRoot, 'target', targetTriple, 'release')
        await mkdir(output, { recursive: true })
        await writeFile(path.join(output, 'agent-desktop'), 'fixture-cli')
        await writeFile(path.join(output, 'agent-desktop-linux-clipboard-owner'), 'fixture-owner')
      },
    })
    expect(command).toContain('--locked')
    expect(command).toContain('--offline')
    expect(command[command.indexOf('--target-dir') + 1]).toBe(path.join(paths.sourceRoot, 'target'))
    expect(command.filter((_, index) => command[index - 1] === '--bin')).toEqual([
      'agent-desktop', 'agent-desktop-linux-clipboard-owner',
    ])
    expect(await readFile(path.join(paths.binariesDir, 'agent-desktop-linux-clipboard-owner'), 'utf8')).toBe('fixture-owner')
    if (process.platform !== 'win32') {
      expect((await stat(path.join(paths.binariesDir, 'agent-desktop'))).mode & 0o111).toBe(0o111)
    }
    for (const notice of AGENT_DESKTOP_LICENSE_FILES) {
      expect(await readFile(path.join(paths.binariesDir, 'agent-desktop-licenses', notice), 'utf8'))
        .toBe(await readFile(path.join(paths.sourceRoot, notice), 'utf8'))
    }
    const manifest = JSON.parse(await readFile(path.join(paths.binariesDir, 'agent-desktop-manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ targetTriple, commit: AGENT_DESKTOP_UPSTREAM_COMMIT, profile: 'release' })
  })

  it('keeps the Windows executable name and selects only the CLI package', async () => {
    const paths = await fixture()
    const targetTriple = 'x86_64-pc-windows-msvc'
    const result = await buildNativeAgentDesktop({
      ...paths, targetTriple, profile: 'debug',
      run: async args => {
        expect(args.filter((_, index) => args[index - 1] === '-p')).toEqual(['agent-desktop'])
        expect(args).not.toContain('--release')
        const output = path.join(paths.sourceRoot, 'target', targetTriple, 'debug')
        await mkdir(output, { recursive: true })
        await writeFile(path.join(output, 'agent-desktop.exe'), 'fixture-windows-cli')
      },
    })
    expect(result).toEqual([path.join(paths.binariesDir, 'agent-desktop.exe')])
  })

  it('preserves the macOS helper route without reading vendor state or running cargo', async () => {
    const result = await buildNativeAgentDesktop({
      repoRoot: '/unused', targetTriple: 'aarch64-apple-darwin',
      run: async () => { throw new Error('macOS must keep the Swift helper') },
    })
    expect(result).toEqual([])
  })

  it('refuses a mismatched source pin before executing the compiler', async () => {
    const paths = await fixture()
    await writeFile(path.join(paths.sourceRoot, 'UPSTREAM.json'), JSON.stringify({ commit: 'different' }))
    await expect(buildNativeAgentDesktop({
      ...paths, targetTriple: 'x86_64-unknown-linux-gnu',
      run: async () => { throw new Error('must not compile a different upstream revision') },
    })).rejects.toThrow('does not match the build pin')
  })

  it('surfaces a failed offline build without staging executables', async () => {
    const paths = await fixture()
    await expect(buildNativeAgentDesktop({
      ...paths, targetTriple: 'aarch64-pc-windows-msvc',
      run: async () => { throw new Error('offline dependency missing') },
    })).rejects.toThrow('offline dependency missing')
    await expect(stat(paths.binariesDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses unsupported targets instead of retaining a different platform binary', () => {
    expect(() => nativeAgentDesktopTarget('x86_64-unknown-freebsd')).toThrow('Unsupported target triple')
  })
})
