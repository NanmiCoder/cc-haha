import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

const firewallHook = readFileSync('desktop/build/firewall.nsh', 'utf8')
const installerHook = readFileSync('desktop/build/installer.nsh', 'utf8')

describe('Windows installer H5 firewall rules', () => {
  test('adds program-scoped LAN rules at install and removes them at uninstall', () => {
    expect(firewallHook).toContain('!define CC_HAHA_FW_RULE_NAME "Claude Code Haha H5 (LAN)"')
    expect(firewallHook).toMatch(
      /!macro customInstall[\s\S]*!insertmacro CcHahaFwDeleteRules 0[\s\S]*!macroend/,
    )
    expect(firewallHook).toMatch(
      /!macro customUnInstall[\s\S]*!insertmacro CcHahaFwDeleteRules 1[\s\S]*!macroend/,
    )

    // Install-only and uninstall-only macro visibility, mirroring installer.nsh.
    expect(firewallHook).toMatch(/!ifndef BUILD_UNINSTALLER\s+!macro customInstall/)
    expect(firewallHook).toMatch(/!ifdef BUILD_UNINSTALLER\s+!macro customUnInstall/)

    // Rules are scoped to executables, not ports — the runtime port is unknown
    // at install time, so no localport / TCP port argument may appear.
    expect(firewallHook).not.toMatch(/localport/i)
    expect(firewallHook).toContain('!insertmacro CcHahaFwAddRule app "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"')
    expect(firewallHook).toContain('claude-sidecar-x86_64-pc-windows-msvc.exe')
    expect(firewallHook).toContain('claude-sidecar-aarch64-pc-windows-msvc.exe')
    expect(firewallHook).toContain('remoteip=localsubnet profile=any')
    expect(firewallHook).toContain('resources\\app.asar.unpacked\\src-tauri\\binaries')

    // Uninstall deletes by the shared display name so every program rule goes.
    expect(firewallHook).toMatch(
      /netsh\.exe" advfirewall firewall delete rule name="\$\{CC_HAHA_FW_RULE_NAME\}"/,
    )

    // Best-effort: a firewall failure (no admin rights, blocked netsh) must
    // never abort setup or uninstall.
    expect(firewallHook).not.toContain('Quit')
    expect(firewallHook).not.toContain('Abort')
    expect(firewallHook).not.toContain('SetErrorLevel')

    // The hook ships as a dedicated file included by installer.nsh.
    expect(installerHook).toContain('!include "${BUILD_RESOURCES_DIR}\\firewall.nsh"')
  })

  test.skipIf(process.platform !== 'win32')('compiles the install and uninstall hooks with native NSIS', () => {
    const compiler = process.env.CC_HAHA_TEST_MAKENSIS ?? path.join(
      process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache', 'nsis',
      'nsis-3.0.4.1-nsis-3.0.4.1', 'Bin', 'makensis.exe',
    )
    if (!existsSync(compiler)) {
      throw new Error('Native NSIS regression requires the electron-builder cached compiler, or CC_HAHA_TEST_MAKENSIS')
    }
    const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-nsis-firewall-'))
    const buildResourcesDir = path.resolve('desktop/build').replace(/\//g, '\\')
    const firewallPath = path.resolve('desktop/build/firewall.nsh').replace(/\//g, '\\')
    const fixtures = [
      {
        name: 'install',
        define: '',
        section: 'Section\n  !insertmacro customInstall\nSectionEnd',
      },
      {
        name: 'uninstall',
        define: '!define BUILD_UNINSTALLER',
        section: 'Section "RemoveFirewallRules"\n  !insertmacro customUnInstall\nSectionEnd',
      },
    ]
    try {
      for (const fixture of fixtures) {
        const source = path.join(root, `${fixture.name}.nsi`)
        writeFileSync(source, [
          'Unicode true',
          'RequestExecutionLevel user',
          'SilentInstall silent',
          `Name "cc-haha firewall ${fixture.name} compile check"`,
          `OutFile "${path.join(root, `${fixture.name}.exe`).replace(/\//g, '\\')}"`,
          fixture.define,
          '!define APP_EXECUTABLE_FILENAME "Claude Code Haha.exe"',
          `!define BUILD_RESOURCES_DIR "${buildResourcesDir}"`,
          `!include "${firewallPath}"`,
          fixture.section,
          '',
        ].join('\n'))
        const compile = spawnSync(compiler, ['/V2', source], { encoding: 'utf8', timeout: 15_000 })
        expect(compile.error, compile.stderr || compile.stdout).toBeUndefined()
        expect(compile.status, compile.stderr || compile.stdout).toBe(0)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
