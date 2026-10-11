import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit'
import { describe, expect, it } from 'vitest'
import { assertWindowsExecutableIcon } from './assert-windows-icon'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const applicationIcon = readFileSync(path.join(desktopRoot, 'src-tauri', 'icons', 'icon.ico'))

function executableWithIcons(icon?: Uint8Array): Buffer {
  const executable = NtExecutable.createEmpty(false, false)
  const resources = NtExecutableResource.from(executable)
  if (icon) {
    Resource.IconGroupEntry.replaceIconsForResource(
      resources.entries, 1, 1033, Data.IconFile.from(icon).icons.map(item => item.data),
    )
    resources.outputResource(executable)
  }
  return Buffer.from(executable.generate())
}

describe('Windows packaged executable icon', () => {
  it('accepts the application icon embedded into the actual PE resource table', () => {
    expect(() => assertWindowsExecutableIcon(executableWithIcons(applicationIcon), applicationIcon)).not.toThrow()
  })

  it('rejects an executable with no embedded application icon', () => {
    expect(() => assertWindowsExecutableIcon(executableWithIcons(), applicationIcon)).toThrow('no icon group')
  })

  it('rejects a different icon even when it is a valid PE with a valid ICO resource', () => {
    const icon = Data.IconFile.from(applicationIcon)
    icon.icons = icon.icons.slice(0, 1)
    expect(() => assertWindowsExecutableIcon(executableWithIcons(Buffer.from(icon.generate())), applicationIcon))
      .toThrow('differs from the application ICO')
  })

  it('rejects arbitrary executable bytes', () => {
    expect(() => assertWindowsExecutableIcon(Buffer.from('not a PE executable'), applicationIcon)).toThrow()
  })

  it.each([true, false])('runs the real CLI boundary with branded=%s and no writes to input artifacts', branded => {
    const root = mkdtempSync(path.join(tmpdir(), 'windows-icon-cli-'))
    try {
      const executablePath = path.join(root, 'Fixture App.exe')
      const iconPath = path.join(root, 'expected.ico')
      const executable = executableWithIcons(branded ? applicationIcon : undefined)
      writeFileSync(executablePath, executable)
      writeFileSync(iconPath, applicationIcon)
      const result = spawnSync('bun', [
        'run', path.join(desktopRoot, 'scripts', 'assert-windows-icon.ts'), executablePath, iconPath,
      ], {
        cwd: root,
        env: createSandboxedTestEnvironment(path.join(root, 'home')),
        encoding: 'utf8',
        timeout: 30_000,
      })
      expect(result.status).toBe(branded ? 0 : 1)
      expect(branded ? result.stdout : result.stderr).toContain(branded ? 'embeds the application ICO' : 'contains no icon group')
      expect(readFileSync(executablePath)).toEqual(executable)
      expect(readFileSync(iconPath)).toEqual(applicationIcon)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
