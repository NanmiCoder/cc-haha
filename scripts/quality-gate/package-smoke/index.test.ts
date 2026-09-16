import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  currentPackageSmokeArch,
  currentPackageSmokePlatform,
} from './current'
import {
  inspectPackagedArtifacts as inspectPackage,
  parseCodesignMetadata,
  parseMachOMinimumMacosVersions,
  parsePackageSmokeArgs,
} from './index'

// These fixtures contain synthetic Mach-O headers, not runnable executables.
// Resource execution has dedicated cases below with an explicit runner.
function inspectPackagedArtifacts(rootDir: string, options: Parameters<typeof inspectPackage>[1]) {
  return inspectPackage(rootDir, { hostPlatform: 'linux', ...options })
}

function createRepoRoot() {
  const rootDir = mkdtempSync(join(tmpdir(), 'package-smoke-'))
  mkdirSync(join(rootDir, 'desktop'), { recursive: true })
  writeFileSync(
    join(rootDir, 'desktop', 'package.json'),
    JSON.stringify({
      name: 'claude-code-desktop',
      version: '0.3.1',
      build: {
        productName: 'Claude Code Haha',
      },
    }, null, 2),
  )
  return rootDir
}

function writeFile(rootDir: string, relativePath: string, content: string | Uint8Array = 'ok') {
  const fullPath = join(rootDir, relativePath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content)

  const fileName = basename(fullPath)
  if (fileName.startsWith('claude-sidecar-')) {
    const ripgrepName = fileName.endsWith('.exe') ? 'rg.exe' : 'rg'
    writeFileSync(join(dirname(fullPath), ripgrepName), content)
    writeFileSync(
      join(dirname(fullPath), 'ripgrep-manifest.json'),
      JSON.stringify({ targetTriple: fileName.replace(/^claude-sidecar-/, '').replace(/\.exe$/, '') }),
    )
    const licensesDir = join(dirname(fullPath), 'ripgrep-licenses')
    mkdirSync(licensesDir, { recursive: true })
    for (const licenseName of ['COPYING', 'LICENSE-MIT', 'UNLICENSE']) {
      writeFileSync(join(licensesDir, licenseName), content)
    }
    if (fileName.includes('apple-darwin')) {
      const helperRoot = join(dirname(fullPath), 'cc-haha-computer-use.app', 'Contents')
      mkdirSync(join(helperRoot, 'MacOS'), { recursive: true })
      writeFileSync(
        join(helperRoot, 'Info.plist'),
        '<plist><dict><key>LSMinimumSystemVersion</key><string>14.4</string></dict></plist>',
      )
      writeFileSync(join(helperRoot, 'MacOS', 'cc-haha-computer-use'), content)
      const sequence = join(helperRoot, 'Resources', 'cu-helper_cc-haha-computer-use.bundle', 'LensSequence')
      mkdirSync(sequence, { recursive: true })
      writeFileSync(join(sequence, 'README.md'), 'Optional cursor frames are absent in this fixture.')
    }
  }
}

function thinMachO(arch: 'arm64' | 'x64', minimum = '14.4') {
  const [major, minor, patch = 0] = minimum.split('.').map(Number)
  const encodedMinimum = (major << 16) | (minor << 8) | patch
  const bytes = Buffer.alloc(56)
  bytes.writeUInt32LE(0xfeedfacf, 0)
  bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
  bytes.writeUInt32LE(2, 12)
  bytes.writeUInt32LE(1, 16)
  bytes.writeUInt32LE(24, 20)
  bytes.writeUInt32LE(0x32, 32)
  bytes.writeUInt32LE(24, 36)
  bytes.writeUInt32LE(1, 40)
  bytes.writeUInt32LE(encodedMinimum, 44)
  bytes.writeUInt32LE(15 << 16, 48)
  return bytes
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('package smoke args', () => {
  test('requires a supported platform value', () => {
    expect(() => parsePackageSmokeArgs([])).toThrow('--platform')
    expect(() => parsePackageSmokeArgs(['--platform', 'android'])).toThrow('macos|windows|linux')
    expect(() => parsePackageSmokeArgs(['--platform', 'windows', '--arch', 'ia32'])).toThrow('x64|arm64')
    expect(() => parsePackageSmokeArgs(['--platform', 'macos', '--package-kind', 'installer'])).toThrow('auto|dir|release')
    expect(parsePackageSmokeArgs(['--platform', 'macos']).platform).toBe('macos')
    expect(parsePackageSmokeArgs(['--platform', 'windows', '--arch', 'arm64']).arch).toBe('arm64')
    expect(parsePackageSmokeArgs(['--platform', 'macos']).packageKind).toBe('auto')
    expect(parsePackageSmokeArgs(['--platform', 'macos', '--package-kind', 'dir']).packageKind).toBe('dir')
    expect(parsePackageSmokeArgs(['--platform', 'macos', '--require-macos-gatekeeper']).requireMacosGatekeeper).toBe(true)
  })

  test('maps host platforms to current package-smoke platforms', () => {
    expect(currentPackageSmokePlatform('darwin')).toBe('macos')
    expect(currentPackageSmokePlatform('win32')).toBe('windows')
    expect(currentPackageSmokePlatform('linux')).toBe('linux')
    expect(currentPackageSmokePlatform('freebsd')).toBeNull()
    expect(currentPackageSmokeArch('arm64')).toBe('arm64')
    expect(currentPackageSmokeArch('x64')).toBe('x64')
    expect(currentPackageSmokeArch('ia32')).toBeNull()
  })

  test('reads the helper deployment target from the Mach-O load commands', () => {
    expect(parseMachOMinimumMacosVersions(thinMachO('arm64', '14.4'))).toEqual(['14.4'])
    expect(parseMachOMinimumMacosVersions(thinMachO('x64', '14.0'))).toEqual(['14.0'])
    expect(parseMachOMinimumMacosVersions(Buffer.from('not Mach-O'))).toEqual([])
  })

  test('reads the identity fields required by Computer Use client attestation', () => {
    expect(parseCodesignMetadata([
      'Identifier=dev.cchaha.cu-helper',
      'Authority=Developer ID Application: Example (TEAM123456)',
      'Authority=Developer ID Certification Authority',
      'Timestamp=Sep 1, 2026 at 18:43:53',
      'TeamIdentifier=TEAM123456',
    ].join('\n'))).toEqual({
      identifier: 'dev.cchaha.cu-helper',
      authority: 'Developer ID Application: Example (TEAM123456)',
      team: 'TEAM123456',
      timestamp: 'Sep 1, 2026 at 18:43:53',
    })
  })
})

describe('final macOS helper cursor resource verification', () => {
  const executionLabel = 'macOS relocated cu-helper cursor resource execution'
  const structureLabel = 'macOS cu-helper cursor resource directory'
  const sequenceRelative = 'Contents/Resources/cu-helper_cc-haha-computer-use.bundle/LensSequence'

  function fixture(arch: 'arm64' | 'x64' = 'arm64') {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)
    const app = 'desktop/build-artifacts/electron/mac/Claude Code Haha.app'
    const resources = `${app}/Contents/Resources`
    const binaries = `${resources}/app.asar.unpacked/src-tauri/binaries`
    const triple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
    const pty = `${resources}/app.asar.unpacked/node_modules/node-pty`
    writeFile(rootDir, `${app}/Contents/Info.plist`)
    writeFile(rootDir, `${app}/Contents/MacOS/Claude Code Haha`, thinMachO(arch))
    writeFile(rootDir, `${resources}/app.asar`)
    writeFile(rootDir, `${resources}/app.asar.unpacked/dist/index.html`)
    writeFile(rootDir, `${binaries}/claude-sidecar-${triple}`, thinMachO(arch))
    writeFile(rootDir, `${pty}/package.json`)
    writeFile(rootDir, `${pty}/prebuilds/darwin-${arch}/pty.node`, thinMachO(arch))
    writeFile(rootDir, `${pty}/prebuilds/darwin-${arch}/spawn-helper`, thinMachO(arch))
    const helper = join(rootDir, binaries, 'cc-haha-computer-use.app')
    return { rootDir, helper, sequence: join(helper, sequenceRelative) }
  }

  test.each(['arm64', 'x64'] as const)('executes the %s final helper from a disposable standalone path with isolated state', async arch => {
    const source = fixture(arch)
    let temporaryRoot = ''
    const report = await inspectPackage(source.rootDir, {
      platform: 'macos', arch, packageKind: 'dir', hostPlatform: 'macos', hostArch: arch,
      commandRunner: (command, args, options) => {
        expect(args).toEqual(['--probe-cursor-resources'])
        expect(command.startsWith(source.helper)).toBe(false)
        expect(command).toContain('Relocated Helper.app/Contents/MacOS/cc-haha-computer-use')
        expect(options?.timeout).toBe(10_000)
        expect(options?.maxBuffer).toBe(1024 * 1024)
        temporaryRoot = options!.cwd
        expect(options?.env.HOME).toBe(join(temporaryRoot, 'home'))
        expect(options?.env.CFFIXED_USER_HOME).toBe(options?.env.HOME)
        expect(options?.env.CLAUDE_CONFIG_DIR).toBe(join(temporaryRoot, 'home', '.claude'))
        expect(options?.env.OPENAI_API_KEY).toBeUndefined()
        const resourceDirectory = join(dirname(dirname(command)), 'Resources/cu-helper_cc-haha-computer-use.bundle/LensSequence')
        expect(existsSync(join(resourceDirectory, 'README.md'))).toBe(true)
        return { status: 0, stdout: JSON.stringify({ resourceDirectory, frameCount: 0, proceduralFallback: true }) }
      },
    })
    expect(report.passed).toBe(true)
    expect(report.passedChecks.some(check => check.label === executionLabel)).toBe(true)
    expect(existsSync(temporaryRoot)).toBe(false)
    expect(existsSync(source.sequence)).toBe(true)
  })

  test.each(['missing', 'file', 'external-symlink', 'external-frame-symlink'] as const)('rejects a final package with %s cursor resources before any execution', async mode => {
    const source = fixture()
    let executed = false
    if (mode !== 'external-frame-symlink') rmSync(source.sequence, { recursive: true })
    if (mode === 'file') writeFileSync(source.sequence, 'not a directory')
    if (mode === 'external-symlink') symlinkSync(source.rootDir, source.sequence, 'dir')
    if (mode === 'external-frame-symlink') {
      const external = join(source.rootDir, 'build-tree-frame.png')
      writeFileSync(external, 'outside the packaged helper')
      symlinkSync(external, join(source.sequence, 'frame_0.png'))
    }
    const report = await inspectPackage(source.rootDir, {
      platform: 'macos', arch: 'arm64', packageKind: 'dir', hostPlatform: 'macos', hostArch: 'arm64',
      commandRunner: () => { executed = true; throw new Error('must not run an invalid package') },
    })
    expect(executed).toBe(false)
    expect(report.passed).toBe(false)
    expect(report.missingChecks.some(check => check.label === structureLabel)).toBe(true)
    expect(report.passedChecks.some(check => check.label === executionLabel)).toBe(false)
  })

  test.each(['crash', 'invalid-json', 'external-directory', 'invalid-frames'] as const)('fails the final package when the resource diagnostic reports %s', async mode => {
    const source = fixture()
    let temporaryRoot = ''
    const report = await inspectPackage(source.rootDir, {
      platform: 'macos', arch: 'arm64', packageKind: 'dir', hostPlatform: 'macos', hostArch: 'arm64',
      commandRunner: (command, _args, options) => {
        temporaryRoot = options!.cwd
        if (mode === 'crash') return { status: null, stderr: 'terminated by signal' }
        if (mode === 'invalid-json') return { status: 0, stdout: 'not JSON' }
        const resourceDirectory = mode === 'external-directory' ? source.sequence
          : join(dirname(dirname(command)), 'Resources/cu-helper_cc-haha-computer-use.bundle/LensSequence')
        return { status: 0, stdout: JSON.stringify({
          resourceDirectory, frameCount: mode === 'invalid-frames' ? -1 : 0, proceduralFallback: true,
        }) }
      },
    })
    expect(report.passed).toBe(false)
    expect(report.missingChecks.some(check => check.label === executionLabel)).toBe(true)
    expect(existsSync(temporaryRoot)).toBe(false)
  })

  test.each([
    { platform: 'macos', arch: 'arm64', note: 'target x86_64, host arm64' },
    { platform: 'linux', arch: 'x64', note: 'host platform is linux' },
  ])('records a skipped execution on $platform/$arch without counting it as a passed probe', async host => {
    const source = fixture('x64')
    let executed = false
    const report = await inspectPackage(source.rootDir, {
      platform: 'macos', arch: 'x64', packageKind: 'dir', hostPlatform: host.platform, hostArch: host.arch,
      commandRunner: () => { executed = true; return { status: 1 } },
    })
    expect(report.passed).toBe(true)
    expect(executed).toBe(false)
    expect(report.passedChecks.some(check => check.label === executionLabel)).toBe(false)
    expect(report.notes.join('\n')).toContain(`SKIPPED: ${executionLabel}`)
    expect(report.notes.join('\n')).toContain(host.note)
  })
})

describe('packaged artifact inspection', () => {
  test('passes macOS bundle structure checks and records optional archive artifacts', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Info.plist')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/MacOS/Claude Code Haha')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app-update.yml')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/dist/index.html')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-aarch64-apple-darwin')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')
    writeFile(rootDir, 'desktop/build-artifacts/electron/Claude-Code-Haha-0.3.1-arm64.zip')
    writeFile(rootDir, 'desktop/build-artifacts/electron/Claude-Code-Haha-0.3.1-arm64.zip.blockmap')
    writeFile(rootDir, 'desktop/build-artifacts/electron/Claude-Code-Haha-0.3.1-arm64.dmg')
    writeFile(rootDir, 'desktop/build-artifacts/electron/Claude-Code-Haha-0.3.1-arm64.dmg.blockmap')
    writeFile(rootDir, 'desktop/build-artifacts/electron/latest-mac.yml', [
      'version: 0.3.1',
      'files:',
      '  - url: Claude-Code-Haha-0.3.1-arm64.zip',
      '  - url: Claude-Code-Haha-0.3.1-arm64.dmg',
      'path: Claude-Code-Haha-0.3.1-arm64.zip',
    ].join('\n'))

    const report = await inspectPackagedArtifacts(rootDir, { platform: 'macos' })

    expect(report.passed).toBe(true)
    expect(report.verificationMode).toBe('bundle-structure')
    expect(report.notes.join('\n')).toContain('No GUI launch was attempted.')
    expect(report.optionalArtifacts.some((artifact) => artifact.path.endsWith('.zip'))).toBe(true)
    expect(report.optionalArtifacts.some((artifact) => artifact.path.endsWith('.dmg'))).toBe(true)
    expect(report.optionalArtifacts.some((artifact) => artifact.path.endsWith('latest-mac.yml'))).toBe(true)
    expect(report.passedChecks.some((check) => check.label.includes('update metadata referenced artifact'))).toBe(true)
    expect(report.passedChecks.some((check) => check.label.includes('macOS update artifact blockmap'))).toBe(true)
    expect(report.passedChecks.some((check) => check.label === 'macOS unpacked H5 shell')).toBe(true)
  })

  test('fails macOS inspection when bundled ripgrep is missing', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)
    const appRoot = 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app'
    const sidecarRoot = `${appRoot}/Contents/Resources/app.asar.unpacked/src-tauri/binaries`

    writeFile(rootDir, `${appRoot}/Contents/Info.plist`)
    writeFile(rootDir, `${appRoot}/Contents/MacOS/Claude Code Haha`)
    writeFile(rootDir, `${appRoot}/Contents/Resources/app.asar`)
    writeFile(rootDir, `${appRoot}/Contents/Resources/app.asar.unpacked/dist/index.html`)
    writeFile(rootDir, `${sidecarRoot}/claude-sidecar-aarch64-apple-darwin`)
    writeFile(rootDir, `${appRoot}/Contents/Resources/app.asar.unpacked/node_modules/node-pty/package.json`)
    writeFile(rootDir, `${appRoot}/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node`)
    writeFile(rootDir, `${appRoot}/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`)
    rmSync(join(rootDir, sidecarRoot, 'rg'))

    const report = await inspectPackagedArtifacts(rootDir, {
      platform: 'macos',
      arch: 'arm64',
      packageKind: 'dir',
    })

    expect(report.passed).toBe(false)
    expect(report.missingChecks.some(
      check => check.label === 'macOS bundled ripgrep binary',
    )).toBe(true)
  })

  test('fails closed when an arm64 package contains an x64 cu-helper', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)
    const appRoot = 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app'
    const resources = `${appRoot}/Contents/Resources`
    const sidecarRoot = `${resources}/app.asar.unpacked/src-tauri/binaries`
    const nodePtyRoot = `${resources}/app.asar.unpacked/node_modules/node-pty`

    writeFile(rootDir, `${appRoot}/Contents/Info.plist`)
    writeFile(rootDir, `${appRoot}/Contents/MacOS/Claude Code Haha`, thinMachO('arm64'))
    writeFile(rootDir, `${resources}/app.asar`)
    writeFile(rootDir, `${resources}/app.asar.unpacked/dist/index.html`)
    writeFile(rootDir, `${sidecarRoot}/claude-sidecar-aarch64-apple-darwin`, thinMachO('arm64'))
    writeFile(rootDir, `${nodePtyRoot}/package.json`)
    writeFile(rootDir, `${nodePtyRoot}/prebuilds/darwin-arm64/pty.node`, thinMachO('arm64'))
    writeFile(rootDir, `${nodePtyRoot}/prebuilds/darwin-arm64/spawn-helper`, thinMachO('arm64'))

    const validReport = await inspectPackagedArtifacts(rootDir, {
      platform: 'macos',
      arch: 'arm64',
      packageKind: 'dir',
    })
    expect(validReport.passed).toBe(true)

    writeFile(
      rootDir,
      `${sidecarRoot}/cc-haha-computer-use.app/Contents/MacOS/cc-haha-computer-use`,
      thinMachO('x64'),
    )

    const report = await inspectPackagedArtifacts(rootDir, {
      platform: 'macos',
      arch: 'arm64',
      packageKind: 'dir',
    })

    expect(report.passed).toBe(false)
    expect(report.missingChecks.some(
      check => check.label === 'macOS arm64 cu-helper Mach-O architecture',
    )).toBe(true)
    expect(report.notes.join('\n')).toContain('expected arm64, found x86_64')
  })

  test('fails closed when the helper Mach-O deployment target drifts below 14.4', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)
    const appRoot = 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app'
    const resources = `${appRoot}/Contents/Resources`
    const sidecarRoot = `${resources}/app.asar.unpacked/src-tauri/binaries`
    const nodePtyRoot = `${resources}/app.asar.unpacked/node_modules/node-pty`

    writeFile(rootDir, `${appRoot}/Contents/Info.plist`)
    writeFile(rootDir, `${appRoot}/Contents/MacOS/Claude Code Haha`, thinMachO('arm64'))
    writeFile(rootDir, `${resources}/app.asar`)
    writeFile(rootDir, `${resources}/app.asar.unpacked/dist/index.html`)
    writeFile(rootDir, `${sidecarRoot}/claude-sidecar-aarch64-apple-darwin`, thinMachO('arm64'))
    writeFile(rootDir, `${nodePtyRoot}/package.json`)
    writeFile(rootDir, `${nodePtyRoot}/prebuilds/darwin-arm64/pty.node`, thinMachO('arm64'))
    writeFile(rootDir, `${nodePtyRoot}/prebuilds/darwin-arm64/spawn-helper`, thinMachO('arm64'))
    writeFile(
      rootDir,
      `${sidecarRoot}/cc-haha-computer-use.app/Contents/MacOS/cc-haha-computer-use`,
      thinMachO('arm64', '14.0'),
    )

    const report = await inspectPackagedArtifacts(rootDir, {
      platform: 'macos',
      arch: 'arm64',
      packageKind: 'dir',
    })

    expect(report.passed).toBe(false)
    expect(report.missingChecks.some(
      check => check.label === 'macOS cu-helper Mach-O deployment target (14.4)',
    )).toBe(true)
    expect(report.notes.join('\n')).toContain('expected 14.4, found 14.0')
  })

  test('fails macOS inspection when the H5 shell is not unpacked for the sidecar', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Info.plist')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/MacOS/Claude Code Haha')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app-update.yml')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-aarch64-apple-darwin')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')

    const report = await inspectPackagedArtifacts(rootDir, { platform: 'macos', packageKind: 'dir' })

    expect(report.passed).toBe(false)
    expect(report.missingChecks.some((check) => check.label === 'macOS unpacked H5 shell')).toBe(true)
  })

  test('fails macOS archive checks when latest-mac.yml points at missing assets', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Info.plist')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/MacOS/Claude Code Haha')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app-update.yml')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-aarch64-apple-darwin')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')
    writeFile(rootDir, 'desktop/build-artifacts/electron/Claude Code Haha-0.3.1-arm64-mac.zip')
    writeFile(rootDir, 'desktop/build-artifacts/electron/latest-mac.yml', 'path: Claude-Code-Haha-0.3.1-arm64-mac.zip\n')

    const report = await inspectPackagedArtifacts(rootDir, { platform: 'macos' })

    expect(report.passed).toBe(false)
    expect(report.missingChecks.some((check) => check.label.includes('update metadata referenced artifact'))).toBe(true)
  })

  test('fails macOS inspection when the installed updater metadata is missing from Resources', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Info.plist')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/MacOS/Claude Code Haha')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-aarch64-apple-darwin')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')
    writeFile(rootDir, 'desktop/build-artifacts/electron/Claude-Code-Haha-0.3.1-arm64.zip')
    writeFile(rootDir, 'desktop/build-artifacts/electron/latest-mac.yml', [
      'version: 0.3.1',
      'files:',
      '  - url: Claude-Code-Haha-0.3.1-arm64.zip',
      'path: Claude-Code-Haha-0.3.1-arm64.zip',
    ].join('\n'))

    const report = await inspectPackagedArtifacts(rootDir, { platform: 'macos' })

    expect(report.passed).toBe(false)
    expect(report.missingChecks.some((check) => check.label === 'macOS app-update.yml')).toBe(true)
  })

  test('fails release inspection when an update artifact blockmap is missing', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Info.plist')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/MacOS/Claude Code Haha')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app-update.yml')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-aarch64-apple-darwin')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')
    writeFile(rootDir, 'desktop/build-artifacts/electron/Claude-Code-Haha-0.3.1-arm64.zip')
    writeFile(rootDir, 'desktop/build-artifacts/electron/latest-mac.yml', 'path: Claude-Code-Haha-0.3.1-arm64.zip\n')

    const report = await inspectPackagedArtifacts(rootDir, { platform: 'macos', packageKind: 'release' })

    expect(report.passed).toBe(false)
    expect(report.missingChecks.some((check) => check.label.includes('macOS update artifact blockmap'))).toBe(true)
  })

  test('adds codesign diagnostics when macOS Gatekeeper assessment fails', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Info.plist')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/MacOS/Claude Code Haha')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-aarch64-apple-darwin')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')

    const report = await inspectPackagedArtifacts(rootDir, {
      platform: 'macos',
      packageKind: 'dir',
      requireMacosGatekeeper: true,
      hostPlatform: 'macos',
      commandRunner: (command, args) => {
        if (command.endsWith('/spctl')) {
          return { status: 1, stdout: '', stderr: 'rejected\nsource=Unnotarized Developer ID\n' }
        }
        if (command.endsWith('/codesign')) {
          return { status: 1, stdout: '', stderr: 'code object is not signed at all\n' }
        }
        if (command.endsWith('/xcrun') && args[0] === 'stapler') {
          return { status: 65, stdout: '', stderr: 'The validate action failed!\n' }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
    })

    expect(report.passed).toBe(false)
    expect(report.missingChecks.some((check) => check.label.includes('macOS Gatekeeper launch approval'))).toBe(true)
    expect(report.notes.join('\n')).toContain('spctl Gatekeeper assessment exited with status 1')
    expect(report.notes.join('\n')).toContain('codesign verification exited with status 1')
    expect(report.notes.join('\n')).toContain('codesign signature details exited with status 1')
    expect(report.notes.join('\n')).toContain('notarization ticket validation exited with status 65')
  })

  test('requires one Developer ID signer across host, sidecar, and helper', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)
    const appRoot = 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app'
    const resources = `${appRoot}/Contents/Resources`
    const sidecarRoot = `${resources}/app.asar.unpacked/src-tauri/binaries`
    const nodePtyRoot = `${resources}/app.asar.unpacked/node_modules/node-pty`
    writeFile(rootDir, `${appRoot}/Contents/Info.plist`)
    writeFile(rootDir, `${appRoot}/Contents/MacOS/Claude Code Haha`, thinMachO('arm64'))
    writeFile(rootDir, `${resources}/app.asar`)
    writeFile(rootDir, `${resources}/app.asar.unpacked/dist/index.html`)
    writeFile(rootDir, `${sidecarRoot}/claude-sidecar-aarch64-apple-darwin`, thinMachO('arm64'))
    writeFile(rootDir, `${nodePtyRoot}/package.json`)
    writeFile(rootDir, `${nodePtyRoot}/prebuilds/darwin-arm64/pty.node`, thinMachO('arm64'))
    writeFile(rootDir, `${nodePtyRoot}/prebuilds/darwin-arm64/spawn-helper`, thinMachO('arm64'))

    const inspect = (sidecarAuthority: string) => inspectPackagedArtifacts(rootDir, {
      platform: 'macos',
      arch: 'arm64',
      packageKind: 'dir',
      requireMacosGatekeeper: true,
      hostPlatform: 'macos',
      commandRunner: (command, args) => {
        if (command.endsWith('/spctl')) return { status: 0, stdout: 'accepted', stderr: '' }
        if (command.endsWith('/codesign') && args[0] === '--verify') {
          return { status: 0, stdout: '', stderr: '' }
        }
        if (command.endsWith('/codesign') && args[0] === '-dv') {
          const target = args.at(-1) ?? ''
          const isSidecar = target.includes('claude-sidecar-')
          const identifier = target.endsWith('cc-haha-computer-use.app')
            ? 'dev.cchaha.cu-helper'
            : isSidecar
              ? 'com.claude-code-haha.desktop.sidecar'
              : 'com.claude-code-haha.desktop'
          const authority = isSidecar
            ? sidecarAuthority
            : 'Developer ID Application: Example (TEAM123456)'
          return {
            status: 0,
            stdout: '',
            stderr: [
              `Identifier=${identifier}`,
              `Authority=${authority}`,
              'Timestamp=Sep 1, 2026 at 18:43:53',
              'TeamIdentifier=TEAM123456',
            ].join('\n'),
          }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
    })

    const valid = await inspect('Developer ID Application: Example (TEAM123456)')
    expect(valid.passedChecks.some(
      check => check.label === 'macOS Computer Use signing attestation chain',
    )).toBe(true)

    const mismatched = await inspect('Developer ID Application: Other (TEAM123456)')
    expect(mismatched.passed).toBe(false)
    expect(mismatched.notes.join('\n')).toContain('mismatched Developer ID authority/team')
  })

  test('retries macOS Gatekeeper assessment with a raised file limit when spctl hits open-file limits', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Info.plist')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/MacOS/Claude Code Haha')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-aarch64-apple-darwin')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')

    const commands: string[] = []
    const report = await inspectPackagedArtifacts(rootDir, {
      platform: 'macos',
      packageKind: 'dir',
      requireMacosGatekeeper: true,
      hostPlatform: 'macos',
      commandRunner: (command, args) => {
        commands.push(`${command} ${args.join(' ')}`)
        if (command.endsWith('/spctl')) {
          return { status: 1, stdout: '', stderr: 'Too many open files\n' }
        }
        if (command.endsWith('/zsh')) {
          return { status: 1, stdout: '', stderr: 'bundle format unrecognized, invalid, or unsuitable\n' }
        }
        if (command.endsWith('/codesign')) {
          return { status: 0, stdout: '', stderr: 'valid on disk\n' }
        }
        if (command.endsWith('/xcrun') && args[0] === 'stapler') {
          return { status: 65, stdout: '', stderr: 'does not have a ticket stapled to it\n' }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
    })

    expect(report.passed).toBe(false)
    expect(commands.some(command => command.startsWith('/bin/zsh -lc ulimit -n'))).toBe(true)
    expect(report.missingChecks.some((check) => check.label.includes('bundle format unrecognized'))).toBe(true)
    expect(report.notes.join('\n')).toContain('retried with a raised file descriptor limit')
    expect(report.notes.join('\n')).toContain('spctl Gatekeeper assessment exited with status 1: bundle format unrecognized')
  })

  test('treats Windows checks as static inspection on non-Windows hosts', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/electron/Claude Code Haha Setup 0.3.1.exe')
    writeFile(rootDir, 'desktop/build-artifacts/electron/Claude Code Haha Setup 0.3.1.exe.blockmap')
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app-update.yml')
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-x86_64-pc-windows-msvc.exe')
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/pty.node')
    writeFile(rootDir, 'desktop/build-artifacts/electron/latest.yml', 'path: Claude Code Haha Setup 0.3.1.exe\n')

    const report = await inspectPackagedArtifacts(rootDir, { platform: 'windows' })

    expect(report.passed).toBe(true)
    expect(report.verificationMode).toBe('static-artifact')
    expect(report.notes.join('\n')).toContain('not claim installer execution or app launch success')
  })

  test('passes Windows checks against the canonical build script output directory', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/windows-x64/Claude-Code-Haha-0.3.1-x64.exe')
    writeFile(rootDir, 'desktop/build-artifacts/windows-x64/Claude-Code-Haha-0.3.1-x64.exe.blockmap')
    writeFile(rootDir, 'desktop/build-artifacts/windows-x64/win-unpacked/resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/windows-x64/win-unpacked/resources/app-update.yml')
    writeFile(rootDir, 'desktop/build-artifacts/windows-x64/win-unpacked/resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-x86_64-pc-windows-msvc.exe')
    writeFile(rootDir, 'desktop/build-artifacts/windows-x64/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/windows-x64/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/pty.node')
    writeFile(rootDir, 'desktop/build-artifacts/windows-x64/latest.yml', 'path: Claude-Code-Haha-0.3.1-x64.exe\n')

    const report = await inspectPackagedArtifacts(rootDir, {
      platform: 'windows',
      arch: 'x64',
      packageKind: 'release',
      artifactsDir: 'desktop/build-artifacts/windows-x64',
    })

    expect(report.passed).toBe(true)
    expect(report.artifactsDir.endsWith('desktop/build-artifacts/windows-x64')).toBe(true)
  })

  test('passes Windows arm64 checks only when arm64 sidecar and node-pty native module are present', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/Claude-Code-Haha-0.3.1-arm64.exe')
    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/Claude-Code-Haha-0.3.1-arm64.exe.blockmap')
    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/win-arm64-unpacked/resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/win-arm64-unpacked/resources/app-update.yml')
    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/win-arm64-unpacked/resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-aarch64-pc-windows-msvc.exe')
    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/win-arm64-unpacked/resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/win-arm64-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-arm64/pty.node')
    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/latest.yml', 'path: Claude-Code-Haha-0.3.1-arm64.exe\n')

    const report = await inspectPackagedArtifacts(rootDir, {
      platform: 'windows',
      arch: 'arm64',
      packageKind: 'release',
      artifactsDir: 'desktop/build-artifacts/windows-arm64',
    })

    expect(report.passed).toBe(true)
    expect(report.passedChecks.some((check) => check.label === 'Windows arm64 unpacked sidecar binary')).toBe(true)
    expect(report.passedChecks.some((check) => check.label === 'Windows arm64 node-pty native module')).toBe(true)
  })

  test('fails Windows arm64 checks when the package only contains x64 native files', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/Claude-Code-Haha-0.3.1-arm64.exe')
    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/Claude-Code-Haha-0.3.1-arm64.exe.blockmap')
    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/win-arm64-unpacked/resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/win-arm64-unpacked/resources/app-update.yml')
    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/win-arm64-unpacked/resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-x86_64-pc-windows-msvc.exe')
    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/win-arm64-unpacked/resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/win-arm64-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/pty.node')
    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/latest.yml', 'path: Claude-Code-Haha-0.3.1-arm64.exe\n')

    const report = await inspectPackagedArtifacts(rootDir, {
      platform: 'windows',
      arch: 'arm64',
      packageKind: 'release',
      artifactsDir: 'desktop/build-artifacts/windows-arm64',
    })

    expect(report.passed).toBe(false)
    expect(report.missingChecks.some((check) => check.label === 'Windows arm64 unpacked sidecar binary')).toBe(true)
    expect(report.missingChecks.some((check) => check.label === 'Windows arm64 node-pty native module')).toBe(true)
  })

  test('passes Windows directory-only checks for electron-builder --dir output', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/Claude Code Haha.exe')
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-x86_64-pc-windows-msvc.exe')
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/pty.node')

    const report = await inspectPackagedArtifacts(rootDir, { platform: 'windows', packageKind: 'dir' })

    expect(report.passed).toBe(true)
    expect(report.notes.join('\n')).toContain('directory-only development package')
    expect(report.notes.join('\n')).toContain('Windows app-update.yml was not required')
  })

  test('does not treat the win-unpacked app executable as a Windows release installer', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/Claude Code Haha.exe')
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app-update.yml')
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-x86_64-pc-windows-msvc.exe')
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/pty.node')

    const report = await inspectPackagedArtifacts(rootDir, { platform: 'windows', packageKind: 'release' })

    expect(report.passed).toBe(false)
    expect(report.missingChecks.some((check) => check.label.includes('.exe installer'))).toBe(true)
  })

  test('does not treat win-arm64-unpacked executables as Windows release installers', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/win-arm64-unpacked/Claude Code Haha.exe')
    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/win-arm64-unpacked/resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/win-arm64-unpacked/resources/app-update.yml')
    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/win-arm64-unpacked/resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-aarch64-pc-windows-msvc.exe')
    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/win-arm64-unpacked/resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/windows-arm64/win-arm64-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-arm64/pty.node')

    const report = await inspectPackagedArtifacts(rootDir, {
      platform: 'windows',
      arch: 'arm64',
      packageKind: 'release',
      artifactsDir: 'desktop/build-artifacts/windows-arm64',
    })

    expect(report.passed).toBe(false)
    expect(report.packagedArtifacts.some((artifact) => artifact.path.includes('win-arm64-unpacked'))).toBe(false)
    expect(report.missingChecks.some((check) => check.label.includes('.exe installer'))).toBe(true)
  })

  test('passes Linux checks against the canonical build script output directory', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/linux-x64/Claude-Code-Haha-0.3.1-x64.AppImage')
    writeFile(rootDir, 'desktop/build-artifacts/linux-x64/Claude-Code-Haha-0.3.1-x64.AppImage.blockmap')
    writeFile(rootDir, 'desktop/build-artifacts/linux-x64/claude-code-desktop_0.3.1_amd64.deb')
    writeFile(rootDir, 'desktop/build-artifacts/linux-x64/linux-unpacked/resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/linux-x64/linux-unpacked/resources/app-update.yml')
    writeFile(rootDir, 'desktop/build-artifacts/linux-x64/linux-unpacked/resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-x86_64-unknown-linux-gnu')
    writeFile(rootDir, 'desktop/build-artifacts/linux-x64/linux-unpacked/resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/linux-x64/linux-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/linux-x64/pty.node')
    writeFile(rootDir, 'desktop/build-artifacts/linux-x64/latest-linux.yml', 'path: Claude-Code-Haha-0.3.1-x64.AppImage\n')

    const report = await inspectPackagedArtifacts(rootDir, {
      platform: 'linux',
      packageKind: 'release',
      artifactsDir: 'desktop/build-artifacts/linux-x64',
    })

    expect(report.passed).toBe(true)
    expect(report.artifactsDir.endsWith('desktop/build-artifacts/linux-x64')).toBe(true)
  })

  test('accepts Linux architecture-specific update metadata from arm64 builds', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/linux-arm64/Claude-Code-Haha-0.3.1-arm64.AppImage')
    writeFile(rootDir, 'desktop/build-artifacts/linux-arm64/Claude-Code-Haha-0.3.1-arm64.AppImage.blockmap')
    writeFile(rootDir, 'desktop/build-artifacts/linux-arm64/claude-code-desktop_0.3.1_arm64.deb')
    writeFile(rootDir, 'desktop/build-artifacts/linux-arm64/linux-unpacked/resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/linux-arm64/linux-unpacked/resources/app-update.yml')
    writeFile(rootDir, 'desktop/build-artifacts/linux-arm64/linux-unpacked/resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-aarch64-unknown-linux-gnu')
    writeFile(rootDir, 'desktop/build-artifacts/linux-arm64/linux-unpacked/resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/linux-arm64/linux-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/linux-arm64/pty.node')
    writeFile(rootDir, 'desktop/build-artifacts/linux-arm64/latest-linux-arm64.yml', 'path: Claude-Code-Haha-0.3.1-arm64.AppImage\n')

    const report = await inspectPackagedArtifacts(rootDir, {
      platform: 'linux',
      packageKind: 'release',
      artifactsDir: 'desktop/build-artifacts/linux-arm64',
    })

    expect(report.passed).toBe(true)
    expect(report.optionalArtifacts.some((artifact) => artifact.path.endsWith('latest-linux-arm64.yml'))).toBe(true)
    expect(report.passedChecks.some((check) => check.label.includes('update metadata referenced artifact'))).toBe(true)
  })

  test('passes Linux release checks for Electron Builder output without AppImage blockmap', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/electron/Claude-Code-Haha-0.3.1-linux-x86_64.AppImage')
    writeFile(rootDir, 'desktop/build-artifacts/electron/Claude-Code-Haha-0.3.1-linux-amd64.deb')
    writeFile(rootDir, 'desktop/build-artifacts/electron/Claude-Code-Haha-0.3.1-linux-x86_64.rpm')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-unpacked/resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-unpacked/resources/app-update.yml')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-unpacked/resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-x86_64-unknown-linux-gnu')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-unpacked/resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-unpacked/resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node')
    writeFile(rootDir, 'desktop/build-artifacts/electron/latest-linux.yml', 'path: Claude-Code-Haha-0.3.1-linux-x86_64.AppImage\n')

    const report = await inspectPackagedArtifacts(rootDir, {
      platform: 'linux',
      packageKind: 'release',
      artifactsDir: 'desktop/build-artifacts/electron',
    })

    expect(report.passed).toBe(true)
    expect(report.missingChecks.some((check) => check.label.includes('blockmap'))).toBe(false)
    expect(report.packagedArtifacts.some((artifact) => artifact.label === 'Linux RPM package')).toBe(true)
  })

  test('accepts Electron Builder linux-arm64-unpacked output directory', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/electron/Claude-Code-Haha-0.3.1-linux-arm64.AppImage')
    writeFile(rootDir, 'desktop/build-artifacts/electron/Claude-Code-Haha-0.3.1-linux-arm64.deb')
    writeFile(rootDir, 'desktop/build-artifacts/electron/Claude-Code-Haha-0.3.1-linux-aarch64.rpm')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-arm64-unpacked/resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-arm64-unpacked/resources/app-update.yml')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-arm64-unpacked/resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-aarch64-unknown-linux-gnu')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-arm64-unpacked/resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-arm64-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/linux-arm64/pty.node')
    writeFile(rootDir, 'desktop/build-artifacts/electron/latest-linux-arm64.yml', 'path: Claude-Code-Haha-0.3.1-linux-arm64.AppImage\n')

    const report = await inspectPackagedArtifacts(rootDir, {
      platform: 'linux',
      packageKind: 'release',
      artifactsDir: 'desktop/build-artifacts/electron',
    })

    expect(report.passed).toBe(true)
    expect(report.passedChecks.some((check) => check.path.includes('linux-arm64-unpacked/resources/app.asar'))).toBe(true)
    expect(report.packagedArtifacts.some((artifact) => artifact.label === 'Linux RPM package')).toBe(true)
  })

  test('passes Linux directory-only checks for electron-builder --dir output', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-unpacked/resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-unpacked/resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-x86_64-unknown-linux-gnu')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-unpacked/resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/linux-x64/pty.node')

    const report = await inspectPackagedArtifacts(rootDir, { platform: 'linux', packageKind: 'dir' })

    expect(report.passed).toBe(true)
    expect(report.notes.join('\n')).toContain('directory-only development package')
    expect(report.notes.join('\n')).toContain('Linux app-update.yml was not required')
  })

  test('fails Linux inspection when no packaged artifact is present', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    const report = await inspectPackagedArtifacts(rootDir, { platform: 'linux' })

    expect(report.passed).toBe(false)
    expect(report.missingChecks.some((check) => check.label.includes('linux packaged artifact'))).toBe(true)
  })

  test('fails Linux release inspection without linux-unpacked static resources', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/electron/Claude-Code-Haha-0.3.1-x64.AppImage')
    writeFile(rootDir, 'desktop/build-artifacts/electron/latest-linux.yml', 'path: Claude-Code-Haha-0.3.1-x64.AppImage\n')

    const report = await inspectPackagedArtifacts(rootDir, { platform: 'linux', packageKind: 'release' })

    expect(report.passed).toBe(false)
    expect(report.missingChecks.some((check) => check.label.includes('linux-unpacked'))).toBe(true)
  })
})
