import { execFile as execFileCallback, spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { extname, join, posix as posixPath, resolve, win32 as winPath } from 'node:path'
import { promisify } from 'node:util'
import { ApiError } from '../middleware/errorHandler.js'

const execFile = promisify(execFileCallback)
const DEFAULT_TTL_MS = 30_000

export type OpenTargetPlatform = NodeJS.Platform

export type OpenTargetKind = 'ide' | 'file_manager'

export type OpenTarget = {
  id: string
  kind: OpenTargetKind
  label: string
  icon: string
  iconUrl?: string
  platform: OpenTargetPlatform
}

export type OpenTargetList = {
  platform: OpenTargetPlatform
  targets: OpenTarget[]
  primaryTargetId: string | null
  cachedAt: number
  ttlMs: number
}

export type OpenTargetLaunchResult = {
  code: number
  stdout: string
  stderr: string
}

export type OpenTargetIconResult = {
  contentType: 'image/png'
  data: Uint8Array
}

type Runtime = {
  platform: OpenTargetPlatform
  ttlMs: number
  now: () => number
  commandExists: (command: string) => Promise<boolean>
  resolveCommand: (command: string) => Promise<string | null>
  pathExists: (targetPath: string) => Promise<boolean>
  launch: (command: string, args: string[]) => Promise<OpenTargetLaunchResult>
  readDirNames: (targetPath: string) => Promise<string[]>
  readTextFile: (targetPath: string) => Promise<string | null>
  readPlistValue: (plistPath: string, key: string) => Promise<string | null>
  convertIconToPng: (iconPath: string, size: number) => Promise<Uint8Array>
}

type LaunchPlan = {
  command: string
  args: string[]
}

type TargetDefinition = {
  id: string
  kind: OpenTargetKind
  label: string
  icon: string
  platforms: OpenTargetPlatform[]
  commands?: Partial<Record<OpenTargetPlatform, string[]>>
  appPaths?: Partial<Record<OpenTargetPlatform, string[]>>
  iconPaths?: Partial<Record<OpenTargetPlatform, string[]>>
  windowsExecutableNames?: string[]
  fallback?: boolean
}

const TARGET_DEFINITIONS: TargetDefinition[] = [
  {
    id: 'vscode',
    kind: 'ide',
    label: 'VS Code',
    icon: 'vscode',
    platforms: ['darwin', 'win32', 'linux'],
    commands: {
      darwin: ['code'],
      win32: ['code.cmd', 'code.exe'],
      linux: ['code'],
    },
    windowsExecutableNames: ['Code.exe'],
    appPaths: {
      darwin: [
        '/Applications/Visual Studio Code.app',
        posixPath.join(homedir(), 'Applications', 'Visual Studio Code.app'),
      ],
    },
  },
  {
    id: 'cursor',
    kind: 'ide',
    label: 'Cursor',
    icon: 'cursor',
    platforms: ['darwin', 'win32', 'linux'],
    commands: {
      darwin: ['cursor'],
      win32: ['cursor.cmd', 'cursor.exe'],
      linux: ['cursor'],
    },
    windowsExecutableNames: ['Cursor.exe'],
    appPaths: {
      darwin: ['/Applications/Cursor.app', posixPath.join(homedir(), 'Applications', 'Cursor.app')],
    },
  },
  {
    id: 'sublime',
    kind: 'ide',
    label: 'Sublime Text',
    icon: 'sublime',
    platforms: ['darwin', 'win32', 'linux'],
    commands: {
      darwin: ['subl'],
      win32: ['subl.exe', 'subl'],
      linux: ['subl'],
    },
    windowsExecutableNames: ['sublime_text.exe', 'subl.exe'],
    appPaths: {
      darwin: ['/Applications/Sublime Text.app', posixPath.join(homedir(), 'Applications', 'Sublime Text.app')],
    },
  },
  {
    id: 'antigravity',
    kind: 'ide',
    label: 'Antigravity',
    icon: 'antigravity',
    platforms: ['darwin'],
    commands: {
      darwin: ['antigravity'],
    },
    appPaths: {
      darwin: ['/Applications/Antigravity.app', posixPath.join(homedir(), 'Applications', 'Antigravity.app')],
    },
  },
  {
    id: 'goland',
    kind: 'ide',
    label: 'GoLand',
    icon: 'goland',
    platforms: ['darwin', 'win32', 'linux'],
    commands: {
      darwin: ['goland'],
      win32: ['goland64.exe', 'goland.cmd'],
      linux: ['goland'],
    },
    windowsExecutableNames: ['goland64.exe', 'goland.exe'],
    appPaths: {
      darwin: ['/Applications/GoLand.app', posixPath.join(homedir(), 'Applications', 'GoLand.app')],
    },
  },
  {
    id: 'pycharm',
    kind: 'ide',
    label: 'PyCharm',
    icon: 'pycharm',
    platforms: ['darwin', 'win32', 'linux'],
    commands: {
      darwin: ['pycharm'],
      win32: ['pycharm64.exe', 'pycharm.cmd'],
      linux: ['pycharm'],
    },
    windowsExecutableNames: ['pycharm64.exe', 'pycharm.exe'],
    appPaths: {
      darwin: ['/Applications/PyCharm.app', posixPath.join(homedir(), 'Applications', 'PyCharm.app')],
    },
  },
  {
    id: 'finder',
    kind: 'file_manager',
    label: 'Finder',
    icon: 'finder',
    platforms: ['darwin'],
    iconPaths: {
      darwin: ['/System/Library/CoreServices/Finder.app/Contents/Resources/Finder.icns'],
    },
    fallback: true,
  },
  {
    id: 'explorer',
    kind: 'file_manager',
    label: 'Explorer',
    icon: 'folder',
    platforms: ['win32'],
    fallback: true,
  },
  {
    id: 'file-manager',
    kind: 'file_manager',
    label: 'File Manager',
    icon: 'folder',
    platforms: ['linux'],
    fallback: true,
  },
]

const LINUX_APPLICATION_DIRS = [
  '/usr/share/applications',
  '/usr/local/share/applications',
  posixPath.join(homedir(), '.local', 'share', 'applications'),
  '/var/lib/flatpak/exports/share/applications',
  posixPath.join(homedir(), '.local', 'share', 'flatpak', 'exports', 'share', 'applications'),
]

const LINUX_ICON_ROOTS = [
  posixPath.join(homedir(), '.local', 'share', 'icons'),
  '/usr/local/share/icons',
  '/usr/share/icons',
]

const LINUX_ICON_THEME_SUBDIRS = [
  'scalable/apps',
  '512x512/apps',
  '256x256/apps',
  '128x128/apps',
  '64x64/apps',
  '48x48/apps',
  '32x32/apps',
  'apps/scalable',
  'apps/64',
  'apps/48',
  'apps/32',
]

function openTargetError(statusCode: number, message: string, code: string): ApiError {
  return new ApiError(statusCode, message, code)
}

async function defaultResolveCommand(command: string): Promise<string | null> {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFile(probe, [command], {
      timeout: 3_000,
      windowsHide: true,
    })
    const firstPath = String(stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    return firstPath ?? null
  } catch {
    return null
  }
}

async function defaultCommandExists(command: string): Promise<boolean> {
  return (await defaultResolveCommand(command)) !== null
}

async function defaultPathExists(targetPath: string): Promise<boolean> {
  try {
    const entry = await stat(targetPath)
    return entry.isFile() || entry.isDirectory()
  } catch {
    return false
  }
}

async function defaultLaunch(command: string, args: string[]): Promise<OpenTargetLaunchResult> {
  return await new Promise((resolveLaunch) => {
    let settled = false
    const settle = (result: OpenTargetLaunchResult) => {
      if (settled) return
      settled = true
      resolveLaunch(result)
    }

    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })

      child.once('error', (error) => {
        settle({
          code: 1,
          stdout: '',
          stderr: error.message,
        })
      })

      child.once('spawn', () => {
        child.unref()
        settle({
          code: 0,
          stdout: '',
          stderr: '',
        })
      })
    } catch (error) {
      const err = error as { message?: string }
      settle({
        code: 1,
        stdout: '',
        stderr: String(err.message ?? error),
      })
    }
  })
}

async function resolveWindowsApplicationPath(
  definition: TargetDefinition,
  runtime: Runtime,
): Promise<string | null> {
  for (const appPath of definition.appPaths?.win32 ?? []) {
    if (await runtime.pathExists(appPath)) return appPath
  }

  for (const command of definition.commands?.win32 ?? []) {
    const commandPath = await runtime.resolveCommand(command)
    if (!commandPath) continue

    const executablePath = await resolveWindowsExecutablePath(commandPath, definition, runtime)
    if (executablePath) return executablePath
  }

  return null
}

async function resolveWindowsExecutablePath(
  commandPath: string,
  definition: TargetDefinition,
  runtime: Runtime,
): Promise<string | null> {
  const extension = winPath.extname(commandPath).toLowerCase()
  if (extension === '.exe' && await runtime.pathExists(commandPath)) {
    return commandPath
  }

  if (extension !== '.cmd' && extension !== '.bat') {
    return null
  }

  const executableNames = definition.windowsExecutableNames
    ?? definition.commands?.win32?.filter((command) => winPath.extname(command).toLowerCase() === '.exe')
    ?? []

  let currentDir = winPath.dirname(commandPath)
  for (let depth = 0; depth < 5; depth += 1) {
    for (const executableName of executableNames) {
      const candidate = winPath.join(currentDir, executableName)
      if (await runtime.pathExists(candidate)) return candidate
    }

    const nextDir = winPath.dirname(currentDir)
    if (!nextDir || nextDir === currentDir) break
    currentDir = nextDir
  }

  return null
}

async function defaultReadDirNames(targetPath: string): Promise<string[]> {
  try {
    return await readdir(targetPath)
  } catch {
    return []
  }
}

async function defaultReadTextFile(targetPath: string): Promise<string | null> {
  try {
    return await readFile(targetPath, 'utf8')
  } catch {
    return null
  }
}

async function defaultReadPlistValue(plistPath: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('/usr/bin/plutil', [
      '-extract',
      key,
      'raw',
      '-o',
      '-',
      plistPath,
    ], {
      timeout: 3_000,
      windowsHide: true,
    })
    const value = String(stdout ?? '').trim()
    return value || null
  } catch {
    return null
  }
}

async function defaultConvertIconToPng(iconPath: string, size: number): Promise<Uint8Array> {
  const extension = extname(iconPath).toLowerCase()
  if (extension === '.png') {
    return await readFile(iconPath)
  }

  const tmpDir = await mkdtemp(join(tmpdir(), 'cc-haha-open-target-icon-'))
  const outputPath = join(tmpDir, 'icon.png')
  try {
    if (process.platform === 'win32') {
      await convertWindowsIconToPng(iconPath, outputPath)
    } else if (extension === '.svg' || extension === '.xpm') {
      await convertLinuxThemeIconToPng(iconPath, outputPath, size)
    } else {
      await execFile('/usr/bin/sips', [
        '-z',
        String(size),
        String(size),
        '-s',
        'format',
        'png',
        iconPath,
        '--out',
        outputPath,
      ], {
        timeout: 5_000,
        windowsHide: true,
      })
    }
    return await readFile(outputPath)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

async function convertWindowsIconToPng(iconPath: string, outputPath: string): Promise<void> {
  const script = `
Add-Type -AssemblyName System.Drawing
$source = $env:CC_HAHA_ICON_SOURCE
$output = $env:CC_HAHA_ICON_OUTPUT
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($source)
if ($null -eq $icon) { exit 2 }
$bitmap = $icon.ToBitmap()
$bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
$icon.Dispose()
`

  await execFile('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    env: {
      ...process.env,
      CC_HAHA_ICON_SOURCE: iconPath,
      CC_HAHA_ICON_OUTPUT: outputPath,
    },
    timeout: 5_000,
    windowsHide: true,
  })
}

async function convertLinuxThemeIconToPng(
  iconPath: string,
  outputPath: string,
  size: number,
): Promise<void> {
  const attempts: Array<{ command: string; args: string[] }> = [
    {
      command: 'rsvg-convert',
      args: ['-w', String(size), '-h', String(size), '-o', outputPath, iconPath],
    },
    {
      command: 'gdk-pixbuf-thumbnailer',
      args: ['-s', String(size), iconPath, outputPath],
    },
    {
      command: 'magick',
      args: [iconPath, '-resize', `${size}x${size}`, outputPath],
    },
    {
      command: 'convert',
      args: [iconPath, '-resize', `${size}x${size}`, outputPath],
    },
  ]

  let lastError: unknown
  for (const attempt of attempts) {
    try {
      await execFile(attempt.command, attempt.args, {
        timeout: 5_000,
        windowsHide: true,
      })
      return
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Unable to rasterize Linux icon: ${iconPath}`)
}

function buildOpenTarget(definition: TargetDefinition, platform: OpenTargetPlatform): OpenTarget {
  return {
    id: definition.id,
    kind: definition.kind,
    label: definition.label,
    icon: definition.icon,
    iconUrl: `/api/open-targets/icons/${encodeURIComponent(definition.id)}`,
    platform,
  }
}

function isSupportedOnPlatform(definition: TargetDefinition, platform: OpenTargetPlatform): boolean {
  return definition.platforms.includes(platform)
}

async function isDetected(definition: TargetDefinition, runtime: Runtime): Promise<boolean> {
  if (!isSupportedOnPlatform(definition, runtime.platform)) {
    return false
  }

  if (definition.fallback) {
    if (runtime.platform === 'linux') {
      return runtime.commandExists('xdg-open')
    }
    return true
  }

  if (runtime.platform === 'darwin' && definition.appPaths?.darwin?.length) {
    for (const appPath of definition.appPaths.darwin) {
      if (await runtime.pathExists(appPath)) {
        return true
      }
    }
    return false
  }

  if (runtime.platform === 'win32') {
    return (await resolveWindowsApplicationPath(definition, runtime)) !== null
  }

  for (const appPath of definition.appPaths?.[runtime.platform] ?? []) {
    if (await runtime.pathExists(appPath)) {
      return true
    }
  }

  for (const command of definition.commands?.[runtime.platform] ?? []) {
    if (await runtime.commandExists(command)) {
      return true
    }
  }

  return false
}

async function resolveLaunchPlan(
  definition: TargetDefinition,
  runtime: Runtime,
  targetPath: string,
): Promise<LaunchPlan | null> {
  if (!isSupportedOnPlatform(definition, runtime.platform)) {
    return null
  }

  if (definition.fallback) {
    switch (runtime.platform) {
      case 'darwin':
        return { command: 'open', args: [targetPath] }
      case 'win32':
        return { command: 'cmd.exe', args: ['/d', '/c', 'start', '', targetPath] }
      case 'linux':
        return { command: 'xdg-open', args: [targetPath] }
      default:
        return null
    }
  }

  if (runtime.platform === 'darwin') {
    for (const appPath of definition.appPaths?.darwin ?? []) {
      if (await runtime.pathExists(appPath)) {
        return { command: 'open', args: ['-a', appPath, targetPath] }
      }
    }
  }

  if (runtime.platform === 'win32') {
    const applicationPath = await resolveWindowsApplicationPath(definition, runtime)
    return applicationPath ? { command: applicationPath, args: [targetPath] } : null
  }

  for (const command of definition.commands?.[runtime.platform] ?? []) {
    if (await runtime.commandExists(command)) {
      return { command, args: [targetPath] }
    }
  }

  return null
}

async function validateDirectory(targetPath: string): Promise<string> {
  const resolvedPath = resolve(targetPath)
  let entry
  try {
    entry = await stat(resolvedPath)
  } catch {
    throw openTargetError(
      400,
      `Directory does not exist: ${resolvedPath}`,
      'OPEN_TARGET_PATH_MISSING',
    )
  }

  if (!entry.isDirectory()) {
    throw openTargetError(
      400,
      `Path is not a directory: ${resolvedPath}`,
      'OPEN_TARGET_PATH_NOT_DIRECTORY',
    )
  }

  return resolvedPath
}

function normalizeIconFileName(iconFile: string): string {
  const trimmed = iconFile.trim()
  if (!trimmed) return trimmed
  return extname(trimmed) ? trimmed : `${trimmed}.icns`
}

async function findDarwinBundleIconPath(
  appPath: string,
  definition: TargetDefinition,
  runtime: Runtime,
): Promise<string | null> {
  const resourcesPath = posixPath.join(appPath, 'Contents', 'Resources')
  const plistPath = posixPath.join(appPath, 'Contents', 'Info.plist')
  const plistIcon = await runtime.readPlistValue(plistPath, 'CFBundleIconFile')

  const candidates = [
    plistIcon ? normalizeIconFileName(plistIcon) : null,
    `${definition.label}.icns`,
    `${definition.icon}.icns`,
  ].filter((value): value is string => Boolean(value))

  for (const fileName of candidates) {
    const iconPath = posixPath.join(resourcesPath, fileName)
    if (await runtime.pathExists(iconPath)) return iconPath
  }

  const iconFiles = await runtime.readDirNames(resourcesPath)
  const firstIcon = iconFiles
    .filter((fileName) => fileName.endsWith('.icns'))
    .find((fileName) => !/document/i.test(fileName)) ?? null

  if (!firstIcon) return null
  const fallbackPath = posixPath.join(resourcesPath, firstIcon)
  return await runtime.pathExists(fallbackPath) ? fallbackPath : null
}

async function resolveDarwinIconPath(
  definition: TargetDefinition,
  runtime: Runtime,
): Promise<string | null> {
  for (const iconPath of definition.iconPaths?.darwin ?? []) {
    if (await runtime.pathExists(iconPath)) return iconPath
  }

  for (const appPath of definition.appPaths?.darwin ?? []) {
    if (!(await runtime.pathExists(appPath))) continue
    const iconPath = await findDarwinBundleIconPath(appPath, definition, runtime)
    if (iconPath) return iconPath
  }

  return null
}

async function resolveWindowsIconPath(
  definition: TargetDefinition,
  runtime: Runtime,
): Promise<string | null> {
  if (definition.fallback && definition.id === 'explorer') {
    const explorerPath = await runtime.resolveCommand('explorer.exe')
    if (explorerPath) return explorerPath
  }

  for (const iconPath of definition.iconPaths?.win32 ?? []) {
    if (await runtime.pathExists(iconPath)) return iconPath
  }

  const applicationPath = await resolveWindowsApplicationPath(definition, runtime)
  if (applicationPath) return applicationPath

  return null
}

type LinuxDesktopEntry = {
  filePath: string
  name: string | null
  exec: string | null
  icon: string | null
}

async function resolveLinuxIconPath(
  definition: TargetDefinition,
  runtime: Runtime,
): Promise<string | null> {
  for (const iconPath of definition.iconPaths?.linux ?? []) {
    if (await runtime.pathExists(iconPath)) return iconPath
  }

  const desktopEntries = definition.fallback
    ? []
    : await findLinuxDesktopEntries(definition, runtime)

  for (const desktopEntry of desktopEntries) {
    if (!desktopEntry.icon) continue
    const iconPath = await resolveLinuxIconName(desktopEntry.icon, runtime)
    if (iconPath) return iconPath
  }

  if (definition.fallback && definition.kind === 'file_manager') {
    return await resolveLinuxIconName('folder', runtime)
      ?? await resolveLinuxIconName('system-file-manager', runtime)
      ?? await resolveLinuxIconName('org.gnome.Nautilus', runtime)
  }

  return null
}

async function findLinuxDesktopEntries(
  definition: TargetDefinition,
  runtime: Runtime,
): Promise<LinuxDesktopEntry[]> {
  const matches: LinuxDesktopEntry[] = []
  for (const directory of LINUX_APPLICATION_DIRS) {
    const fileNames = await runtime.readDirNames(directory)
    for (const fileName of fileNames) {
      if (!fileName.endsWith('.desktop')) continue

      const filePath = posixPath.join(directory, fileName)
      const text = await runtime.readTextFile(filePath)
      if (!text) continue

      const entry = parseLinuxDesktopEntry(filePath, text)
      if (entry && linuxDesktopEntryMatchesDefinition(entry, fileName, definition)) {
        matches.push(entry)
      }
    }
  }

  return matches
}

function parseLinuxDesktopEntry(filePath: string, text: string): LinuxDesktopEntry | null {
  let inDesktopEntry = false
  const values = new Map<string, string>()

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    if (line.startsWith('[') && line.endsWith(']')) {
      inDesktopEntry = line === '[Desktop Entry]'
      continue
    }

    if (!inDesktopEntry) continue

    const equalsIndex = line.indexOf('=')
    if (equalsIndex <= 0) continue

    const rawKey = line.slice(0, equalsIndex).trim()
    const key = rawKey.replace(/\[.*\]$/, '')
    if (key !== 'Name' && key !== 'Exec' && key !== 'Icon') continue

    values.set(key, line.slice(equalsIndex + 1).trim())
  }

  if (!values.has('Exec') && !values.has('Icon')) return null

  return {
    filePath,
    name: values.get('Name') ?? null,
    exec: values.get('Exec') ?? null,
    icon: values.get('Icon') ?? null,
  }
}

function linuxDesktopEntryMatchesDefinition(
  entry: LinuxDesktopEntry,
  fileName: string,
  definition: TargetDefinition,
): boolean {
  const commandNames = new Set(
    (definition.commands?.linux ?? []).map((command) => posixPath.basename(command).toLowerCase()),
  )
  const normalizedNeedles = [
    definition.id,
    definition.icon,
    definition.label,
    ...commandNames,
  ].map(normalizeLinuxDesktopSearchText)

  const normalizedFileName = normalizeLinuxDesktopSearchText(fileName)
  const normalizedName = normalizeLinuxDesktopSearchText(entry.name ?? '')
  if (normalizedNeedles.some((needle) => needle && (
    normalizedFileName.includes(needle) || normalizedName.includes(needle)
  ))) {
    return true
  }

  const execCommand = entry.exec ? extractLinuxDesktopExecCommand(entry.exec) : null
  return execCommand ? commandNames.has(execCommand) : false
}

function normalizeLinuxDesktopSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function extractLinuxDesktopExecCommand(execValue: string): string | null {
  const tokens = execValue
    .replace(/%[a-zA-Z]/g, '')
    .match(/"([^"]+)"|'([^']+)'|(\S+)/g)
    ?.map((token) => token.replace(/^['"]|['"]$/g, '')) ?? []

  for (const token of tokens) {
    if (!token || token.includes('=')) continue
    const command = posixPath.basename(token).toLowerCase()
    if (command === 'env') continue
    return command
  }

  return null
}

async function resolveLinuxIconName(
  iconName: string,
  runtime: Runtime,
): Promise<string | null> {
  const trimmed = iconName.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('/') && await runtime.pathExists(trimmed)) {
    return trimmed
  }

  const extension = extname(trimmed)
  const baseName = extension ? trimmed.slice(0, -extension.length) : trimmed
  const extensions = extension ? [extension] : ['.png', '.svg', '.xpm']

  const directRoots = [
    '/usr/share/pixmaps',
    '/usr/local/share/pixmaps',
    posixPath.join(homedir(), '.local', 'share', 'pixmaps'),
  ]
  for (const root of directRoots) {
    for (const candidateExtension of extensions) {
      const candidate = posixPath.join(root, `${baseName}${candidateExtension}`)
      if (await runtime.pathExists(candidate)) return candidate
    }
  }

  for (const root of LINUX_ICON_ROOTS) {
    const themeNames = await runtime.readDirNames(root)
    for (const themeName of themeNames) {
      for (const subdir of LINUX_ICON_THEME_SUBDIRS) {
        for (const candidateExtension of extensions) {
          const candidate = posixPath.join(root, themeName, subdir, `${baseName}${candidateExtension}`)
          if (await runtime.pathExists(candidate)) return candidate
        }
      }
    }
  }

  return null
}

async function resolveIconPath(
  definition: TargetDefinition,
  runtime: Runtime,
): Promise<string | null> {
  if (!isSupportedOnPlatform(definition, runtime.platform)) {
    return null
  }

  switch (runtime.platform) {
    case 'darwin':
      return resolveDarwinIconPath(definition, runtime)
    case 'win32':
      return resolveWindowsIconPath(definition, runtime)
    case 'linux':
      return resolveLinuxIconPath(definition, runtime)
    default:
      return null
  }
}

export function createOpenTargetService(overrides: Partial<Runtime> = {}) {
  const runtime: Runtime = {
    platform: overrides.platform ?? process.platform,
    ttlMs: overrides.ttlMs ?? DEFAULT_TTL_MS,
    now: overrides.now ?? Date.now,
    commandExists: overrides.commandExists ?? defaultCommandExists,
    resolveCommand: overrides.resolveCommand ?? defaultResolveCommand,
    pathExists: overrides.pathExists ?? defaultPathExists,
    launch: overrides.launch ?? defaultLaunch,
    readDirNames: overrides.readDirNames ?? defaultReadDirNames,
    readTextFile: overrides.readTextFile ?? defaultReadTextFile,
    readPlistValue: overrides.readPlistValue ?? defaultReadPlistValue,
    convertIconToPng: overrides.convertIconToPng ?? defaultConvertIconToPng,
  }

  let cache: OpenTargetList | null = null
  const iconCache = new Map<string, OpenTargetIconResult>()

  async function listTargets(forceRefresh = false): Promise<OpenTargetList> {
    if (!forceRefresh && cache && runtime.now() - cache.cachedAt < runtime.ttlMs) {
      return cache
    }

    const targets: OpenTarget[] = []
    for (const definition of TARGET_DEFINITIONS) {
      if (await isDetected(definition, runtime)) {
        targets.push(buildOpenTarget(definition, runtime.platform))
      }
    }

    cache = {
      platform: runtime.platform,
      targets,
      primaryTargetId: targets[0]?.id ?? null,
      cachedAt: runtime.now(),
      ttlMs: runtime.ttlMs,
    }

    return cache
  }

  async function openTarget(input: { targetId: string; path: string }) {
    const definition = TARGET_DEFINITIONS.find((candidate) => candidate.id === input.targetId)
    if (!definition) {
      throw openTargetError(
        400,
        `Unknown open target: ${input.targetId}`,
        'OPEN_TARGET_UNKNOWN',
      )
    }

    const targets = await listTargets()
    const target = targets.targets.find((candidate) => candidate.id === input.targetId)
    if (!target) {
      throw openTargetError(
        400,
        `Open target is not available on ${runtime.platform}: ${input.targetId}`,
        'OPEN_TARGET_UNAVAILABLE',
      )
    }

    const resolvedPath = await validateDirectory(input.path)
    const launchPlan = await resolveLaunchPlan(definition, runtime, resolvedPath)
    if (!launchPlan) {
      throw openTargetError(
        400,
        `Unable to launch open target: ${input.targetId}`,
        'OPEN_TARGET_UNAVAILABLE',
      )
    }

    const launchResult = await runtime.launch(launchPlan.command, launchPlan.args)
    if (launchResult.code !== 0) {
      throw openTargetError(
        500,
        `Failed to launch open target: ${input.targetId}`,
        'OPEN_TARGET_LAUNCH_FAILED',
      )
    }

    return {
      ok: true as const,
      targetId: target.id,
      path: resolvedPath,
    }
  }

  async function getTargetIcon(targetId: string, size = 64): Promise<OpenTargetIconResult> {
    const definition = TARGET_DEFINITIONS.find((candidate) => candidate.id === targetId)
    if (!definition) {
      throw openTargetError(404, `Unknown open target icon: ${targetId}`, 'OPEN_TARGET_ICON_UNKNOWN')
    }

    const normalizedSize = Number.isFinite(size) ? Math.min(256, Math.max(16, Math.round(size))) : 64
    const cacheKey = `${runtime.platform}:${targetId}:${normalizedSize}`
    const cachedIcon = iconCache.get(cacheKey)
    if (cachedIcon) return cachedIcon

    const targets = await listTargets()
    if (!targets.targets.some((target) => target.id === targetId)) {
      throw openTargetError(
        404,
        `Open target icon is not available on ${runtime.platform}: ${targetId}`,
        'OPEN_TARGET_ICON_UNAVAILABLE',
      )
    }

    const iconPath = await resolveIconPath(definition, runtime)
    if (!iconPath) {
      throw openTargetError(
        404,
        `Open target icon is not available on ${runtime.platform}: ${targetId}`,
        'OPEN_TARGET_ICON_UNAVAILABLE',
      )
    }

    const icon = {
      contentType: 'image/png' as const,
      data: await runtime.convertIconToPng(iconPath, normalizedSize),
    }
    iconCache.set(cacheKey, icon)
    return icon
  }

  return {
    listTargets,
    openTarget,
    getTargetIcon,
  }
}

export const openTargetService = createOpenTargetService()
