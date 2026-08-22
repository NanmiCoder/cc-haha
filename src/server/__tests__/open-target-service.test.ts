import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import {
  createOpenTargetService,
  parseDarwinApplicationListOutput,
} from '../services/openTargetService.js'

async function makeDir(prefix = 'cc-haha-open-target-') {
  return mkdtemp(join(tmpdir(), prefix))
}

function createService(
  platform: NodeJS.Platform,
  options: {
    commands?: Record<string, boolean>
    commandPaths?: Record<string, string | null>
    paths?: Record<string, boolean>
    plistValues?: Record<string, string | null>
    dirNames?: Record<string, string[]>
    textFiles?: Record<string, string | null>
    launchResult?: { code: number; stdout: string; stderr: string }
    iconData?: Uint8Array
    ttlMs?: number
    now?: { value: number }
    nativeApplications?: {
      defaultApplicationPath: string | null
      applications: Array<{ appPath: string; bundleId: string | null; displayName: string; isDefault: boolean }>
    }
  } = {},
) {
  const launched: Array<{ command: string; args: string[] }> = []
  const convertedIcons: Array<{ iconPath: string; size: number }> = []
  let commandProbes = 0
  let pathProbes = 0
  const now = options.now ?? { value: 100 }

  const service = createOpenTargetService({
    platform,
    ttlMs: options.ttlMs ?? 1_000,
    now: () => now.value,
    commandExists: async (command) => {
      commandProbes += 1
      return options.commands?.[command] === true || Boolean(options.commandPaths?.[command])
    },
    resolveCommand: async (command) => {
      const commandPath = options.commandPaths?.[command]
      if (commandPath !== undefined) return commandPath
      return options.commands?.[command] === true ? command : null
    },
    pathExists: async (targetPath) => {
      pathProbes += 1
      return options.paths?.[targetPath] === true
    },
    launch: async (command, args) => {
      launched.push({ command, args })
      return options.launchResult ?? { code: 0, stdout: '', stderr: '' }
    },
    readDirNames: async (targetPath) => options.dirNames?.[targetPath] ?? [],
    readTextFile: async (targetPath) => options.textFiles?.[targetPath] ?? null,
    readPlistValue: async (plistPath) => options.plistValues?.[plistPath] ?? null,
    convertIconToPng: async (iconPath, size) => {
      convertedIcons.push({ iconPath, size })
      return options.iconData ?? new Uint8Array([1, 2, 3])
    },
    listApplicationsForFile: async () => options.nativeApplications ?? {
      defaultApplicationPath: null,
      applications: [],
    },
  })

  return {
    service,
    launched,
    convertedIcons,
    now,
    get commandProbes() {
      return commandProbes
    },
    get pathProbes() {
      return pathProbes
    },
  }
}

describe('openTargetService', () => {
  it('parses only valid macOS application records from the native query', () => {
    expect(parseDarwinApplicationListOutput(JSON.stringify({
      defaultApplicationPath: '/Applications/Pages.app',
      applications: [
        { appPath: '/Applications/Pages.app', bundleId: 'com.apple.iWork.Pages', displayName: 'Pages', isDefault: true },
        { appPath: 'relative/Word.app', bundleId: 'com.microsoft.Word', displayName: 'Word', isDefault: false },
        { appPath: '/Applications/Broken.app', bundleId: 42, displayName: 'Broken', isDefault: false },
        null,
      ],
    }))).toEqual({
      defaultApplicationPath: '/Applications/Pages.app',
      applications: [
        { appPath: '/Applications/Pages.app', bundleId: 'com.apple.iWork.Pages', displayName: 'Pages', isDefault: true },
      ],
    })
    expect(parseDarwinApplicationListOutput('not json')).toEqual({
      defaultApplicationPath: null,
      applications: [],
    })
  })

  it('returns only detected IDE targets plus Finder on macOS', async () => {
    const { service } = createService('darwin', {
      paths: {
        '/Applications/Visual Studio Code.app': true,
        '/Applications/Sublime Text.app': true,
      },
    })

    const result = await service.listTargets()

    expect(result.platform).toBe('darwin')
    expect(result.targets.map((target) => target.id)).toEqual([
      'vscode',
      'sublime',
      'finder',
    ])
    expect(result.primaryTargetId).toBe('vscode')
    expect(result.targets.find((target) => target.id === 'finder')?.kind).toBe('file_manager')
    expect(result.targets.find((target) => target.id === 'vscode')?.iconUrl)
      .toBe('/api/open-targets/icons/vscode')
  })

  it('does not treat macOS command shims as installed IDEs without the app bundle', async () => {
    const { service } = createService('darwin', {
      commands: {
        code: true,
        goland: true,
        pycharm: true,
      },
    })

    const result = await service.listTargets()

    expect(result.targets.map((target) => target.id)).toEqual(['finder'])
    expect(result.primaryTargetId).toBe('finder')
  })

  it('falls back to Explorer when no Windows IDE is detected', async () => {
    const { service } = createService('win32')

    const result = await service.listTargets()

    expect(result.targets.map((target) => target.id)).toEqual(['explorer'])
    expect(result.primaryTargetId).toBe('explorer')
    expect(result.targets[0]?.iconUrl).toBe('/api/open-targets/icons/explorer')
  })

  it('does not include stale Windows command shims without the app executable', async () => {
    const { service } = createService('win32', {
      commandPaths: {
        'code.cmd': 'C:\\Users\\nanmi\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
        'goland.cmd': 'C:\\Users\\nanmi\\AppData\\Local\\JetBrains\\Toolbox\\scripts\\goland.cmd',
      },
    })

    const result = await service.listTargets()

    expect(result.targets.map((target) => target.id)).toEqual(['explorer'])
    expect(result.primaryTargetId).toBe('explorer')
  })

  it('detects Windows IDEs only when a real executable is resolved', async () => {
    const commandPath = 'C:\\Users\\nanmi\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd'
    const executablePath = 'C:\\Users\\nanmi\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
    const { service } = createService('win32', {
      commandPaths: {
        'code.cmd': commandPath,
      },
      paths: {
        [executablePath]: true,
      },
    })

    const result = await service.listTargets()

    expect(result.targets.map((target) => target.id)).toEqual(['vscode', 'explorer'])
    expect(result.primaryTargetId).toBe('vscode')
  })

  it('only includes the Linux file-manager fallback when xdg-open is available', async () => {
    const withoutXdg = createService('linux')
    expect((await withoutXdg.service.listTargets()).targets).toEqual([])

    const withXdg = createService('linux', {
      commands: { 'xdg-open': true },
    })
    expect((await withXdg.service.listTargets()).targets.map((target) => target.id)).toEqual([
      'file-manager',
    ])
  })

  it('caches detection results until the TTL expires', async () => {
    const now = { value: 100 }
    const state = createService('linux', {
      commands: { code: true },
      now,
    })

    await state.service.listTargets()
    const initialProbes = state.commandProbes
    expect(initialProbes).toBeGreaterThan(0)

    await state.service.listTargets()
    expect(state.commandProbes).toBe(initialProbes)

    now.value = 5_000
    await state.service.listTargets()
    expect(state.commandProbes).toBeGreaterThan(initialProbes)
  })

  it('discovers native macOS applications for the concrete document path', async () => {
    const dir = await makeDir()
    const file = join(dir, 'brief.docx')
    await writeFile(file, 'document')
    const { service } = createService('darwin', {
      nativeApplications: {
        defaultApplicationPath: '/Applications/Pages.app',
        applications: [
          { appPath: '/Applications/Pages.app', bundleId: 'com.apple.iWork.Pages', displayName: 'Pages', isDefault: true },
          { appPath: '/Applications/Word.app', bundleId: 'com.microsoft.Word', displayName: 'Word', isDefault: false },
        ],
      },
    })

    try {
      const result = await service.listTargetsForPath(file)

      expect(result.targets.map((target) => target.kind)).toEqual([
        'application',
        'application',
        'system_default',
        'file_manager',
      ])
      expect(result.targets[0]).toMatchObject({ label: 'Pages', isDefault: true })
      expect(result.primaryTargetId).toBe(result.targets[0]!.id)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('filters this desktop app, static IDE duplicates, and duplicate native applications', async () => {
    const dir = await makeDir()
    const file = join(dir, 'brief.docx')
    await writeFile(file, 'document')
    const { service } = createService('darwin', {
      nativeApplications: {
        defaultApplicationPath: '/Applications/Word.app',
        applications: [
          { appPath: '/Applications/Chat Haha.app', bundleId: 'com.claude-code-haha.desktop', displayName: 'Chat Haha', isDefault: false },
          { appPath: '/Applications/Visual Studio Code.app', bundleId: 'com.microsoft.VSCode', displayName: 'Visual Studio Code', isDefault: false },
          { appPath: '/Applications/Word.app', bundleId: 'com.microsoft.Word', displayName: 'Word', isDefault: false },
          { appPath: '/Applications/Word.app', bundleId: 'com.microsoft.Word', displayName: 'Word duplicate', isDefault: false },
        ],
      },
    })

    try {
      const result = await service.listTargetsForPath(file)
      expect(result.targets.filter((target) => target.kind === 'application')).toEqual([
        expect.objectContaining({ label: 'Word', isDefault: true }),
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('opens a discovered native application only after rediscovering it for that file', async () => {
    const dir = await makeDir()
    const file = join(dir, 'brief.docx')
    await writeFile(file, 'document')
    const state = createService('darwin', {
      nativeApplications: {
        defaultApplicationPath: '/Applications/Pages.app',
        applications: [
          { appPath: '/Applications/Pages.app', bundleId: 'com.apple.iWork.Pages', displayName: 'Pages', isDefault: true },
        ],
      },
    })

    try {
      const listed = await state.service.listTargetsForPath(file)
      const app = listed.targets.find((target) => target.kind === 'application')!
      await state.service.openTarget({ targetId: app.id, path: file })

      expect(state.launched).toEqual([{ command: 'open', args: ['-a', '/Applications/Pages.app', file] }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('opens a regular document with the system default application', async () => {
    const dir = await makeDir()
    const file = join(dir, 'brief.docx')
    await writeFile(file, 'document')
    const state = createService('darwin')

    try {
      await state.service.openTarget({ targetId: 'system-default', path: file })
      expect(state.launched).toEqual([{ command: 'open', args: [file] }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('uses the platform system-default opener on Windows and Linux', async () => {
    const dir = await makeDir()
    const file = join(dir, 'brief.docx')
    await writeFile(file, 'document')
    const windows = createService('win32')
    const linux = createService('linux', { commands: { 'xdg-open': true } })

    try {
      await windows.service.openTarget({ targetId: 'system-default', path: file })
      await linux.service.openTarget({ targetId: 'system-default', path: file })

      expect(windows.launched).toEqual([{ command: 'explorer.exe', args: [file] }])
      expect(linux.launched).toEqual([{ command: 'xdg-open', args: [file] }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects an unavailable system opener and a stale native application target', async () => {
    const dir = await makeDir()
    const file = join(dir, 'brief.docx')
    await writeFile(file, 'document')
    const linux = createService('linux')
    const mac = createService('darwin')

    try {
      await expect(linux.service.openTarget({ targetId: 'system-default', path: file }))
        .rejects.toMatchObject({ code: 'OPEN_TARGET_UNAVAILABLE' })
      await expect(mac.service.openTarget({ targetId: 'application:c3RhbGU', path: file }))
        .rejects.toMatchObject({ code: 'OPEN_TARGET_UNAVAILABLE' })
      expect(linux.launched).toEqual([])
      expect(mac.launched).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('blocks executable scripts from the system-default target', async () => {
    const dir = await makeDir()
    const file = join(dir, 'run.sh')
    await writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const state = createService('darwin')

    try {
      await expect(state.service.openTarget({ targetId: 'system-default', path: file }))
        .rejects.toMatchObject({ code: 'OPEN_TARGET_PATH_EXECUTABLE' })
      expect(state.launched).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects unknown targets', async () => {
    const dir = await makeDir()
    const { service } = createService('darwin', { commands: { code: true } })

    try {
      await expect(service.openTarget({ targetId: 'terminal', path: dir }))
        .rejects.toMatchObject({ code: 'OPEN_TARGET_UNKNOWN' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('opens file paths in IDE targets', async () => {
    const dir = await makeDir()
    const file = join(dir, 'note.txt')
    await writeFile(file, 'not a directory')
    const { service } = createService('darwin', {
      paths: { '/Applications/Visual Studio Code.app': true },
    })

    try {
      await expect(service.openTarget({ targetId: 'vscode', path: file }))
        .resolves.toMatchObject({ ok: true, targetId: 'vscode', path: file })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('launches command-first targets with argument arrays and the path as one argument', async () => {
    const dir = await makeDir('cc-haha open-target-')
    const { service, launched } = createService('linux', {
      commands: { code: true },
    })

    try {
      await service.openTarget({ targetId: 'vscode', path: dir })

      expect(launched).toEqual([{ command: 'code', args: [dir] }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('opens macOS app bundles through open -a instead of command shims', async () => {
    const dir = await makeDir()
    const { service, launched } = createService('darwin', {
      commands: { cursor: true },
      paths: { '/Applications/Cursor.app': true },
    })

    try {
      await service.openTarget({ targetId: 'cursor', path: dir })

      expect(launched).toEqual([
        { command: 'open', args: ['-a', '/Applications/Cursor.app', dir] },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reveals files in Finder instead of opening them with the default app', async () => {
    const dir = await makeDir()
    const file = join(dir, 'note.txt')
    await writeFile(file, 'contents')
    const { service, launched } = createService('darwin')

    try {
      await service.openTarget({ targetId: 'finder', path: file })

      expect(launched).toEqual([{ command: 'open', args: ['-R', file] }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('opens Windows command-shim targets through the resolved executable', async () => {
    const dir = await makeDir()
    const commandPath = 'C:\\Users\\nanmi\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd'
    const executablePath = 'C:\\Users\\nanmi\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
    const { service, launched } = createService('win32', {
      commandPaths: {
        'code.cmd': commandPath,
      },
      paths: {
        [executablePath]: true,
      },
    })

    try {
      await service.openTarget({ targetId: 'vscode', path: dir })

      expect(launched).toEqual([{ command: executablePath, args: [dir] }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('opens Windows Explorer through the file-manager fallback', async () => {
    const dir = await makeDir()
    const { service, launched } = createService('win32')

    try {
      await service.openTarget({ targetId: 'explorer', path: dir })

      expect(launched).toEqual([{ command: 'cmd.exe', args: ['/d', '/c', 'start', '', dir] }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('selects files in Windows Explorer through the file-manager fallback', async () => {
    const dir = await makeDir()
    const file = join(dir, 'note.txt')
    await writeFile(file, 'contents')
    const { service, launched } = createService('win32')

    try {
      await service.openTarget({ targetId: 'explorer', path: file })

      expect(launched).toEqual([{ command: 'explorer.exe', args: [`/select,${file}`] }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('opens a file parent directory through the Linux file-manager fallback', async () => {
    const dir = await makeDir()
    const file = join(dir, 'note.txt')
    await writeFile(file, 'contents')
    const { service, launched } = createService('linux', {
      commands: { 'xdg-open': true },
    })

    try {
      await service.openTarget({ targetId: 'file-manager', path: file })

      expect(launched).toEqual([{ command: 'xdg-open', args: [dir] }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('expands a tilde path to the home directory before validation', async () => {
    const { service, launched } = createService('darwin')

    await expect(service.openTarget({ targetId: 'finder', path: '~' }))
      .resolves.toMatchObject({ ok: true, path: homedir() })

    expect(launched).toEqual([{ command: 'open', args: [homedir()] }])
  })

  it('reports missing tilde paths with the expanded home path', async () => {
    const { service } = createService('darwin')
    const missing = `~/cc-haha-missing-${Date.now()}/report.html`

    const rejection = expect(service.openTarget({ targetId: 'finder', path: missing })).rejects
    await rejection.toMatchObject({ code: 'OPEN_TARGET_PATH_MISSING' })
    await rejection.toThrow(join(homedir(), missing.slice(2)))
  })

  it('expands Windows backslash tilde paths on win32', async () => {
    const { service } = createService('win32')
    const missing = `~\\cc-haha-missing-${Date.now()}\\report.html`

    const rejection = expect(service.openTarget({ targetId: 'explorer', path: missing })).rejects
    await rejection.toMatchObject({ code: 'OPEN_TARGET_PATH_MISSING' })
    await rejection.toThrow(homedir() + missing.slice(1))
  })

  it('keeps backslash tilde names untouched on POSIX platforms', async () => {
    const { service } = createService('darwin')

    // On POSIX "~\..." is a regular (if odd) file name, not a tilde path.
    const rejection = expect(service.openTarget({ targetId: 'finder', path: '~\\report.html' })).rejects
    await rejection.toMatchObject({ code: 'OPEN_TARGET_PATH_MISSING' })
    await rejection.toThrow('~\\report.html')
  })

  it('reports launch failures instead of returning success', async () => {
    const dir = await makeDir()
    const { service } = createService('darwin', {
      paths: { '/Applications/Visual Studio Code.app': true },
      launchResult: { code: 1, stdout: '', stderr: 'failed' },
    })

    try {
      await expect(service.openTarget({ targetId: 'vscode', path: dir }))
        .rejects.toMatchObject({ code: 'OPEN_TARGET_LAUNCH_FAILED' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('extracts macOS target icons from the detected app bundle icon file', async () => {
    const iconPath = '/Applications/Visual Studio Code.app/Contents/Resources/Code.icns'
    const state = createService('darwin', {
      paths: {
        '/Applications/Visual Studio Code.app': true,
        [iconPath]: true,
      },
      plistValues: {
        '/Applications/Visual Studio Code.app/Contents/Info.plist': 'Code.icns',
      },
      iconData: new Uint8Array([9, 8, 7]),
    })

    const icon = await state.service.getTargetIcon('vscode')

    expect(icon.contentType).toBe('image/png')
    expect(Array.from(icon.data)).toEqual([9, 8, 7])
    expect(state.convertedIcons).toEqual([{ iconPath, size: 64 }])

    await state.service.getTargetIcon('vscode')
    expect(state.convertedIcons).toHaveLength(1)
  })

  it('uses Finder system icon for the macOS file-manager fallback', async () => {
    const finderIcon = '/System/Library/CoreServices/Finder.app/Contents/Resources/Finder.icns'
    const state = createService('darwin', {
      paths: {
        [finderIcon]: true,
      },
    })

    await state.service.getTargetIcon('finder')

    expect(state.convertedIcons).toEqual([{ iconPath: finderIcon, size: 64 }])
  })

  it('extracts Windows target icons from the resolved application executable', async () => {
    const commandPath = 'C:\\Users\\nanmi\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd'
    const iconPath = 'C:\\Users\\nanmi\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
    const state = createService('win32', {
      commandPaths: {
        'code.cmd': commandPath,
      },
      paths: {
        [iconPath]: true,
      },
      iconData: new Uint8Array([4, 5, 6]),
    })

    const icon = await state.service.getTargetIcon('vscode')

    expect(icon.contentType).toBe('image/png')
    expect(Array.from(icon.data)).toEqual([4, 5, 6])
    expect(state.convertedIcons).toEqual([{ iconPath, size: 64 }])
  })

  it('uses the Windows Explorer executable icon for the file-manager fallback', async () => {
    const explorerPath = 'C:\\Windows\\explorer.exe'
    const state = createService('win32', {
      commandPaths: {
        'explorer.exe': explorerPath,
      },
      paths: {
        [explorerPath]: true,
      },
    })

    await state.service.getTargetIcon('explorer')

    expect(state.convertedIcons).toEqual([{ iconPath: explorerPath, size: 64 }])
  })

  it('extracts Linux target icons from matching desktop entries', async () => {
    const desktopPath = '/usr/share/applications/code.desktop'
    const iconPath = '/usr/share/pixmaps/code.png'
    const state = createService('linux', {
      commands: {
        code: true,
      },
      dirNames: {
        '/usr/share/applications': ['code.desktop'],
      },
      textFiles: {
        [desktopPath]: [
          '[Desktop Entry]',
          'Name=Visual Studio Code',
          'Exec=/usr/bin/code --reuse-window %F',
          'Icon=code',
        ].join('\n'),
      },
      paths: {
        [iconPath]: true,
      },
    })

    await state.service.getTargetIcon('vscode')

    expect(state.convertedIcons).toEqual([{ iconPath, size: 64 }])
  })

  it('uses the Linux folder icon for the file-manager fallback when available', async () => {
    const folderIcon = '/usr/share/icons/hicolor/64x64/apps/folder.png'
    const state = createService('linux', {
      commands: {
        'xdg-open': true,
      },
      dirNames: {
        '/usr/share/icons': ['hicolor'],
      },
      paths: {
        [folderIcon]: true,
      },
    })

    await state.service.getTargetIcon('file-manager')

    expect(state.convertedIcons).toEqual([{ iconPath: folderIcon, size: 64 }])
  })
})
