/**
 * knownLanguageServers — curated detection + install hints for common
 * language servers, surfaced in the desktop Settings → Plugins
 * "Language Servers" section.
 *
 * This is a SEPARATE dimension from plugin-declared `lspServers`. Here we
 * only probe whether a well-known LSP binary is resolvable on PATH and,
 * when it is not, offer per-platform install commands the user can run in
 * a terminal. We never execute the install commands server-side — the
 * desktop injects them into a visible terminal where the user presses
 * Enter to confirm.
 *
 * Probe names must be bare command tokens matching the same safety regex
 * `probeHostCommand` enforces (`/^[A-Za-z0-9._+\-]+$/`). The richer
 * `go install ...` / `dotnet tool ...` strings live only in `install`
 * step `cmd` fields (terminal-executed), never as probe names.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  clearPrerequisitesCache,
  probeHostCommands,
  type PrerequisiteProbeResult,
} from './prerequisitesService.js'

/** A single install step for one package manager on one platform. */
export type LanguageServerInstallStep = {
  /** Package manager label, e.g. "npm" / "winget" / "brew" / "go". */
  manager: string
  /** Exact shell command the user runs in a terminal. */
  cmd: string
}

/** Per-platform install step lists, keyed by `process.platform` values. */
export type LanguageServerInstallMap = {
  win32?: LanguageServerInstallStep[]
  darwin?: LanguageServerInstallStep[]
  linux?: LanguageServerInstallStep[]
}

export type KnownLanguageServer = {
  /** Stable id, e.g. "python", "typescript". */
  language: string
  /** Human-friendly label for the UI, e.g. "Python (Pyright)". */
  label: string
  /** Primary bare command probed on PATH. */
  command: string
  /** Optional fallback commands probed when `command` is absent. */
  candidates?: string[]
  /** Project / install homepage shown when no install step fits. */
  homepage?: string
  /** Per-platform install commands. */
  install: LanguageServerInstallMap
}

export type KnownLanguageServerStatus = KnownLanguageServer & {
  installed: boolean
  /** Resolved absolute path of the matched command; null when missing. */
  resolvedPath: string | null
  /** Which probed command actually resolved (command or a candidate). */
  resolvedCommand: string | null
}

/**
 * Curated set covering common front/back-end languages. Install commands
 * are presets only — the desktop runs them in a visible terminal after
 * the user confirms. Several languages share `clangd` (C / C++).
 */
export const KNOWN_LANGUAGE_SERVERS: readonly KnownLanguageServer[] = [
  {
    language: 'python',
    label: 'Python (Pyright)',
    command: 'pyright-langserver',
    candidates: ['pyright'],
    homepage: 'https://github.com/microsoft/pyright',
    install: {
      win32: [{ manager: 'npm', cmd: 'npm install -g pyright' }],
      darwin: [{ manager: 'npm', cmd: 'npm install -g pyright' }],
      linux: [{ manager: 'npm', cmd: 'npm install -g pyright' }],
    },
  },
  {
    language: 'typescript',
    label: 'JavaScript / TypeScript',
    command: 'typescript-language-server',
    homepage: 'https://github.com/typescript-language-server/typescript-language-server',
    install: {
      win32: [{ manager: 'npm', cmd: 'npm install -g typescript typescript-language-server' }],
      darwin: [{ manager: 'npm', cmd: 'npm install -g typescript typescript-language-server' }],
      linux: [{ manager: 'npm', cmd: 'npm install -g typescript typescript-language-server' }],
    },
  },
  {
    language: 'java',
    label: 'Java (Eclipse JDT.LS)',
    command: 'jdtls',
    homepage: 'https://github.com/eclipse-jdtls/eclipse.jdt.ls',
    install: {
      win32: [{ manager: 'scoop', cmd: 'scoop install jdtls' }],
      darwin: [{ manager: 'brew', cmd: 'brew install jdtls' }],
    },
  },
  {
    language: 'c',
    label: 'C (clangd)',
    command: 'clangd',
    homepage: 'https://clangd.llvm.org/',
    install: {
      win32: [{ manager: 'winget', cmd: 'winget install LLVM.LLVM' }],
      darwin: [{ manager: 'brew', cmd: 'brew install llvm' }],
      linux: [{ manager: 'apt', cmd: 'sudo apt-get install -y clangd' }],
    },
  },
  {
    language: 'cpp',
    label: 'C++ (clangd)',
    command: 'clangd',
    homepage: 'https://clangd.llvm.org/',
    install: {
      win32: [{ manager: 'winget', cmd: 'winget install LLVM.LLVM' }],
      darwin: [{ manager: 'brew', cmd: 'brew install llvm' }],
      linux: [{ manager: 'apt', cmd: 'sudo apt-get install -y clangd' }],
    },
  },
  {
    language: 'go',
    label: 'Go (gopls)',
    command: 'gopls',
    homepage: 'https://pkg.go.dev/golang.org/x/tools/gopls',
    install: {
      win32: [{ manager: 'go', cmd: 'go install golang.org/x/tools/gopls@latest' }],
      darwin: [{ manager: 'go', cmd: 'go install golang.org/x/tools/gopls@latest' }],
      linux: [{ manager: 'go', cmd: 'go install golang.org/x/tools/gopls@latest' }],
    },
  },
  {
    language: 'php',
    label: 'PHP (Intelephense)',
    command: 'intelephense',
    homepage: 'https://github.com/bmewburn/intelephense-docs',
    install: {
      win32: [{ manager: 'npm', cmd: 'npm install -g intelephense' }],
      darwin: [{ manager: 'npm', cmd: 'npm install -g intelephense' }],
      linux: [{ manager: 'npm', cmd: 'npm install -g intelephense' }],
    },
  },
  {
    language: 'csharp',
    label: 'C# (csharp-ls)',
    command: 'csharp-ls',
    candidates: ['omnisharp'],
    homepage: 'https://github.com/razzmatazz/csharp-language-server',
    install: {
      win32: [{ manager: 'dotnet', cmd: 'dotnet tool install -g csharp-ls' }],
      darwin: [{ manager: 'dotnet', cmd: 'dotnet tool install -g csharp-ls' }],
      linux: [{ manager: 'dotnet', cmd: 'dotnet tool install -g csharp-ls' }],
    },
  },
  {
    language: 'rust',
    label: 'Rust (rust-analyzer)',
    command: 'rust-analyzer',
    homepage: 'https://rust-analyzer.github.io/',
    install: {
      win32: [{ manager: 'rustup', cmd: 'rustup component add rust-analyzer' }],
      darwin: [{ manager: 'rustup', cmd: 'rustup component add rust-analyzer' }],
      linux: [{ manager: 'rustup', cmd: 'rustup component add rust-analyzer' }],
    },
  },
  {
    language: 'lua',
    label: 'Lua (lua-language-server)',
    command: 'lua-language-server',
    homepage: 'https://github.com/LuaLS/lua-language-server',
    install: {
      win32: [{ manager: 'winget', cmd: 'winget install LuaLS.lua-language-server' }],
      darwin: [{ manager: 'brew', cmd: 'brew install lua-language-server' }],
      linux: [{ manager: 'brew', cmd: 'brew install lua-language-server' }],
    },
  },
]

/**
 * Optional file-existence probe for unit tests. Production callers leave
 * it undefined, in which case we use `node:fs.existsSync` against real
 * paths. Tests inject a fake to simulate "shim exists at this path".
 */
export type NpmShimScanner = {
  /** Returns true when an executable shim exists at `absolutePath`. */
  exists: (absolutePath: string) => boolean
  /** Returns the npm global prefix, or null if it can't be determined. */
  resolvePrefix: () => string | null
}

const defaultScanner: NpmShimScanner = {
  exists: (absolutePath) => existsSync(absolutePath),
  resolvePrefix: () => resolveNpmGlobalPrefix(),
}

/**
 * Walk the npm global bin/prefix directory looking for a shim that
 * matches `command`. We try the platform-appropriate suffixes — on
 * Windows npm drops `.cmd`, `.ps1`, and the bare extension-less script
 * side-by-side, so any of them counts as "installed". POSIX npm puts
 * the unqualified executable under `<prefix>/bin/<cmd>`.
 *
 * Returns the absolute path of the first match, or null when nothing
 * is found. Never throws — a missing prefix or unreadable directory
 * just means the fallback declines to fire.
 */
export function findNpmShim(
  command: string,
  scanner: NpmShimScanner = defaultScanner,
): string | null {
  const prefix = scanner.resolvePrefix()
  if (!prefix) return null

  const isWindows = process.platform === 'win32'
  // npm on Windows installs shims directly under `<prefix>\<cmd>.cmd`;
  // on POSIX they go under `<prefix>/bin/<cmd>`.
  const candidatePaths = isWindows
    ? [
        join(prefix, `${command}.cmd`),
        join(prefix, `${command}.ps1`),
        join(prefix, `${command}.exe`),
        join(prefix, command),
      ]
    : [join(prefix, 'bin', command), join(prefix, command)]

  for (const candidate of candidatePaths) {
    if (scanner.exists(candidate)) return candidate
  }
  return null
}

/**
 * Resolve the npm global prefix without spawning npm (which would be
 * slow and racy). We honour the same env precedence npm uses:
 * `NPM_CONFIG_PREFIX` first, then platform defaults — `%APPDATA%\npm`
 * on Windows, `<HOME>/.npm-global` and the standard `/usr/local` on
 * POSIX. Returns null when none of the candidates exist on disk so
 * callers can decline the fallback rather than scanning bogus paths.
 */
function resolveNpmGlobalPrefix(): string | null {
  const envPrefix = process.env.NPM_CONFIG_PREFIX
  if (envPrefix && existsSync(envPrefix)) return envPrefix

  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA
    if (appdata) {
      const winPrefix = join(appdata, 'npm')
      if (existsSync(winPrefix)) return winPrefix
    }
    return null
  }

  const home = process.env.HOME
  const candidates = [
    home ? join(home, '.npm-global') : null,
    '/usr/local',
  ].filter((p): p is string => Boolean(p))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Optional dependency overrides for unit tests. Production callers leave
 * these undefined and the real `probeHostCommands` + `existsSync` paths
 * run. Tests inject fakes to avoid touching the host shell or filesystem.
 */
export type LanguageServerProbeOptions = {
  scanner?: NpmShimScanner
  probe?: (
    commands: ReadonlyArray<string>,
  ) => Promise<Map<string, PrerequisiteProbeResult>>
}

/**
 * Probe every known language server against PATH and return per-language
 * install status. All probe names are batched + de-duped through
 * `probeHostCommands` so e.g. `clangd` (shared by C and C++) is probed
 * once. Each language resolves to the first of `[command, ...candidates]`
 * that is present.
 *
 * For npm-installable servers we apply a fallback: when PATH probing
 * fails, scan the npm global prefix/bin directory directly. This covers
 * the common Windows pitfall where `npm install -g pyright` succeeds but
 * `%APPDATA%\npm` is missing from PATH, which would otherwise leave the
 * UI permanently stuck at "missing" until the user edits PATH.
 */
export async function getKnownLanguageServerStatuses(
  options: LanguageServerProbeOptions = {},
): Promise<KnownLanguageServerStatus[]> {
  const scanner = options.scanner ?? defaultScanner
  const probe = options.probe ?? probeHostCommands

  const allCommands = KNOWN_LANGUAGE_SERVERS.flatMap((server) => [
    server.command,
    ...(server.candidates ?? []),
  ])

  const probed = await probe(allCommands)

  return KNOWN_LANGUAGE_SERVERS.map((server) => {
    const ordered = [server.command, ...(server.candidates ?? [])]
    let resolvedCommand: string | null = null
    let resolvedPath: string | null = null
    for (const cmd of ordered) {
      const result = probed.get(cmd.trim())
      if (result?.installed) {
        resolvedCommand = result.command
        resolvedPath = result.resolvedPath
        break
      }
    }

    if (resolvedCommand === null && hasNpmInstallStep(server)) {
      for (const cmd of ordered) {
        const shim = findNpmShim(cmd, scanner)
        if (shim) {
          resolvedCommand = cmd
          resolvedPath = shim
          break
        }
      }
    }

    return {
      ...server,
      installed: resolvedCommand !== null,
      resolvedPath,
      resolvedCommand,
    }
  })
}

function hasNpmInstallStep(server: KnownLanguageServer): boolean {
  const platforms: Array<keyof LanguageServerInstallMap> = [
    'win32',
    'darwin',
    'linux',
  ]
  for (const platform of platforms) {
    const steps = server.install[platform]
    if (steps?.some((step) => step.manager === 'npm')) return true
  }
  return false
}

/**
 * Reset the shared prerequisite probe cache so the desktop's "recheck"
 * affordance re-probes PATH right after the user installs a server.
 */
export function clearKnownLanguageServerCache(): void {
  clearPrerequisitesCache()
}
