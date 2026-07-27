import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('feature quality contract', () => {
  test('keeps root agent guidance small, high-signal, and layered', () => {
    const agents = readFileSync('AGENTS.md', 'utf8')

    // Codex has a 32 KiB default budget for the complete instruction chain.
    // Keep the root well below that limit so nested guidance has room to load.
    expect(Buffer.byteLength(agents)).toBeLessThan(16 * 1024)
    expect(agents).toContain('## Start Here')
    expect(agents).toContain('## Repository Map')
    expect(agents).toContain('## Verification')
    expect(agents).toContain('## User-State Safety')
    expect(agents).toContain('## Handoff')
    expect(agents).toContain('read the nested `AGENTS.md` in that directory')
    expect(agents).toContain('Tool access is capability, not authorization.')
    expect(agents).toContain('same-area regression test')
    expect(agents).toContain('`bun run check:impact`')
    expect(agents).toContain('`bun run verify`')
    expect(agents).toContain('Required PR checks must be deterministic')
    expect(agents).toContain('finding credentials on the machine is not authorization')
    expect(agents).toContain('`bun run check:persistence-upgrade`')
    expect(agents).toContain('`~/.claude/settings.json` as user-owned shared state')
    expect(agents).toContain('commands actually run and their observed results')
  })

  test('keeps specialized agent guidance next to the affected code', () => {
    const policy = readFileSync('.github/AGENTS.md', 'utf8')
    const runtime = readFileSync('src/AGENTS.md', 'utf8')
    const desktop = readFileSync('desktop/AGENTS.md', 'utf8')
    const adapters = readFileSync('adapters/AGENTS.md', 'utf8')
    const docs = readFileSync('docs/AGENTS.md', 'utf8')

    expect(policy).toContain('`scripts/pr/change-policy.ts` is the source of truth')
    expect(policy).toContain('`pull_request_target`')
    expect(policy).toContain('`pr-quality-gate`')
    expect(runtime).toContain('`bun run check:server`')
    expect(runtime).toContain('temporary `HOME`/`CLAUDE_CONFIG_DIR`')
    expect(runtime).toContain('`bun run check:provider-contract`')
    expect(desktop).toContain('`bun run check:desktop`')
    expect(desktop).toContain('`bun run check:chat-contract`')
    expect(adapters).toContain('`bun run check:adapters`')
    expect(docs).toContain('`bun run check:docs`')
  })

  test('keeps PR authors accountable for tests, coverage, E2E, and risk', () => {
    const template = readFileSync('.github/pull_request_template.md', 'utf8')

    expect(template).toContain('## Feature Quality Contract')
    expect(template).toContain('Changed surface:')
    expect(template).toContain('Tests added or updated:')
    expect(template).toContain('Coverage evidence:')
    expect(template).toContain('changed-line coverage')
    expect(template).toContain('E2E / live-model evidence:')
    expect(template).toContain('Known risk / rollback:')
    expect(template).toContain('I added or updated same-area tests')
  })

  test('keeps quality policy and cross-process boundaries maintainer-owned', () => {
    const codeowners = readFileSync('.github/CODEOWNERS', 'utf8')

    expect(codeowners).toContain('/.github/workflows/ @NanmiCoder')
    expect(codeowners).toContain('/AGENTS.md @NanmiCoder')
    expect(codeowners).toContain('**/AGENTS.md @NanmiCoder')
    expect(codeowners).toContain('/CONTRIBUTING.md @NanmiCoder')
    expect(codeowners).toContain('/scripts/pr/ @NanmiCoder')
    expect(codeowners).toContain('/scripts/quality-gate/ @NanmiCoder')
    expect(codeowners).toContain('/desktop/src/api/websocket* @NanmiCoder')
    expect(codeowners).toContain('/desktop/src/lib/persistenceMigrations* @NanmiCoder')
    expect(codeowners).toContain('/src/server/services/conversationService* @NanmiCoder')
    expect(codeowners).toContain('/src/server/proxy/ @NanmiCoder')
    expect(codeowners).toContain('/src/server/ws/ @NanmiCoder')
    expect(codeowners).toContain('/src/services/openaiAuth/ @NanmiCoder')
    expect(codeowners).toContain('/src/utils/model/ @NanmiCoder')
  })

  test('keeps the one-command verification entrypoint documented', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>
    }
    const prePushHook = readFileSync('scripts/git-hooks/pre-push', 'utf8')
    const contributing = readFileSync('docs/internals/contributing.md', 'utf8')
    const englishContributing = readFileSync('docs/en/internals/contributing.md', 'utf8')
    const rootContributing = readFileSync('CONTRIBUTING.md', 'utf8')

    expect(packageJson.scripts?.verify).toBe('bun run quality:pr')
    expect(packageJson.scripts?.['quality:verify']).toBe('bun run quality:pr')
    expect(packageJson.scripts?.['quality:push']).toBe('bun run quality:gate --mode pr --skip coverage')
    expect(packageJson.scripts?.['check:persistence-upgrade']).toBe('bun run scripts/quality-gate/persistence-upgrade.ts')
    expect(packageJson.scripts?.['check:provider-contract']).toBe('bun run scripts/pr/run-provider-contract-tests.ts')
    expect(packageJson.scripts?.['check:chat-contract']).toBe('bun run scripts/pr/run-chat-contract-tests.ts')
    expect(packageJson.scripts?.['check:policy']).toContain('bun test ./scripts/')
    expect(packageJson.scripts?.['check:native']).toContain('electron:package:dir')
    expect(packageJson.scripts?.['check:native']).toContain('test:package-smoke:current')
    expect(packageJson.scripts?.['test:package-smoke:current']).toBe('bun run scripts/quality-gate/package-smoke/current.ts')
    expect(prePushHook).toContain('non-blocking')
    expect(prePushHook).not.toContain('\nbun run quality:push\n')
    expect(prePushHook).not.toContain('quality:gate')
    expect(prePushHook).not.toContain('quality:smoke')
    expect(contributing).toContain('bun run verify')
    expect(contributing).toContain('bun run quality:push')
    expect(contributing).toContain('push 不再自动运行本地质量门禁')
    expect(contributing).toContain('AI Coding Agent 修复循环')
    expect(englishContributing).toContain('bun run verify')
    expect(englishContributing).toContain('bun run quality:push')
    expect(englishContributing).toContain('push no longer runs a local quality gate')
    expect(englishContributing).toContain('AI Coding Agent Fix Loop')
    expect(rootContributing).toContain('bun run verify')
    expect(rootContributing).toContain('bun run quality:push')
    expect(rootContributing).toContain('不再自动运行本地质量门禁')
  })

  test('keeps desktop native CI aligned with Electron packaging', () => {
    const prQuality = readFileSync('.github/workflows/pr-quality.yml', 'utf8')
    const buildSidecars = readFileSync('desktop/scripts/build-sidecars.ts', 'utf8')

    expect(prQuality).toContain('run: bun run check:native')
    expect(prQuality).not.toContain('dtolnay/rust-toolchain')
    expect(prQuality).not.toContain('swatinem/rust-cache')
    expect(prQuality).not.toContain('libwebkit2gtk')
    expect(prQuality).not.toContain('libayatana-appindicator')
    expect(buildSidecars).not.toContain("Bun.spawn(['rustc'")
    expect(buildSidecars).toContain("process.platform")
    expect(buildSidecars).toContain("process.arch")
  })

  test('keeps stateful server tests deterministic', () => {
    const serverRunner = readFileSync('scripts/pr/run-server-tests.ts', 'utf8')
    const providerRunner = readFileSync('scripts/pr/run-provider-contract-tests.ts', 'utf8')
    const chatRunner = readFileSync('scripts/pr/run-chat-contract-tests.ts', 'utf8')
    const testEnvironment = readFileSync('scripts/pr/test-environment.ts', 'utf8')
    const coverageRunner = readFileSync('scripts/quality-gate/coverage.ts', 'utf8')

    expect(serverRunner).toContain("'--max-concurrency=1'")
    expect(serverRunner).toContain("'--timeout=20000'")
    expect(serverRunner).toContain('TEST_PROCESS_CONCURRENCY = 4')
    expect(serverRunner).toContain('TEST_FILE_PATTERN')
    expect(serverRunner).toContain("'--no-env-file'")
    expect(serverRunner).toContain('createSandboxedTestEnvironment')
    expect(serverRunner).toContain('rootBunTestFilter(file)')
    expect(serverRunner).toContain('evidenceComplete')
    expect(serverRunner).toContain('reportedFiles === 1')
    expect(serverRunner).toContain('passedTests + failedTests > 0')
    expect(testEnvironment).toContain('CLAUDE_CONFIG_DIR:')
    expect(testEnvironment).toContain("BUN_OPTIONS: '--no-env-file'")
    expect(coverageRunner).toContain('TEST_FILE_PATTERN')
    expect(coverageRunner).toContain("'--no-env-file'")
    expect(coverageRunner).toContain('createSandboxedTestEnvironment')
    expect(coverageRunner).toContain('serverFiles.map(rootBunTestFilter)')
    expect(coverageRunner).toContain("correctness is enforced by check:server's per-file sandboxed test processes")
    expect(coverageRunner).toContain('rootCoverageAvailable')
    expect(coverageRunner).toContain('rootTestDiscoveryComplete')
    expect(coverageRunner).toContain("id: 'root-runtime'")
    for (const contractRunner of [providerRunner, chatRunner]) {
      expect(contractRunner).toContain("'--no-env-file'")
      expect(contractRunner).toContain('createSandboxedTestEnvironment')
      expect(contractRunner).toContain('rootBunTestFilter')
    }
  })

  test('keeps general AI coding tools pointed at the same quality bar', () => {
    const instructions = readFileSync('.github/copilot-instructions.md', 'utf8')

    expect(instructions).toContain('Follow the root `AGENTS.md` and the nearest nested `AGENTS.md`')
    expect(instructions).toContain('Add same-area tests with the production change')
    expect(instructions).toContain('Preserve or improve the coverage ratchet')
    expect(instructions).toContain('changed-line coverage threshold')
    expect(instructions).toContain('E2E or agent-browser smoke')
    expect(instructions).toContain('Provider/auth/runtime-env/model-window/proxy changes require offline `bun run check:provider-contract`')
    expect(instructions).toContain('Live smoke is trusted-maintainer evidence only and requires explicit authorization')
    expect(instructions).toContain('include changed files, tests added, commands actually run with pass/fail counts')
  })
})
