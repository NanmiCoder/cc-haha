import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyUserStateGuard,
  buildSandboxLaneEnv,
  createQualityGateSandbox,
  describeUserStateMutations,
  fingerprintUserState,
  sandboxTranscriptEvidence,
  seedProviderState,
} from './sandbox'

const scratchDirs: string[] = []

function scratch(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), `cc-haha-sandbox-test-${prefix}-`))
  scratchDirs.push(dir)
  return dir
}

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value) + '\n')
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true })
  }
})

describe('sandbox lane environment', () => {
  test('redirects config, home, and temp away from the developer machine', () => {
    const home = scratch('env-home')
    const env = buildSandboxLaneEnv(home, {}, {
      HOME: '/Users/real',
      USERPROFILE: 'C:/Users/real',
      CLAUDE_CONFIG_DIR: '/Users/real/.claude',
      PATH: '/usr/bin',
    })

    expect(env.HOME).toBe(home)
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(home, '.claude'))
    expect(env.CLAUDE_CONFIG_DIR.startsWith(home)).toBe(true)
    expect(env.TMPDIR.startsWith(home)).toBe(true)
    expect(Object.values(env)).not.toContain('/Users/real/.claude')
    // The product server must behave like production, not like a unit test.
    expect(env.NODE_ENV).toBeUndefined()
  })

  test('passes through proxy and env-provider credentials a live lane needs', () => {
    const home = scratch('env-live')
    const env = buildSandboxLaneEnv(home, {}, {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      no_proxy: 'localhost',
      QUALITY_GATE_PROVIDER_BASE_URL: 'https://gateway.example/v1',
      QUALITY_GATE_PROVIDER_API_KEY: 'test-key',
      QUALITY_GATE_PROVIDER_MODEL: 'some-model',
      ANTHROPIC_API_KEY: 'must-not-leak',
      AWS_SECRET_ACCESS_KEY: 'must-not-leak',
    })

    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.no_proxy).toBe('localhost')
    expect(env.QUALITY_GATE_PROVIDER_BASE_URL).toBe('https://gateway.example/v1')
    expect(env.QUALITY_GATE_PROVIDER_MODEL).toBe('some-model')
    // Ambient vendor credentials stay out: a lane must use the provider it was told
    // to use, not whatever happens to be exported in the developer's shell.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  })

  test('lets an explicit override win over the sandbox default', () => {
    const home = scratch('env-override')
    const env = buildSandboxLaneEnv(home, { NODE_ENV: 'production' }, { PATH: '/usr/bin' })
    expect(env.NODE_ENV).toBe('production')
  })
})

describe('provider state seeding', () => {
  test('copies provider identity and credentials but not regenerable local state', () => {
    const source = scratch('seed-source')
    const target = scratch('seed-target')
    writeJson(join(source, 'cc-haha', 'providers.json'), { activeId: 'p1', providers: [{ id: 'p1', name: 'Gateway' }] })
    writeJson(join(source, 'cc-haha', 'settings.json'), { env: { ANTHROPIC_BASE_URL: 'https://gateway.example' } })
    writeJson(join(source, 'cc-haha', 'oauth.json'), { token: 'secret' })
    mkdirSync(join(source, 'cc-haha', 'db'), { recursive: true })
    writeFileSync(join(source, 'cc-haha', 'db', 'index-v1.sqlite'), 'binary')
    mkdirSync(join(source, 'cc-haha', 'diagnostics'), { recursive: true })
    writeFileSync(join(source, 'cc-haha', 'diagnostics', 'run.log'), 'noise')
    writeJson(join(source, 'settings.json'), { permissionMode: 'plan' })

    const copied = seedProviderState(source, target)

    expect(copied).toEqual(['providers.json', 'settings.json', 'oauth.json'])
    expect(JSON.parse(readFileSync(join(target, 'cc-haha', 'providers.json'), 'utf8')).activeId).toBe('p1')
    expect(existsSync(join(target, 'cc-haha', 'db'))).toBe(false)
    expect(existsSync(join(target, 'cc-haha', 'diagnostics'))).toBe(false)
    // The user-level settings.json is never seeded: a lane must not inherit the
    // developer's permission mode, and must not be able to write it back.
    expect(existsSync(join(target, 'settings.json'))).toBe(false)
  })

  test('is a no-op when the developer has no provider state', () => {
    const source = scratch('seed-empty-source')
    const target = scratch('seed-empty-target')
    expect(seedProviderState(source, target)).toEqual([])
  })
})

describe('user state guard', () => {
  test('reports created, modified, and deleted guarded files', () => {
    const config = scratch('guard-diff')
    writeJson(join(config, 'settings.json'), { permissionMode: 'default' })
    writeJson(join(config, 'cc-haha', 'providers.json'), { activeId: 'p1' })
    const before = fingerprintUserState(config)

    writeJson(join(config, 'settings.json'), { permissionMode: 'bypassPermissions', extra: true })
    writeJson(join(config, 'cc-haha', 'oauth.json'), { token: 'new' })
    rmSync(join(config, 'cc-haha', 'providers.json'))

    expect(describeUserStateMutations(before, fingerprintUserState(config))).toEqual([
      'created: cc-haha/oauth.json',
      'deleted: cc-haha/providers.json',
      'modified: settings.json',
    ])
  })

  test('ignores unguarded paths that a concurrent CLI session writes', () => {
    const config = scratch('guard-noise')
    writeJson(join(config, 'settings.json'), { permissionMode: 'default' })
    const before = fingerprintUserState(config)

    mkdirSync(join(config, 'projects', 'some-project'), { recursive: true })
    writeFileSync(join(config, 'projects', 'some-project', 'session.jsonl'), '{}\n')
    mkdirSync(join(config, 'file-history'), { recursive: true })
    writeFileSync(join(config, 'file-history', 'entry.json'), '{}')

    expect(describeUserStateMutations(before, fingerprintUserState(config))).toEqual([])
  })

  test('fails a passing lane that wrote the global permission mode', () => {
    // Regression for the desktop smoke, which set bypassPermissions through the
    // real settings API and left it behind whenever the run was interrupted.
    const config = scratch('guard-permission')
    const artifacts = scratch('guard-artifacts')
    writeJson(join(config, 'settings.json'), { permissionMode: 'default' })
    const before = fingerprintUserState(config)
    writeJson(join(config, 'settings.json'), { permissionMode: 'bypassPermissions' })

    const guarded = applyUserStateGuard(
      { id: 'desktop-smoke', status: 'passed' as string, durationMs: 1 },
      {
        configDir: config,
        detectUserStateMutations: () => describeUserStateMutations(before, fingerprintUserState(config)),
      },
      artifacts,
    )

    expect(guarded.status).toBe('failed')
    expect(guarded.error).toContain('settings.json')
    const evidence = JSON.parse(readFileSync(join(artifacts, 'user-state-guard.json'), 'utf8'))
    expect(evidence.realConfigMutations).toEqual(['modified: settings.json'])
  })

  test('keeps a clean lane passing and records transcript isolation evidence', () => {
    const config = scratch('guard-clean')
    const sandboxConfig = scratch('guard-clean-sandbox')
    const artifacts = scratch('guard-clean-artifacts')
    writeJson(join(config, 'settings.json'), { permissionMode: 'default' })
    mkdirSync(join(sandboxConfig, 'projects', '-tmp-fixture'), { recursive: true })
    writeFileSync(join(sandboxConfig, 'projects', '-tmp-fixture', 'abc.jsonl'), '{}\n')

    const guarded = applyUserStateGuard(
      { id: 'baseline', status: 'passed' as string, durationMs: 1 },
      { configDir: sandboxConfig, detectUserStateMutations: () => [] },
      artifacts,
    )

    expect(guarded.status).toBe('passed')
    const evidence = JSON.parse(readFileSync(join(artifacts, 'user-state-guard.json'), 'utf8'))
    expect(evidence.sandboxTranscripts).toEqual({ projectDirs: ['-tmp-fixture'], transcriptFiles: 1 })
  })

  test('counts sandbox transcripts so isolation is proved positively', () => {
    const sandboxConfig = scratch('transcripts')
    expect(sandboxTranscriptEvidence(sandboxConfig)).toEqual({ projectDirs: [], transcriptFiles: 0 })

    mkdirSync(join(sandboxConfig, 'projects', 'b-project'), { recursive: true })
    mkdirSync(join(sandboxConfig, 'projects', 'a-project'), { recursive: true })
    writeFileSync(join(sandboxConfig, 'projects', 'a-project', 'one.jsonl'), '{}\n')
    writeFileSync(join(sandboxConfig, 'projects', 'a-project', 'notes.txt'), 'ignored')
    writeFileSync(join(sandboxConfig, 'projects', 'b-project', 'two.jsonl'), '{}\n')

    expect(sandboxTranscriptEvidence(sandboxConfig)).toEqual({
      projectDirs: ['a-project', 'b-project'],
      transcriptFiles: 2,
    })
  })
})

describe('sandbox lifecycle', () => {
  test('creates an isolated config dir seeded from the given source and cleans up', () => {
    const source = scratch('lifecycle-source')
    writeJson(join(source, 'cc-haha', 'providers.json'), { activeId: 'p1', providers: [{ id: 'p1', name: 'Gateway' }] })
    writeJson(join(source, 'settings.json'), { permissionMode: 'plan' })

    const sandbox = createQualityGateSandbox({
      label: 'lifecycle',
      seedProviders: true,
      sourceConfigDir: source,
      source: { PATH: '/usr/bin' },
    })

    expect(sandbox.configDir.startsWith(sandbox.home)).toBe(true)
    expect(existsSync(join(sandbox.configDir, 'cc-haha', 'providers.json'))).toBe(true)
    expect(existsSync(join(sandbox.configDir, 'settings.json'))).toBe(false)
    expect(sandbox.detectUserStateMutations()).toEqual([])

    writeJson(join(source, 'settings.json'), { permissionMode: 'bypassPermissions' })
    expect(sandbox.detectUserStateMutations()).toEqual(['modified: settings.json'])

    const home = sandbox.home
    sandbox.cleanup()
    expect(existsSync(home)).toBe(false)
  })
})
