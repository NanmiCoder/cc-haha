import { describe, expect, it } from 'bun:test'
import {
  KNOWN_LANGUAGE_SERVERS,
  getKnownLanguageServerStatuses,
} from './knownLanguageServers.js'
import type { PrerequisiteProbeResult } from './prerequisitesService.js'

const SAFE_COMMAND = /^[A-Za-z0-9._+\-]+$/

const NO_SHIM_SCANNER = {
  exists: () => false,
  resolvePrefix: () => null,
} as const

function makeProbe(
  resolved: Record<string, string | null>,
): (commands: ReadonlyArray<string>) => Promise<Map<string, PrerequisiteProbeResult>> {
  return async (commands) => {
    const map = new Map<string, PrerequisiteProbeResult>()
    for (const command of [...new Set(commands.map((c) => c.trim()))]) {
      const path = resolved[command] ?? null
      map.set(command, {
        command,
        installed: path !== null,
        resolvedPath: path,
      })
    }
    return map
  }
}

describe('KNOWN_LANGUAGE_SERVERS presets', () => {
  it('covers the requested languages', () => {
    const ids = KNOWN_LANGUAGE_SERVERS.map((s) => s.language).sort()
    expect(ids).toEqual(
      ['c', 'cpp', 'csharp', 'go', 'java', 'lua', 'php', 'python', 'rust', 'typescript'].sort(),
    )
  })

  it('uses bare, shell-safe probe command names', () => {
    for (const server of KNOWN_LANGUAGE_SERVERS) {
      expect(SAFE_COMMAND.test(server.command)).toBe(true)
      for (const candidate of server.candidates ?? []) {
        expect(SAFE_COMMAND.test(candidate)).toBe(true)
      }
    }
  })

  it('declares at least one install step on at least one platform', () => {
    for (const server of KNOWN_LANGUAGE_SERVERS) {
      const steps = [
        ...(server.install.win32 ?? []),
        ...(server.install.darwin ?? []),
        ...(server.install.linux ?? []),
      ]
      expect(steps.length).toBeGreaterThan(0)
      for (const step of steps) {
        expect(step.manager.length).toBeGreaterThan(0)
        expect(step.cmd.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('getKnownLanguageServerStatuses', () => {
  it('maps probe results to installed/resolvedPath and de-dups probes', async () => {
    let probeCalls = 0
    let lastBatch: ReadonlyArray<string> | null = null
    const probe = async (commands: ReadonlyArray<string>) => {
      probeCalls += 1
      lastBatch = commands
      const map = new Map<string, PrerequisiteProbeResult>()
      for (const command of [...new Set(commands.map((c) => c.trim()))]) {
        // Simulate only gopls + clangd present on this host.
        const installed = command === 'gopls' || command === 'clangd'
        map.set(command, {
          command,
          installed,
          resolvedPath: installed ? `/usr/bin/${command}` : null,
        })
      }
      return map
    }

    const statuses = await getKnownLanguageServerStatuses({
      probe,
      scanner: NO_SHIM_SCANNER,
    })

    // clangd shared by C and C++ — probed once via dedup, so the call
    // count is 1 but the flat input list still mentions it twice.
    expect(probeCalls).toBe(1)
    const clangdCount = (lastBatch ?? []).filter((c) => c === 'clangd').length
    expect(clangdCount).toBe(2)

    const go = statuses.find((s) => s.language === 'go')
    expect(go?.installed).toBe(true)
    expect(go?.resolvedPath).toBe('/usr/bin/gopls')
    expect(go?.resolvedCommand).toBe('gopls')

    const c = statuses.find((s) => s.language === 'c')
    const cpp = statuses.find((s) => s.language === 'cpp')
    expect(c?.installed).toBe(true)
    expect(cpp?.installed).toBe(true)
    expect(c?.resolvedPath).toBe('/usr/bin/clangd')

    const python = statuses.find((s) => s.language === 'python')
    expect(python?.installed).toBe(false)
    expect(python?.resolvedPath).toBeNull()
    expect(python?.resolvedCommand).toBeNull()
  })

  it('resolves a fallback candidate when the primary command is absent', async () => {
    const statuses = await getKnownLanguageServerStatuses({
      probe: makeProbe({ pyright: '/usr/bin/pyright' }),
      scanner: NO_SHIM_SCANNER,
    })
    const python = statuses.find((s) => s.language === 'python')
    expect(python?.installed).toBe(true)
    expect(python?.resolvedCommand).toBe('pyright')
    expect(python?.resolvedPath).toBe('/usr/bin/pyright')
  })

  it('falls back to npm global bin for npm-installable servers when PATH probe misses', async () => {
    // Nothing on PATH at all — simulates the user's reported state where
    // `npm install -g pyright` succeeded but the npm global bin dir is
    // missing from PATH so `where` / `command -v` finds nothing.
    const probe = makeProbe({})

    // Use a platform-neutral fakePrefix so the test passes on Windows CI
    // *and* Linux CI. The scanner just answers "exists?" against whatever
    // path findNpmShim asks about — we accept the first match (the primary
    // command) regardless of which platform-specific path findNpmShim built.
    const isWindows = process.platform === 'win32'
    const fakePrefix = isWindows ? 'C:\\fake\\npm' : '/fake/npm'

    // Track the queries the scanner sees so we can assert non-npm gating.
    const probedPaths: string[] = []
    const scanner = {
      exists: (path: string) => {
        probedPaths.push(path)
        // Pretend pyright-langserver, pyright, and intelephense all have
        // shims. Anything else does not.
        return /(pyright-langserver|pyright|intelephense)(\.cmd|\.ps1|\.exe)?$/.test(
          path,
        )
      },
      resolvePrefix: () => fakePrefix,
    }

    const statuses = await getKnownLanguageServerStatuses({ probe, scanner })

    const python = statuses.find((s) => s.language === 'python')
    // Primary `pyright-langserver` shim is present, so it wins over
    // the fallback candidate.
    expect(python?.installed).toBe(true)
    expect(python?.resolvedCommand).toBe('pyright-langserver')
    expect(python?.resolvedPath).toContain('pyright-langserver')

    const php = statuses.find((s) => s.language === 'php')
    expect(php?.installed).toBe(true)
    expect(php?.resolvedPath).toContain('intelephense')

    // Non-npm servers stay missing — the fallback only fires for
    // installs declared with `manager: 'npm'`. Verify the gate didn't
    // even ask the scanner about non-npm command names.
    const rust = statuses.find((s) => s.language === 'rust')
    expect(rust?.installed).toBe(false)
    for (const probed of probedPaths) {
      expect(probed).not.toContain('rust-analyzer')
      expect(probed).not.toContain('gopls')
      expect(probed).not.toContain('clangd')
      expect(probed).not.toContain('jdtls')
      expect(probed).not.toContain('lua-language-server')
    }
  })

  it('does not invoke the npm fallback for non-npm servers', async () => {
    // A scanner that *would* claim every shim exists. If the gate works
    // correctly, rust-analyzer / clangd / gopls / jdtls / csharp-ls /
    // omnisharp / lua-language-server still come back as not-installed
    // because none of them declare an `npm` install step.
    const probedCommands: string[] = []
    const scanner = {
      exists: (path: string) => {
        probedCommands.push(path)
        return true
      },
      resolvePrefix: () => '/fake/prefix',
    }

    const statuses = await getKnownLanguageServerStatuses({
      probe: makeProbe({}),
      scanner,
    })

    const nonNpmLanguages = ['rust', 'go', 'java', 'csharp', 'c', 'cpp', 'lua']
    for (const language of nonNpmLanguages) {
      const status = statuses.find((s) => s.language === language)
      expect(status, `language ${language}`).toBeDefined()
      expect(status?.installed, `language ${language}`).toBe(false)
    }

    // Sanity: the gate didn't even ask the scanner about non-npm commands.
    for (const probed of probedCommands) {
      expect(probed).not.toContain('rust-analyzer')
      expect(probed).not.toContain('gopls')
      expect(probed).not.toContain('clangd')
      expect(probed).not.toContain('jdtls')
      expect(probed).not.toContain('csharp-ls')
      expect(probed).not.toContain('omnisharp')
      expect(probed).not.toContain('lua-language-server')
    }
  })
})
