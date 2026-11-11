// @vitest-environment node

import { spawnSync } from 'node:child_process'
import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment'

async function exists(pathname: string): Promise<boolean> {
  return stat(pathname).then(() => true, () => false)
}

async function writeExecutable(pathname: string, source: string): Promise<void> {
  await writeFile(pathname, source, 'utf8')
  await chmod(pathname, 0o755)
}

async function runBuildFixture(options: {
  signBuild?: string
  signIdentity?: string
  securityOutput?: string
  localUnsignedBuild?: string
  ci?: string
  githubActions?: string
} = {}) {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'cc-haha-macos-build-'))
  const desktopDir = path.join(fixtureRoot, 'desktop')
  const adaptersDir = path.join(fixtureRoot, 'adapters')
  // `bun run build` exports the phone H5 from mobile/ into dist/m.
  const mobileDir = path.join(fixtureRoot, 'mobile')
  const scriptsDir = path.join(desktopDir, 'scripts')
  const fakeBinDir = path.join(fixtureRoot, 'fake-bin')
  const buildScript = path.join(scriptsDir, 'build-macos-arm64.sh')

  try {
    await Promise.all([
      mkdir(scriptsDir, { recursive: true }),
      mkdir(adaptersDir, { recursive: true }),
      mkdir(mobileDir, { recursive: true }),
      mkdir(fakeBinDir, { recursive: true }),
    ])
    await copyFile(
      path.resolve(import.meta.dirname, 'build-macos-arm64.sh'),
      buildScript,
    )
    await chmod(buildScript, 0o755)

    await writeFile(path.join(fixtureRoot, 'security-output.txt'), options.securityOutput ?? '')
    await writeExecutable(path.join(fakeBinDir, 'security'), `#!/bin/bash
touch "\${TEST_REPO_ROOT}/security-queried"
cat "\${TEST_REPO_ROOT}/security-output.txt"
exit 0
`)
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
  for package_dir in "\${TEST_REPO_ROOT}" "\${TEST_REPO_ROOT}/desktop" "\${TEST_REPO_ROOT}/adapters" "\${TEST_REPO_ROOT}/mobile"; do
    [[ -d "\${package_dir}/node_modules" ]] || exit 42
  done
  printf '%s\\n' "\${CC_HAHA_SIGN_IDENTITY:-}" "\${CSC_NAME:-}" "\${CC_HAHA_LOCAL_UNSIGNED_BUILD:-}" > "\${TEST_REPO_ROOT}/sidecar-env.txt"
  /bin/bash -c 'source "$1"; resolve_identity' helper-signing-test "\${TEST_NATIVE_BUILD_SCRIPT}"
  exit 86
fi

exit 0
`)
    for (const command of ['node', 'codesign', 'hdiutil']) {
      await writeExecutable(path.join(fakeBinDir, command), '#!/bin/bash\nexit 0\n')
    }

    // Read shell fakes through Bash so fresh temporary executables are not
    // launched directly, while preserving their child-process exit behavior.
    const shellEnvironment = path.join(fixtureRoot, 'fake-command-env.sh')
    await writeFile(shellEnvironment, ['uname', 'bun', 'node', 'codesign', 'hdiutil', 'security']
      .map(command => `${command}() { /bin/bash "\${TEST_FAKE_BIN_DIR}/${command}" "$@"; }`)
      .join('\n'), 'utf8')

    const installedBefore = await Promise.all([
      exists(path.join(fixtureRoot, 'node_modules')),
      exists(path.join(desktopDir, 'node_modules')),
      exists(path.join(adaptersDir, 'node_modules')),
      exists(path.join(mobileDir, 'node_modules')),
    ])

    const result = spawnSync('/bin/bash', [buildScript], {
      cwd: desktopDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      env: createSandboxedTestEnvironment(fixtureRoot, {
        PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
        BASH_ENV: shellEnvironment,
        CI: options.ci ?? '',
        GITHUB_ACTIONS: options.githubActions ?? '',
        TEST_FAKE_BIN_DIR: fakeBinDir,
        MAC_TARGETS: 'zip',
        SIGN_BUILD: options.signBuild ?? '',
        CC_HAHA_SIGN_IDENTITY: options.signIdentity ?? '',
        CC_HAHA_LOCAL_UNSIGNED_BUILD: options.localUnsignedBuild ?? '',
        CSC_NAME: '',
        TEST_REPO_ROOT: fixtureRoot,
        TEST_NATIVE_BUILD_SCRIPT: path.resolve(import.meta.dirname, '../../native/cu-helper/build.sh'),
      }),
    })

    const installedAfter = await Promise.all([
      exists(path.join(fixtureRoot, 'node_modules')),
      exists(path.join(desktopDir, 'node_modules')),
      exists(path.join(adaptersDir, 'node_modules')),
      exists(path.join(mobileDir, 'node_modules')),
    ])
    const sidecarEnv = await readFile(path.join(fixtureRoot, 'sidecar-env.txt'), 'utf8')
      .then(value => value.split('\n').slice(0, -1), () => null)
    return {
      result,
      installedBefore,
      installedAfter,
      sidecarEnv,
      securityQueried: await exists(path.join(fixtureRoot, 'security-queried')),
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
}

function expectSidecarReached(result: ReturnType<typeof spawnSync>) {
  expect(result.status, [
    `status: ${String(result.status)}`,
    `signal: ${String(result.signal)}`,
    `spawn error: ${result.error?.stack ?? 'none'}`,
    `stdout: ${result.stdout || '<empty>'}`,
    `stderr: ${result.stderr || '<empty>'}`,
  ].join('\n')).toBe(86)
}

describe('macOS arm64 build dependency installation', () => {
  it('installs every package needed by the compiled sidecar in a clean worktree', async () => {
    const fixture = await runBuildFixture({ signBuild: '0' })
    expectSidecarReached(fixture.result)
    expect(fixture.installedBefore).toEqual([false, false, false, false])
    expect(fixture.installedAfter).toEqual([true, true, true, true])
  })
})

const developerId = 'Developer ID Application: Example Co., Ltd (D3RS24869F)'
const appleDevelopment = 'Apple Development: dev@example.com (F8ZSJJ78S7)'
const bothIdentities = `  1) ${'A'.repeat(40)} "${appleDevelopment}"
  2) ${'B'.repeat(40)} "${developerId}"
     2 valid identities found`

describe('macOS arm64 build signing discovery', () => {
  it.each([
    {
      name: 'prefers Developer ID even when Apple Development appears first',
      securityOutput: bothIdentities,
      identity: developerId,
      builderName: 'Example Co., Ltd (D3RS24869F)',
    },
    {
      name: 'continues with Apple Development when Developer ID is absent',
      securityOutput: `  1) ${'A'.repeat(40)} "${appleDevelopment}"\n     1 valid identities found`,
      identity: appleDevelopment,
      builderName: 'dev@example.com (F8ZSJJ78S7)',
    },
    {
      name: 'continues ad-hoc when there are no identities',
      securityOutput: '     0 valid identities found',
      identity: '-',
      builderName: '',
    },
    {
      name: 'continues ad-hoc when only an unrelated identity exists',
      securityOutput: `  1) ${'C'.repeat(40)} "cu-helper-dev"\n     1 valid identities found`,
      identity: '-',
      builderName: '',
    },
  ])('$name', async ({ securityOutput, identity, builderName }) => {
    const fixture = await runBuildFixture({ securityOutput })
    expectSidecarReached(fixture.result)
    expect(fixture.securityQueried).toBe(true)
    expect(fixture.sidecarEnv).toEqual([identity, builderName, identity === '-' ? '1' : ''])
    if (identity === '-') expect(fixture.result.stdout).toContain('No stable signing identity')
  })

  it('honors an explicit identity without querying the keychain', async () => {
    const fixture = await runBuildFixture({ signIdentity: appleDevelopment })
    expectSidecarReached(fixture.result)
    expect(fixture.securityQueried).toBe(false)
    expect(fixture.sidecarEnv).toEqual([appleDevelopment, 'dev@example.com (F8ZSJJ78S7)', ''])
  })

  it('skips keychain discovery when signing is explicitly disabled', async () => {
    const fixture = await runBuildFixture({ signBuild: '0', securityOutput: bothIdentities })
    expectSidecarReached(fixture.result)
    expect(fixture.securityQueried).toBe(false)
    expect(fixture.sidecarEnv).toEqual(['-', '', '1'])
    expect(fixture.result.stdout).toContain('SIGN_BUILD=0')
  })

  it('overrides a stale signing identity when explicitly building unsigned', async () => {
    const fixture = await runBuildFixture({ signBuild: '0', signIdentity: developerId })
    expectSidecarReached(fixture.result)
    expect(fixture.sidecarEnv).toEqual(['-', '', '1'])
  })

  it('clears a stale local unsigned flag when a stable identity is selected', async () => {
    const fixture = await runBuildFixture({
      signIdentity: developerId, localUnsignedBuild: '1', githubActions: 'true',
    })
    expectSidecarReached(fixture.result)
    expect(fixture.sidecarEnv).toEqual([developerId, 'Example Co., Ltd (D3RS24869F)', ''])
  })

  it.each([{ ci: 'true' }, { githubActions: 'true' }])('refuses unsigned packaging in CI: %j', async environment => {
    const fixture = await runBuildFixture(environment)
    expect(fixture.result.status).toBe(1)
    expect(fixture.result.stderr).toContain('CI requires a stable signing identity')
    expect(fixture.sidecarEnv).toBeNull()
  })
})
