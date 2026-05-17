import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createOpenTargetService } from '../services/openTargetService.js'

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

  it('rejects non-directory paths', async () => {
    const dir = await makeDir()
    const file = join(dir, 'note.txt')
    await writeFile(file, 'not a directory')
    const { service } = createService('darwin', {
      paths: { '/Applications/Visual Studio Code.app': true },
    })

    try {
      await expect(service.openTarget({ targetId: 'vscode', path: file }))
        .rejects.toMatchObject({ code: 'OPEN_TARGET_PATH_NOT_DIRECTORY' })
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
