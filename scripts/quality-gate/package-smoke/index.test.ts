import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  currentPackageSmokePlatform,
} from './current'
import {
  inspectPackagedArtifacts,
  parsePackageSmokeArgs,
} from './index'

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

function writeFile(rootDir: string, relativePath: string, content = 'ok') {
  const fullPath = join(rootDir, relativePath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content)
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
    expect(() => parsePackageSmokeArgs(['--platform', 'macos', '--package-kind', 'installer'])).toThrow('auto|dir|release')
    expect(parsePackageSmokeArgs(['--platform', 'macos']).platform).toBe('macos')
    expect(parsePackageSmokeArgs(['--platform', 'macos']).packageKind).toBe('auto')
    expect(parsePackageSmokeArgs(['--platform', 'macos', '--package-kind', 'dir']).packageKind).toBe('dir')
    expect(parsePackageSmokeArgs(['--platform', 'macos', '--require-macos-gatekeeper']).requireMacosGatekeeper).toBe(true)
  })

  test('maps host platforms to current package-smoke platforms', () => {
    expect(currentPackageSmokePlatform('darwin')).toBe('macos')
    expect(currentPackageSmokePlatform('win32')).toBe('windows')
    expect(currentPackageSmokePlatform('linux')).toBe('linux')
    expect(currentPackageSmokePlatform('freebsd')).toBeNull()
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
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/plugin-seed/marketplaces/cc-haha-builtin/.claude-plugin/marketplace.json')
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

  test('fails macOS inspection when the H5 shell is not unpacked for the sidecar', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Info.plist')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/MacOS/Claude Code Haha')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app-update.yml')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-aarch64-apple-darwin')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/plugin-seed/marketplaces/cc-haha-builtin/.claude-plugin/marketplace.json')
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
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/plugin-seed/marketplaces/cc-haha-builtin/.claude-plugin/marketplace.json')
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
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/plugin-seed/marketplaces/cc-haha-builtin/.claude-plugin/marketplace.json')
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
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/plugin-seed/marketplaces/cc-haha-builtin/.claude-plugin/marketplace.json')
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
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/plugin-seed/marketplaces/cc-haha-builtin/.claude-plugin/marketplace.json')
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

  test('retries macOS Gatekeeper assessment with a raised file limit when spctl hits open-file limits', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Info.plist')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/MacOS/Claude Code Haha')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-aarch64-apple-darwin')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/mac-arm64/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/plugin-seed/marketplaces/cc-haha-builtin/.claude-plugin/marketplace.json')
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
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app.asar.unpacked/plugin-seed/marketplaces/cc-haha-builtin/.claude-plugin/marketplace.json')
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
    writeFile(rootDir, 'desktop/build-artifacts/windows-x64/win-unpacked/resources/app.asar.unpacked/plugin-seed/marketplaces/cc-haha-builtin/.claude-plugin/marketplace.json')
    writeFile(rootDir, 'desktop/build-artifacts/windows-x64/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/pty.node')
    writeFile(rootDir, 'desktop/build-artifacts/windows-x64/latest.yml', 'path: Claude-Code-Haha-0.3.1-x64.exe\n')

    const report = await inspectPackagedArtifacts(rootDir, {
      platform: 'windows',
      packageKind: 'release',
      artifactsDir: 'desktop/build-artifacts/windows-x64',
    })

    expect(report.passed).toBe(true)
    expect(report.artifactsDir.endsWith('desktop/build-artifacts/windows-x64')).toBe(true)
  })

  test('passes Windows directory-only checks for electron-builder --dir output', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/Claude Code Haha.exe')
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-x86_64-pc-windows-msvc.exe')
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app.asar.unpacked/plugin-seed/marketplaces/cc-haha-builtin/.claude-plugin/marketplace.json')
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
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app.asar.unpacked/plugin-seed/marketplaces/cc-haha-builtin/.claude-plugin/marketplace.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/pty.node')

    const report = await inspectPackagedArtifacts(rootDir, { platform: 'windows', packageKind: 'release' })

    expect(report.passed).toBe(false)
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
    writeFile(rootDir, 'desktop/build-artifacts/linux-x64/linux-unpacked/resources/app.asar.unpacked/plugin-seed/marketplaces/cc-haha-builtin/.claude-plugin/marketplace.json')
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
    writeFile(rootDir, 'desktop/build-artifacts/linux-arm64/linux-unpacked/resources/app.asar.unpacked/plugin-seed/marketplaces/cc-haha-builtin/.claude-plugin/marketplace.json')
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
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-unpacked/resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-unpacked/resources/app-update.yml')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-unpacked/resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-x86_64-unknown-linux-gnu')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-unpacked/resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-unpacked/resources/app.asar.unpacked/plugin-seed/marketplaces/cc-haha-builtin/.claude-plugin/marketplace.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-unpacked/resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node')
    writeFile(rootDir, 'desktop/build-artifacts/electron/latest-linux.yml', 'path: Claude-Code-Haha-0.3.1-linux-x86_64.AppImage\n')

    const report = await inspectPackagedArtifacts(rootDir, {
      platform: 'linux',
      packageKind: 'release',
      artifactsDir: 'desktop/build-artifacts/electron',
    })

    expect(report.passed).toBe(true)
    expect(report.missingChecks.some((check) => check.label.includes('blockmap'))).toBe(false)
  })

  test('accepts Electron Builder linux-arm64-unpacked output directory', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/electron/Claude-Code-Haha-0.3.1-linux-arm64.AppImage')
    writeFile(rootDir, 'desktop/build-artifacts/electron/Claude-Code-Haha-0.3.1-linux-arm64.deb')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-arm64-unpacked/resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-arm64-unpacked/resources/app-update.yml')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-arm64-unpacked/resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-aarch64-unknown-linux-gnu')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-arm64-unpacked/resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-arm64-unpacked/resources/app.asar.unpacked/plugin-seed/marketplaces/cc-haha-builtin/.claude-plugin/marketplace.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-arm64-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/linux-arm64/pty.node')
    writeFile(rootDir, 'desktop/build-artifacts/electron/latest-linux-arm64.yml', 'path: Claude-Code-Haha-0.3.1-linux-arm64.AppImage\n')

    const report = await inspectPackagedArtifacts(rootDir, {
      platform: 'linux',
      packageKind: 'release',
      artifactsDir: 'desktop/build-artifacts/electron',
    })

    expect(report.passed).toBe(true)
    expect(report.passedChecks.some((check) => check.path.includes('linux-arm64-unpacked/resources/app.asar'))).toBe(true)
  })

  test('passes Linux directory-only checks for electron-builder --dir output', async () => {
    const rootDir = createRepoRoot()
    tempDirs.push(rootDir)

    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-unpacked/resources/app.asar')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-unpacked/resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-x86_64-unknown-linux-gnu')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-unpacked/resources/app.asar.unpacked/node_modules/node-pty/package.json')
    writeFile(rootDir, 'desktop/build-artifacts/electron/linux-unpacked/resources/app.asar.unpacked/plugin-seed/marketplaces/cc-haha-builtin/.claude-plugin/marketplace.json')
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
