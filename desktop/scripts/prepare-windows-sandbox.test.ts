import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  CODEX_WINDOWS_SANDBOX_VERSION,
  prepareWindowsSandboxRuntime,
  windowsSandboxLauncherName,
} from './prepare-windows-sandbox'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('prepareWindowsSandboxRuntime', () => {
  it('stages the pinned Codex launcher and both required helpers', async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), 'cc-haha-sandbox-prepare-test-'),
    )
    temporaryDirectories.push(root)
    const source = path.join(root, 'source', 'nested')
    const destination = path.join(root, 'destination')
    await mkdir(source, { recursive: true })
    await Promise.all([
      writeFile(path.join(source, 'codex.exe'), 'launcher'),
      writeFile(
        path.join(source, 'codex-windows-sandbox-setup.exe'),
        'setup',
      ),
      writeFile(path.join(source, 'codex-command-runner.exe'), 'runner'),
    ])

    const staged = await prepareWindowsSandboxRuntime({
      targetTriple: 'x86_64-pc-windows-msvc',
      binariesDir: destination,
      sourceDirectory: path.join(root, 'source'),
    })

    expect(staged.map(file => path.basename(file))).toEqual([
      windowsSandboxLauncherName('x86_64-pc-windows-msvc'),
      'codex-windows-sandbox-setup.exe',
      'codex-command-runner.exe',
    ])
    const manifest = await readFile(
      path.join(destination, 'windows-sandbox-manifest.json'),
      'utf8',
    )
    expect(manifest).toContain(
      `"version": "${CODEX_WINDOWS_SANDBOX_VERSION}"`,
    )
    expect(manifest).toContain('"verified": false')
    expect(
      await readFile(
        path.join(destination, 'codex-windows-sandbox-licenses', 'LICENSE'),
        'utf8',
      ),
    ).toContain('Apache License')
  })
})
