// @vitest-environment node

import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function writeExecutable(pathname: string, source: string): Promise<void> {
  await writeFile(pathname, source, 'utf8')
  await chmod(pathname, 0o755)
}

// Runs the installer next to the given DMG names on a machine reporting
// `machine` from `uname -m`, and returns the DMG it picked. hdiutil is stubbed
// to fail, so the script stops right after announcing its choice and never
// touches /Applications.
async function pickDmg(machine: string, dmgNames: string[]): Promise<string | undefined> {
  const root = await mkdtemp(path.join(tmpdir(), 'cc-haha-install-macos-'))
  fixtures.push(root)
  const downloads = path.join(root, 'Downloads')
  const fakeBin = path.join(root, 'fake-bin')
  await Promise.all([mkdir(downloads), mkdir(fakeBin)])
  const script = path.join(downloads, 'install-macos-unsigned.sh')
  await copyFile(path.resolve(import.meta.dirname, 'install-macos-unsigned.sh'), script)
  await Promise.all(dmgNames.map(name => writeFile(path.join(downloads, name), '')))
  await writeExecutable(path.join(fakeBin, 'uname'), `#!/bin/sh\necho ${machine}\n`)
  await writeExecutable(path.join(fakeBin, 'xattr'), '#!/bin/sh\nexit 0\n')
  await writeExecutable(path.join(fakeBin, 'hdiutil'), '#!/bin/sh\nexit 1\n')

  const result = spawnSync('bash', [script], {
    env: { PATH: `${fakeBin}:/usr/bin:/bin`, HOME: root },
    encoding: 'utf8',
  })
  expect(result.status).not.toBe(0)
  const chosen = result.stdout.match(/^Using DMG: (.+)$/m)?.[1]
  return chosen ? path.basename(chosen) : undefined
}

describe('install-macos-unsigned.sh DMG selection', () => {
  const releaseDmgs = [
    'Claude-Code-Haha-0.7.7-macOS-Apple-Silicon.dmg',
    'Claude-Code-Haha-0.7.7-macOS-Intel.dmg',
  ]

  it.each([
    ['arm64', 'Claude-Code-Haha-0.7.7-macOS-Apple-Silicon.dmg'],
    ['x86_64', 'Claude-Code-Haha-0.7.7-macOS-Intel.dmg'],
  ])('picks the chip-named release DMG on %s', async (machine, expected) => {
    expect(await pickDmg(machine, releaseDmgs)).toBe(expected)
  })

  it.each([
    ['arm64', 'Claude-Code-Haha-0.7.7-macOS-arm64.dmg'],
    ['x86_64', 'Claude-Code-Haha-0.7.7-macOS-x64.dmg'],
  ])('picks the arch-named development DMG on %s', async (machine, expected) => {
    const devDmgs = ['Claude-Code-Haha-0.7.7-macOS-arm64.dmg', 'Claude-Code-Haha-0.7.7-macOS-x64.dmg']
    expect(await pickDmg(machine, devDmgs)).toBe(expected)
  })

  it.each([
    ['arm64', 'Claude-Code-Haha-0.7.6-mac-arm64.dmg'],
    ['x86_64', 'Claude-Code-Haha-0.7.6-mac-x64.dmg'],
  ])('recognizes a release before the rename on %s', async (machine, expected) => {
    const legacyDmgs = ['Claude-Code-Haha-0.7.6-mac-arm64.dmg', 'Claude-Code-Haha-0.7.6-mac-x64.dmg']
    expect(await pickDmg(machine, legacyDmgs)).toBe(expected)
  })

  it('does not mistake the auto-update zip for an installer', async () => {
    expect(await pickDmg('arm64', [
      'Claude-Code-Haha-0.7.7-macOS-arm64-update.zip',
      'Claude-Code-Haha-0.7.7-macOS-Apple-Silicon.dmg',
    ])).toBe('Claude-Code-Haha-0.7.7-macOS-Apple-Silicon.dmg')
  })
})
