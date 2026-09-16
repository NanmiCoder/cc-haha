import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const buildScript = path.resolve(import.meta.dirname, 'build.sh')
const productIcon = path.resolve(import.meta.dirname, '../../desktop/src-tauri/icons/icon.icns')
const fixtureDirectories: string[] = []
const resourceBundleName = 'cu-helper_cc-haha-computer-use.bundle'

function runFixtureCommand(command: string[], options: { cwd?: string, env?: Record<string, string | undefined> } = {}) {
  // File-backed output also works on Bun versions where test subprocesses
  // receive closed pipe descriptors (even /bin/echo exits 1 with no output).
  // Keep the real shell result and diagnostics; never turn that failure into a skip.
  const directory = mkdtempSync(path.join(tmpdir(), 'cu-helper-fixture-output-'))
  fixtureDirectories.push(directory)
  const stdout = path.join(directory, 'stdout')
  const stderr = path.join(directory, 'stderr')
  const result = Bun.spawnSync(command, {
    ...options,
    stdin: 'ignore', stdout: Bun.file(stdout), stderr: Bun.file(stderr),
  })
  return { exitCode: result.exitCode, stdout: readFileSync(stdout), stderr: readFileSync(stderr) }
}

function resolveArchitectureSpecificBuildPaths(arch: 'arm64' | 'x86_64') {
  const directory = mkdtempSync(path.join(tmpdir(), 'cu-helper-build-path-'))
  fixtureDirectories.push(directory)
  const binDir = path.join(directory, arch, `${arch}-apple-macosx`, 'release')
  const result = runFixtureCommand([
    'bash',
    '-c',
    `
source "$1"
ARCH="$2"
BUILD_DIR="$3"
SWIFT_SCRATCH_PATH="$BUILD_DIR/$ARCH"
EXPECTED_BIN_DIR="$4"
swift() {
  printf '%s\\n' "$EXPECTED_BIN_DIR"
}
resolve_build_paths
printf '%s\\n%s\\n%s\\n%s\\n' "$BIN_DIR" "$BIN_PATH" "$APP_PATH" "$RESOURCE_BUNDLE_PATH"
`,
    'cu-helper-build-path-test',
    buildScript,
    arch,
    directory,
    binDir,
  ])

  return {
    exitCode: result.exitCode,
    lines: result.stdout.toString().trim().split('\n'),
    stderr: result.stderr.toString(),
    binDir,
  }
}

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function wrapFixtureApp(options: { missingIcon?: boolean, missingResources?: boolean } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'cu-helper-app-icon-'))
  fixtureDirectories.push(directory)
  writeFileSync(path.join(directory, 'fixture-binary'), 'fixture executable')
  const resourceBundle = path.join(directory, resourceBundleName)
  if (!options.missingResources) {
    mkdirSync(path.join(resourceBundle, 'LensSequence'), { recursive: true })
    writeFileSync(path.join(resourceBundle, 'LensSequence', 'README.md'), 'optional frames fixture')
  }

  const result = runFixtureCommand([
    'bash',
    '-c',
    `
source "$1"
TEST_BUNDLE_DIR="$2"
BUILD_DIR="$TEST_BUNDLE_DIR/build"
BIN_PATH="$TEST_BUNDLE_DIR/fixture-binary"
RESOURCE_BUNDLE_PATH="$TEST_BUNDLE_DIR/cu-helper_cc-haha-computer-use.bundle"
APP_PATH="$TEST_BUNDLE_DIR/cc-haha-computer-use.app"
BUNDLE_ID="dev.cchaha.cu-helper"
SIGN_IDENTITY="fixture-only"
RESOLVED_TIMESTAMP_MODE="none"
if [ "$3" = "missing" ]; then
  APP_ICON_PATH="$TEST_BUNDLE_DIR/missing.icns"
fi
codesign() {
  case "$1" in
    --force) cp -R "$APP_PATH/Contents" "$TEST_BUNDLE_DIR/contents-at-sign" ;;
    -dv) printf 'Identifier=%s\\n' "$BUNDLE_ID" ;;
  esac
}
wrap_app
`,
    'cu-helper-app-icon-test',
    buildScript,
    directory,
    options.missingIcon ? 'missing' : 'present',
  ], { cwd: directory })

  return {
    directory,
    contents: path.join(directory, 'cc-haha-computer-use.app', 'Contents'),
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
  }
}

function probeFixtureApp(mode: 'packaged' | 'build-path' | 'external-symlink' | 'invalid-json' | 'crash', crossArch = false) {
  const directory = mkdtempSync(path.join(tmpdir(), 'cu-helper-resource-probe-'))
  fixtureDirectories.push(directory)
  const app = path.join(directory, 'source.app')
  const binary = path.join(app, 'Contents', 'MacOS', 'cc-haha-computer-use')
  mkdirSync(path.dirname(binary), { recursive: true })
  mkdirSync(path.join(app, 'Contents', 'Resources', resourceBundleName, 'LensSequence'), { recursive: true })
  writeFileSync(path.join(app, 'Contents', 'Resources', resourceBundleName, 'LensSequence', 'README.md'), 'optional frames fixture')
  const buildTreeResources = path.join(directory, 'build-tree', resourceBundleName, 'LensSequence')
  mkdirSync(buildTreeResources, { recursive: true })
  if (mode === 'external-symlink') {
    const lensDirectory = path.join(app, 'Contents', 'Resources', resourceBundleName, 'LensSequence')
    rmSync(lensDirectory, { recursive: true })
    symlinkSync(buildTreeResources, lensDirectory)
  }
  writeFileSync(path.join(app, 'Contents', 'Resources', 'outside-resource-path'), buildTreeResources)
  writeFileSync(binary, `#!/bin/bash
set -eu
[ "$1" = "--probe-cursor-resources" ] || exit 40
case '${mode}' in
  crash) exit 41 ;;
  invalid-json) printf 'not-json'; exit 0 ;;
  build-path) resource_dir="$(cat "$(dirname "$0")/../Resources/outside-resource-path")" ;;
  *) resource_dir="$(cd "$(dirname "$0")/../Resources/${resourceBundleName}/LensSequence" && pwd -P)" ;;
esac
printf '{"resourceDirectory":"%s","frameCount":0,"proceduralFallback":true}\\n' "$resource_dir"
`)
  chmodSync(binary, 0o755)
  const result = runFixtureCommand([
    'bash', '-c', `
source "$1"
APP_PATH="$2"
ARCH="$3"
uname() { printf 'arm64\\n'; }
verify_relocated_cursor_resources
`, 'cu-helper-resource-probe-test', buildScript, app,
    crossArch ? 'x86_64' : 'arm64',
  ], {
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory },
    cwd: directory,
  })
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    leftovers: readdirSync(directory).filter(name => name.startsWith('cc-haha-cursor-probe.')),
  }
}

function resolveTimestampArgument(identity: string, mode = 'auto') {
  const result = runFixtureCommand([
    'bash',
    '-c',
    [
      'source "$1"',
      'security() { return 1; }',
      'SIGN_IDENTITY="$2"',
      'CU_HELPER_TIMESTAMP_MODE="$3"',
      'resolve_timestamp_mode',
      'printf "%s" "$CODESIGN_TIMESTAMP_ARG"',
    ].join('; '),
    'cu-helper-build-test',
    buildScript,
    identity,
    mode,
  ])

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || `build.sh probe exited ${result.exitCode}`)
  }
  return result.stdout.toString()
}

function resolveIdentityWithOnlyDeveloperId() {
  const result = runFixtureCommand([
    'bash',
    '-c',
    [
      'source "$1"',
      'first_apple_development_identity() { return 1; }',
      'first_developer_id_application_identity() { printf "%s" "Developer ID Application: Example Corp (TEAM123456)"; }',
      'resolve_identity',
      'printf "%s" "$SIGN_IDENTITY"',
    ].join('; '),
    'cu-helper-build-test',
    buildScript,
  ])

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

describe('cu-helper build signing timestamp', () => {
  test('uses a secure timestamp for Developer ID distribution signatures', () => {
    expect(
      resolveTimestampArgument('Developer ID Application: Example Corp (TEAM123456)'),
    ).toBe('--timestamp')
  })

  test('keeps local Apple Development builds offline by default', () => {
    expect(
      resolveTimestampArgument('Apple Development: Developer (TEAM123456)'),
    ).toBe('--timestamp=none')
  })

  test('allows CI to require a secure timestamp explicitly', () => {
    expect(resolveTimestampArgument('0123456789ABCDEF', 'secure')).toBe('--timestamp')
  })
})

describe('cu-helper build signing identity', () => {
  test('falls through to Developer ID when no Apple Development identity exists', () => {
    const result = resolveIdentityWithOnlyDeveloperId()

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('Developer ID Application: Example Corp (TEAM123456)')
  })
})

describe('cu-helper architecture-specific build output', () => {
  test.each(['arm64', 'x86_64'] as const)(
    'resolves %s products from the matching SwiftPM bin directory',
    (arch) => {
      const result = resolveArchitectureSpecificBuildPaths(arch)
      expect(result.exitCode).toBe(0)
      expect(result.lines).toEqual([
        result.binDir,
        path.join(result.binDir, 'cc-haha-computer-use'),
        path.join(result.binDir, 'cc-haha-computer-use.app'),
        path.join(result.binDir, 'cu-helper_cc-haha-computer-use.bundle'),
      ])
    },
  )

  test('verifies the requested Mach-O architecture before signing', () => {
    const source = readFileSync(buildScript, 'utf8')
    expect(source).toContain('lipo "$BIN_PATH" -verify_arch "$ARCH"')
    expect(source.indexOf('lipo "$BIN_PATH" -verify_arch "$ARCH"'))
      .toBeLessThan(source.indexOf('\nsign() {'))
  })
})

describe.skipIf(process.platform !== 'darwin')('cu-helper permission-list app icon', () => {
  test('declares and bundles the product icon before signing the helper app', () => {
    const result = wrapFixtureApp()
    expect(result.exitCode).toBe(0)

    const plist = runFixtureCommand([
      '/usr/bin/plutil', '-convert', 'json', '-o', '-',
      path.join(result.contents, 'Info.plist'),
    ])
    expect(plist.exitCode).toBe(0)
    const info = JSON.parse(plist.stdout.toString())
    expect(info.CFBundleIdentifier).toBe('dev.cchaha.cu-helper')
    expect(info.CFBundleExecutable).toBe('cc-haha-computer-use')
    expect(info.CFBundleIconFile).toBe('icon.icns')

    const expectedIcon = readFileSync(productIcon)
    expect(expectedIcon.subarray(0, 4).toString()).toBe('icns')
    expect(readFileSync(path.join(result.contents, 'Resources', info.CFBundleIconFile)))
      .toEqual(expectedIcon)
    expect(readFileSync(path.join(result.directory, 'contents-at-sign', 'Resources', info.CFBundleIconFile)))
      .toEqual(expectedIcon)
  })

  test('refuses to sign an app when the required product icon is missing', () => {
    const result = wrapFixtureApp({ missingIcon: true })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('App icon not found')
    expect(existsSync(path.join(result.directory, 'contents-at-sign'))).toBe(false)
  })
})

describe('cu-helper packaged cursor resources', () => {
  test('copies the complete SwiftPM resource directory into standard Resources before signing', () => {
    const result = wrapFixtureApp()
    expect(result.exitCode).toBe(0)
    const relative = path.join('Resources', resourceBundleName, 'LensSequence', 'README.md')
    expect(readFileSync(path.join(result.contents, relative), 'utf8')).toBe('optional frames fixture')
    expect(readFileSync(path.join(result.directory, 'contents-at-sign', relative), 'utf8')).toBe('optional frames fixture')
    expect(existsSync(path.join(result.contents, 'MacOS', resourceBundleName))).toBe(false)
  })

  test('refuses to sign when the declared SwiftPM resource bundle was not produced', () => {
    const result = wrapFixtureApp({ missingResources: true })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('Cursor resource bundle not found')
    expect(existsSync(path.join(result.directory, 'contents-at-sign'))).toBe(false)
  })
})

describe.skipIf(process.platform !== 'darwin')('cu-helper relocated resource probe', () => {
  test('loads from the relocated app even when the optional frame directory has no PNGs', () => {
    const result = probeFixtureApp('packaged')
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('verified: relocated cursor resources')
    expect(result.leftovers).toEqual([])
  })

  test.each(['build-path', 'external-symlink', 'invalid-json', 'crash'] as const)('rejects %s instead of accepting a false resource-load success', mode => {
    const result = probeFixtureApp(mode)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('Cursor resource probe')
    if (mode === 'build-path') expect(result.stderr).toContain('instead of relocated package')
    if (mode === 'external-symlink') expect(result.stderr).toContain('outside relocated package')
    expect(result.leftovers).toEqual([])
  })

  test('reports cross-architecture execution as skipped without running the probe', () => {
    const result = probeFixtureApp('crash', true)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('skipped: cursor resource execution probe (target x86_64, host arm64)')
    expect(result.stderr).not.toContain('verified: relocated cursor resources')
    expect(result.leftovers).toEqual([])
  })
})
