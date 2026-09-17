// @vitest-environment node

import { spawnSync } from 'node:child_process'
import { copyFile, chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

async function exists(pathname: string): Promise<boolean> {
  return stat(pathname).then(() => true, () => false)
}

async function writeExecutable(pathname: string, source: string): Promise<void> {
  await writeFile(pathname, source, 'utf8')
  await chmod(pathname, 0o755)
}

describe.skipIf(process.platform === 'win32')('macOS arm64 build dependency installation', () => {
  it('installs every package needed by the compiled sidecar in a clean worktree', async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'cc-haha-macos-build-'))
    const desktopDir = path.join(fixtureRoot, 'desktop')
    const adaptersDir = path.join(fixtureRoot, 'adapters')
    const scriptsDir = path.join(desktopDir, 'scripts')
    const fakeBinDir = path.join(fixtureRoot, 'fake-bin')
    const buildScript = path.join(scriptsDir, 'build-macos-arm64.sh')

    try {
      await Promise.all([
        mkdir(scriptsDir, { recursive: true }),
        mkdir(adaptersDir, { recursive: true }),
        mkdir(fakeBinDir, { recursive: true }),
      ])
      await copyFile(
        path.resolve(import.meta.dirname, 'build-macos-arm64.sh'),
        buildScript,
      )
      await chmod(buildScript, 0o755)

      await writeExecutable(path.join(fakeBinDir, 'uname'), `#!/bin/bash
if [[ "\${1:-}" == "-s" ]]; then
  echo Darwin
elif [[ "\${1:-}" == "-m" ]]; then
  echo arm64
fi
`)
      await writeExecutable(path.join(fakeBinDir, 'bun'), `#!/bin/bash
set -euo pipefail

if [[ "\${1:-}" == "install" ]]; then
  mkdir -p "\${PWD}/node_modules"
  exit 0
fi

if [[ "\${*}" == *"build:sidecars"* ]]; then
  for package_dir in "\${TEST_REPO_ROOT}" "\${TEST_REPO_ROOT}/desktop" "\${TEST_REPO_ROOT}/adapters"; do
    [[ -d "\${package_dir}/node_modules" ]] || exit 42
  done
  exit 86
fi

exit 0
`)
      for (const command of ['node', 'codesign', 'hdiutil']) {
        await writeExecutable(path.join(fakeBinDir, command), '#!/bin/bash\nexit 0\n')
      }

      expect(await Promise.all([
        exists(path.join(fixtureRoot, 'node_modules')),
        exists(path.join(desktopDir, 'node_modules')),
        exists(path.join(adaptersDir, 'node_modules')),
      ])).toEqual([false, false, false])

      const result = spawnSync('/bin/bash', [buildScript], {
        cwd: desktopDir,
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
          MAC_TARGETS: 'zip',
          SIGN_BUILD: '0',
          TEST_REPO_ROOT: fixtureRoot,
        },
      })

      expect(result.status, [
        `status: ${String(result.status)}`,
        `signal: ${String(result.signal)}`,
        `spawn error: ${result.error?.stack ?? 'none'}`,
        `stderr: ${result.stderr || '<empty>'}`,
      ].join('\n')).toBe(86)
      expect(await Promise.all([
        exists(path.join(fixtureRoot, 'node_modules')),
        exists(path.join(desktopDir, 'node_modules')),
        exists(path.join(adaptersDir, 'node_modules')),
      ])).toEqual([true, true, true])
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })
})
