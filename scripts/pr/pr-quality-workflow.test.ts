import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { createSandboxedTestEnvironment } from './test-environment'
import { assertOutsideSourceGit, cleanupPreparedWindowsInstallerTests, downloadPinnedInstaller, historicalInstallerFixture, pinnedNsisCompiler, pinnedNsisResources, prepareWindowsInstallerTests, verifyInstallerFixture } from './prepare-windows-installer-tests'
import { runWindowsInstallerChecks } from './run-windows-installer-checks'
import { profileFixtureSources, profileOnlyPacketSources, runWindowsInstallerProfileChecks, validateF1NativeCanaryResult, validateProfileOnlyPreflightResult, validateStageAResult } from './run-windows-installer-profile-checks'
import { createHash } from 'node:crypto'

type WorkflowJob = {
  if?: string
  'runs-on'?: string
  'continue-on-error'?: boolean
  needs?: string | string[]
  strategy?: { 'fail-fast'?: boolean; matrix?: { shard?: number[] } }
  steps?: Array<{
    name?: string
    run?: string
    uses?: string
    if?: string
    'continue-on-error'?: boolean
    with?: Record<string, unknown>
    'working-directory'?: string
  }>
}

function workflowJobs(workflow: string) {
  return (parse(workflow) as { jobs: Record<string, WorkflowJob> }).jobs
}

/** A step runs `command`, possibly with arguments such as a CI shard. */
function runsCommand(step: { run?: string }, command: string) {
  return step.run === command || Boolean(step.run?.startsWith(`${command} `))
}

describe('PR quality workflow', () => {
  test('uses packageManager as the single pinned Bun version source', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      packageManager?: string
    }
    const setupBunStepCount = workflow.match(/uses: oven-sh\/setup-bun@v2/g)?.length ?? 0
    const versionFileCount = workflow.match(/bun-version-file: package\.json/g)?.length ?? 0

    expect(packageJson.packageManager).toBe('bun@1.4.3')
    expect(setupBunStepCount).toBeGreaterThan(0)
    expect(versionFileCount).toBe(setupBunStepCount)
    expect(workflow).not.toContain('bun-version:')
    expect(workflow).not.toContain('1.3.12')
    expect(workflow).not.toContain('bun-version: latest')
  })

  test('builds scope before routing independent quality jobs', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')

    expect(workflow).toContain('scope-plan:')
    expect(workflow).toContain('--plan-only')
    expect(workflow).toContain("if: needs.scope-plan.outputs.desktop_checks == 'true'")
    expect(workflow).toContain("if: needs.scope-plan.outputs.server_checks == 'true'")
    expect(workflow).toContain("if: needs.scope-plan.outputs.provider_contract_checks == 'true'")
    expect(workflow).toContain("if: needs.scope-plan.outputs.chat_contract_checks == 'true'")
    expect(workflow).toContain("if: needs.scope-plan.outputs.persistence_checks == 'true'")
    expect(workflow).toContain("if: needs.scope-plan.outputs.adapter_checks == 'true'")
    expect(workflow).toContain("if: needs.scope-plan.outputs.desktop_native_checks == 'true'")
    expect(workflow).toContain("if: needs.scope-plan.outputs.docs_checks == 'true'")
    expect(workflow).toContain("if: github.event_name == 'pull_request' && needs.scope-plan.outputs.coverage_checks == 'true'")
    expect(workflow).toContain("if: needs.scope-plan.outputs.agent_e2e_checks == 'true'")
  })

  test('installs frozen dependencies before policy regressions without blocking product routing', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')
    const jobs = workflowJobs(workflow)
    const policySteps = jobs['policy-enforcement'].steps ?? []
    const installIndex = policySteps.findIndex((step) => step.name === 'Install root dependencies')
    const regressionIndex = policySteps.findIndex((step) => step.name === 'Run policy regression tests')

    expect(jobs['policy-enforcement'].needs).toBe('scope-plan')
    expect(installIndex).toBeGreaterThanOrEqual(0)
    expect(installIndex).toBeLessThan(regressionIndex)
    for (const jobId of [
      'desktop-checks',
      'mobile-checks',
      'server-checks',
      'provider-contract-checks',
      'chat-contract-checks',
      'agent-flow-checks',
      'agent-e2e-checks',
      'adapter-checks',
      'desktop-native-checks',
      'windows-installer-checks',
      'macos-swift-checks',
      'persistence-checks',
      'docs-checks',
      'coverage-checks',
    ]) {
      expect(jobs[jobId].needs).toBe('scope-plan')
    }
  })

  test('installs imported workspace dependencies and ripgrep before runtime and coverage tests', () => {
    const jobs = workflowJobs(readFileSync('.github/workflows/pr-quality.yml', 'utf8'))
    for (const [job, command] of [
      ['server-checks', 'bun run check:server'],
      ['coverage-checks', 'bun run check:coverage'],
      ['desktop-native-checks', 'bun run check:native'],
    ]) {
      const steps = jobs[job].steps ?? []
      const check = steps.findIndex(step => runsCommand(step, command))
      expect(check).toBeGreaterThanOrEqual(0)
      for (const workspace of ['desktop', 'adapters']) {
        const install = steps.findIndex(step =>
          step['working-directory'] === workspace && step.run === 'bun install --frozen-lockfile',
        )
        expect(install).toBeGreaterThanOrEqual(0)
        expect(install).toBeLessThan(check)
      }
      const ripgrep = steps.findIndex(step => step.run?.includes('apt-get install') && /\bripgrep\b/.test(step.run))
      expect(ripgrep).toBeGreaterThanOrEqual(0)
      expect(ripgrep).toBeLessThan(check)
    }
  })

  test('reads CODEOWNERS for the policy exemption from the base branch, not the PR', () => {
    const jobs = workflowJobs(readFileSync('.github/workflows/pr-quality.yml', 'utf8'))
    const runs = (jobs['scope-plan'].steps ?? []).map(step => step.run ?? '').join('\n')

    expect(runs).toContain(`jq -r '.pull_request.user.login' "$GITHUB_EVENT_PATH" > author.txt`)
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')
    expect(workflow).toContain('PR_BASE_SHA: ${{ github.event.pull_request.base.sha }}')
    expect(workflow).toContain('PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}')
    expect(runs).toContain('git show "${PR_BASE_SHA}:.github/CODEOWNERS" > codeowners.txt')
    expect(runs).toContain('--author-file author.txt --codeowners-file codeowners.txt')
    expect(runs).not.toMatch(/cat \.github\/CODEOWNERS|--codeowners-file \.github\/CODEOWNERS/)
  })

  test('collects every PR path beyond 3000 files from immutable commits without an API lookup', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-complete-files-'))
    try {
      const bin = join(root, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "unexpected API lookup" >&2\nexit 99\n')
      chmodSync(join(bin, 'gh'), 0o755)
      const env = createSandboxedTestEnvironment(join(root, 'home'), {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        EVENT_NAME: 'pull_request', REPOSITORY: 'fixture/repo', PR_NUMBER: '1',
        GITHUB_EVENT_PATH: join(root, 'event.json'),
      })
      const git = (args: string[], input?: string) => {
        const result = spawnSync('git', args, { cwd: root, env, input, encoding: 'utf8' })
        expect(result.status, result.stderr).toBe(0)
        return result.stdout.trim()
      }
      git(['init', '-b', 'main'])
      mkdirSync(join(root, '.github'))
      writeFileSync(join(root, '.github/CODEOWNERS'), '* @base-owner\n')
      git(['add', '.github/CODEOWNERS'])
      git(['commit', '-m', 'fixture base'])
      const base = git(['rev-parse', 'HEAD'])
      const blob = git(['hash-object', '-w', '--stdin'], '')
      const paths = [
        ...Array.from({ length: 3005 }, (_, index) => `native/vendor/fixture-${index}.rs`),
        'src/late.ts', 'docs/中文.md', 'src/utils/quote"scope.ts',
        'src/utils/tab\tscope.ts', 'src/utils/line\nscope.ts',
      ]
      git(['update-index', '--add', '-z', '--index-info'], paths.map(name => `100644 ${blob}\t${name}\0`).join(''))
      writeFileSync(join(root, '.github/CODEOWNERS'), '* @head-owner\n')
      git(['add', '.github/CODEOWNERS'])
      const tree = git(['write-tree'])
      const head = git(['commit-tree', tree, '-p', base], 'fixture head\n')
      writeFileSync(join(root, 'event.json'), JSON.stringify({ pull_request: { labels: [{ name: 'fixture-label' }], user: { login: 'contributor' } } }))
      const jobs = workflowJobs(readFileSync('.github/workflows/pr-quality.yml', 'utf8'))
      const script = (jobs['scope-plan'].steps ?? []).find(step => step.name === 'Collect changed files')!.run!
      const result = spawnSync('bash', ['-e', '-c', script], { cwd: root, env: { ...env, PR_BASE_SHA: base, PR_HEAD_SHA: head }, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      const changed = readFileSync(join(root, 'changed-files.nul'), 'utf8').split('\0').filter(Boolean)
      expect(new Set(changed)).toEqual(new Set(['.github/CODEOWNERS', ...paths]))
      const plan = (jobs['scope-plan'].steps ?? []).find(step => step.name === 'Build deterministic scope plan')!.run!
      expect(plan).toContain('--files0 changed-files.nul')
      expect(readFileSync(join(root, 'codeowners.txt'), 'utf8')).toBe('* @base-owner\n')
      expect(readFileSync(join(root, 'author.txt'), 'utf8')).toBe('contributor\n')
      const missing = spawnSync('bash', ['-e', '-c', script], { cwd: root, env: { ...env, PR_BASE_SHA: base, PR_HEAD_SHA: '0'.repeat(40) }, encoding: 'utf8' })
      expect(missing.status).not.toBe(0)
      expect(missing.stderr).not.toContain('unexpected API lookup')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('installs adapter dependencies before desktop checks compile the sidecar bundle', () => {
    const steps = workflowJobs(readFileSync('.github/workflows/pr-quality.yml', 'utf8'))['desktop-checks'].steps ?? []
    const check = steps.findIndex(step => runsCommand(step, 'bun run check:desktop'))
    const install = steps.findIndex(step =>
      step['working-directory'] === 'adapters' && step.run === 'bun install --frozen-lockfile',
    )
    expect(check).toBeGreaterThanOrEqual(0)
    expect(install).toBeGreaterThanOrEqual(0)
    expect(install).toBeLessThan(check)
  })

  test('installs the phone app and Node 22 before any lane that builds desktop/dist', () => {
    // desktop `bun run build` ends by exporting mobile/ into dist/m (the phone H5).
    const jobs = workflowJobs(readFileSync('.github/workflows/pr-quality.yml', 'utf8'))
    for (const [job, command] of [
      ['desktop-checks', 'bun run check:desktop'],
      ['desktop-native-checks', 'bun run check:native'],
    ]) {
      const steps = jobs[job].steps ?? []
      const check = steps.findIndex(step => runsCommand(step, command))
      const install = steps.findIndex(step =>
        step['working-directory'] === 'mobile' && step.run === 'bun install --frozen-lockfile',
      )
      const node = steps.findIndex(step =>
        step.uses?.startsWith('actions/setup-node@') && String(step.with?.['node-version']) === '22',
      )
      expect(check, job).toBeGreaterThanOrEqual(0)
      expect(install, job).toBeGreaterThanOrEqual(0)
      expect(install, job).toBeLessThan(check)
      expect(node, job).toBeGreaterThanOrEqual(0)
      expect(node, job).toBeLessThan(check)
    }
  })

  test('requires native Windows installer and macOS checks alongside Linux packaging', () => {
    const jobs = workflowJobs(readFileSync('.github/workflows/pr-quality.yml', 'utf8'))
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    const macos = jobs['macos-swift-checks']!
    const linux = jobs['desktop-native-checks']!
    const windows = jobs['windows-installer-checks']!
    const gate = jobs['pr-quality-gate']!
    expect(macos['runs-on']).toBe('macos-latest')
    expect(linux['runs-on']).toBe('ubuntu-22.04')
    expect(windows['runs-on']).toBe('windows-2022')
    for (const job of [macos, linux, windows]) {
      expect(job.needs).toBe('scope-plan')
      expect(job.if).toBe("needs.scope-plan.outputs.desktop_native_checks == 'true'")
      expect(job['continue-on-error']).not.toBe(true)
    }
    expect(macos.steps?.some(step => step.run === 'bun run check:swift')).toBe(true)
    expect(linux.steps?.some(step => step.run === 'bun run check:native')).toBe(true)
    expect(windows.steps?.some(step => step.run === 'bun --no-env-file scripts/pr/run-windows-installer-checks.ts')).toBe(true)
    expect(gate.needs).toContain('macos-swift-checks')
    expect(gate.needs).toContain('desktop-native-checks')
    expect(gate.needs).toContain('windows-installer-checks')
    expect(packageJson.scripts['check:swift']).toBe('bun run scripts/pr/run-swift-checks.ts')
    expect(packageJson.scripts['check:policy']).toContain('scripts/pr/run-swift-checks.test.ts')
    expect(packageJson.scripts['check:policy']).toContain('scripts/quality-gate/package-smoke/index.test.ts')
    for (const command of ['check:swift', 'build:sidecars', 'test:compiled-sidecar-smoke', 'check:electron', 'electron:package:dir', 'test:package-smoke:current']) {
      expect(packageJson.scripts['check:native']).toContain(`bun run ${command}`)
    }
  })

  test.each([
    { selected: true, macos: 'success', linux: 'success', exit: 0 },
    { selected: true, macos: 'failure', linux: 'success', exit: 1 },
    { selected: true, macos: 'skipped', linux: 'success', exit: 1 },
    { selected: true, macos: 'success', linux: 'failure', exit: 1 },
    { selected: true, macos: 'success', linux: 'success', windows: 'failure', exit: 1 },
    { selected: true, macos: 'success', linux: 'success', windows: 'skipped', exit: 1 },
    { selected: false, macos: 'skipped', linux: 'skipped', exit: 0 },
    { selected: false, macos: 'success', linux: 'skipped', exit: 1 },
    { selected: false, macos: 'skipped', linux: 'skipped', windows: 'success', exit: 1 },
  ])('enforces all selected native results in the stable gate: %j', scenario => {
    const jobs = workflowJobs(readFileSync('.github/workflows/pr-quality.yml', 'utf8'))
    const gateScript = jobs['pr-quality-gate']!.steps!.find(step => step.run?.includes('require_selected'))!.run!
    const script = gateScript.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_match, expression: string) => {
      if (expression === 'needs.scope-plan.outputs.desktop_native_checks') return String(scenario.selected)
      if (expression.startsWith('needs.scope-plan.outputs.')) return 'false'
      if (expression === 'needs.macos-swift-checks.result') return scenario.macos
      if (expression === 'needs.desktop-native-checks.result') return scenario.linux
      if (expression === 'needs.windows-installer-checks.result') return scenario.windows ?? (scenario.selected ? 'success' : 'skipped')
      if (expression === 'needs.scope-plan.result' || expression === 'needs.policy-enforcement.result') return 'success'
      return 'skipped'
    })
    const result = Bun.spawnSync(['bash', '-c', script], {
      env: { PATH: process.env.PATH ?? '' },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode, new TextDecoder().decode(result.stdout)).toBe(scenario.exit)
  })

  test('mobile checks install frozen dependencies and run the isolated local entry point', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')
    const jobs = workflowJobs(workflow)
    const job = jobs['mobile-checks']!
    const steps = job.steps ?? []
    expect(job.if).toBe("needs.scope-plan.outputs.mobile_checks == 'true'")
    expect(job['continue-on-error']).not.toBe(true)
    const check = steps.findIndex(step => step.run === 'bun run check:mobile')
    expect(check).toBeGreaterThanOrEqual(0)
    const install = steps.findIndex(step => step['working-directory'] === 'mobile' && step.run === 'bun install --frozen-lockfile')
    expect(install).toBeGreaterThanOrEqual(0)
    expect(install).toBeLessThan(check)
    expect(jobs['pr-quality-gate'].needs).toContain('mobile-checks')
    expect(workflow).toContain('mobile_checks: ${{ steps.policy.outputs.mobile_checks }}')
  })

  test.each([
    { selected: true, result: 'success', exit: 0 },
    { selected: true, result: 'failure', exit: 1 },
    { selected: true, result: 'skipped', exit: 1 },
    { selected: false, result: 'skipped', exit: 0 },
    { selected: false, result: 'success', exit: 1 },
  ])('enforces the selected mobile result in the stable gate: %j', scenario => {
    const jobs = workflowJobs(readFileSync('.github/workflows/pr-quality.yml', 'utf8'))
    const script = jobs['pr-quality-gate']!.steps!.find(step => step.run?.includes('require_selected'))!.run!
      .replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_match, expression: string) => {
        if (expression === 'needs.scope-plan.outputs.mobile_checks') return String(scenario.selected)
        if (expression.startsWith('needs.scope-plan.outputs.')) return 'false'
        if (expression === 'needs.mobile-checks.result') return scenario.result
        if (expression === 'needs.scope-plan.result' || expression === 'needs.policy-enforcement.result') return 'success'
        return 'skipped'
      })
    const result = Bun.spawnSync(['bash', '-c', script], {
      env: { PATH: process.env.PATH ?? '' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode, new TextDecoder().decode(result.stdout)).toBe(scenario.exit)
  })

  test('keeps coverage artifacts observable in CI', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')

    expect(workflow).toContain('COVERAGE_BASE_REF: origin/${{ github.base_ref }}')
    expect(workflow).toContain('cat "$latest_report" >> "$GITHUB_STEP_SUMMARY"')
    expect(workflow).toContain('uses: actions/upload-artifact@v4')
    expect(workflow).toContain('path: artifacts/coverage/')
    expect(workflow).toContain('retention-days: 14')
  })

  test('installs and validates the isolated React site for docs changes', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')
    const jobs = workflowJobs(workflow)
    const docsSteps = jobs['docs-checks'].steps ?? []
    const runDocs = docsSteps.find((step) => step.name === 'Run docs checks')

    expect(workflow).toContain('cache-dependency-path: site/package-lock.json')
    expect(runDocs?.run).toBe(
      'npm --prefix site ci && npm --prefix site run build && npm --prefix site run check',
    )
    expect(workflow).not.toContain('vitepress')
  })

  test('keeps required PR checks deterministic and secret-free', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')

    expect(workflow).not.toContain('--allow-live')
    expect(workflow).not.toContain('QUALITY_GATE_PROVIDER_API_KEY')
    expect(workflow).not.toContain('secrets.')
    expect(workflow).not.toContain('pull_request_target')
    expect(workflow.match(/uses: actions\/checkout@v4/g)?.length).toBeGreaterThan(0)
    expect(workflow.match(/persist-credentials: false/g)?.length).toBe(
      workflow.match(/uses: actions\/checkout@v4/g)?.length,
    )
  })

  test('exposes a single required gate job for branch protection', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')

    expect(workflow).toContain('pr-quality-gate:')
    expect(workflow).toContain('name: pr-quality-gate')
    expect(workflow).toContain('if: always()')
    expect(workflow).toContain('require_success "scope-plan" "${{ needs.scope-plan.result }}"')
    expect(workflow).toContain('require_success "policy-enforcement" "${{ needs.policy-enforcement.result }}"')
    expect(workflow).toContain('require_selected "provider-contract-checks"')
    expect(workflow).toContain('require_selected "chat-contract-checks"')
    expect(workflow).toContain('require_selected "agent-flow-checks"')
    expect(workflow).toContain('require_selected "agent-e2e-checks"')
  })

  test('keeps advisory coverage off the required gate so the gate never waits for it', () => {
    // The coverage lane takes ~25 minutes and never decides a merge. While the gate
    // listed it in `needs`, every PR waited for it before turning green.
    const jobs = workflowJobs(readFileSync('.github/workflows/pr-quality.yml', 'utf8'))
    const gate = jobs['pr-quality-gate']!
    const gateScript = gate.steps!.map(step => step.run ?? '').join('\n')

    expect(gate.needs).not.toContain('coverage-checks')
    expect(gateScript).not.toContain('coverage')
    // Still selected and still reported on the PR as its own check.
    expect(jobs['coverage-checks']!.needs).toBe('scope-plan')
    expect(jobs['coverage-checks']!.steps?.some(step => step.run === 'bun run check:coverage')).toBe(true)
  })

  test('splits the long required lanes into shards that together run the whole check', () => {
    const jobs = workflowJobs(readFileSync('.github/workflows/pr-quality.yml', 'utf8'))
    const gate = jobs['pr-quality-gate']!
    for (const [job, command] of [
      ['server-checks', 'bun run check:server'],
      ['desktop-checks', 'bun run check:desktop'],
    ] as const) {
      const shards = jobs[job]!.strategy?.matrix?.shard ?? []
      const total = shards.length
      expect(total, job).toBeGreaterThan(1)
      // Exactly 1..N: a missing shard number would silently skip that slice of tests.
      expect(shards, job).toEqual(Array.from({ length: total }, (_, index) => index + 1))
      // Every shard reports, so one failure does not hide another.
      expect(jobs[job]!.strategy?.['fail-fast'], job).toBe(false)
      const runs = (jobs[job]!.steps ?? []).filter(step => runsCommand(step, command))
      expect(runs.map(step => step.run), job).toEqual([`${command} --shard=\${{ matrix.shard }}/${total}`])
      // A matrix job's result is failure when any shard fails, so the gate stays strict.
      expect(gate.needs, job).toContain(job)
    }
  })

  test.each([
    { agentE2e: 'success', exit: 0 },
    { agentE2e: 'failure', exit: 1 },
    { agentE2e: 'skipped', exit: 1 },
  ])('requires the selected mock-LLM agent lane: %j', scenario => {
    const jobs = workflowJobs(readFileSync('.github/workflows/pr-quality.yml', 'utf8'))
    const gateScript = jobs['pr-quality-gate']!.steps!.find(step => step.run?.includes('require_selected'))!.run!
    const script = gateScript.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_match, expression: string) => {
      if (expression === 'needs.scope-plan.outputs.agent_e2e_checks') return 'true'
      if (expression.startsWith('needs.scope-plan.outputs.')) return 'false'
      if (expression === 'needs.agent-e2e-checks.result') return scenario.agentE2e
      if (expression === 'needs.scope-plan.result' || expression === 'needs.policy-enforcement.result') return 'success'
      return 'skipped'
    })
    const result = Bun.spawnSync(['bash', '-c', script], {
      env: { PATH: process.env.PATH ?? '' },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode, new TextDecoder().decode(result.stdout)).toBe(scenario.exit)
  })

  test('re-checks main after every merge, scoped to the pushed range', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')
    const parsed = parse(workflow) as { on: { push?: { branches?: string[] } } }
    const jobs = workflowJobs(workflow)
    const collect = (jobs['scope-plan'].steps ?? []).find((step) => step.name === 'Collect changed files')!.run!
    const enforce = (jobs['policy-enforcement'].steps ?? []).find((step) => step.name === 'Enforce change policy')!.run!

    expect(parsed.on.push?.branches).toEqual(['main'])
    expect(collect).toContain('git diff --name-only -z "$PUSH_BEFORE" "$PUSH_AFTER"')
    // Pushes to main must not cancel one another: each merge gets its own verdict.
    expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' && !(")
    // Label exceptions live on the pull request; main must not re-block on them.
    expect(enforce.indexOf('"$EVENT_NAME" != "pull_request"')).toBeLessThan(enforce.indexOf('"$BLOCKED" = "true"'))
  })

  test('routes the mock-LLM agent lane through the scope plan and keeps its evidence', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')
    const steps = workflowJobs(workflow)['agent-e2e-checks'].steps ?? []

    expect(workflow).toContain('agent_e2e_checks: ${{ steps.policy.outputs.agent_e2e_checks }}')
    expect(steps.some((step) => step.run === 'bun run check:agent-e2e')).toBe(true)
    const check = steps.findIndex(step => step.run === 'bun run check:agent-e2e')
    const verifyRipgrep = steps.findIndex(step => /\brg --version\b/.test(step.run ?? ''))
    expect(verifyRipgrep, 'agent E2E must verify its search executable').toBeGreaterThanOrEqual(0)
    expect(verifyRipgrep).toBeLessThan(check)
    expect(workflow).toContain('path: artifacts/agent-e2e/')
    expect(steps.some((step) => String(step.run ?? '').includes('secrets'))).toBe(false)
  })

  test('check:policy names only test files that exist, each as its own argument', () => {
    // Two paths glued together ("a.test.ts./b.test.ts") silently drop both files
    // from the run instead of failing it.
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    const args = packageJson.scripts['check:policy']!.split(/\s+/).slice(2)
    expect(args.length).toBeGreaterThan(20)
    for (const arg of args) {
      expect(arg, arg).toMatch(/^\.\/[^\s]+\.test\.ts$/)
      expect(arg.slice(2).includes('./'), arg).toBe(false)
      expect(existsSync(arg), arg).toBe(true)
    }
  })

  test('replays recorded traffic in CI but never records it there', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    // check:agent-e2e is what the agent-e2e job runs; it must include the replay lane.
    expect(packageJson.scripts['check:agent-e2e']).toContain('scripts/quality-gate/replay/index.ts')
    for (const file of ['.github/workflows/pr-quality.yml', '.github/workflows/nightly-quality.yml']) {
      const workflow = readFileSync(file, 'utf8')
      expect(workflow, file).not.toContain('record-cassettes')
      expect(workflow, file).not.toContain('replay/record.ts')
    }
  })

  test('routes the deterministic agent flow through the scope plan and keeps its evidence', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')
    const jobs = workflowJobs(workflow)
    const steps = jobs['agent-flow-checks'].steps ?? []

    expect(workflow).toContain('agent_flow_checks: ${{ steps.policy.outputs.agent_flow_checks }}')
    expect(steps.some((step) => step.run === 'bun run check:agent-flow')).toBe(true)
    expect(workflow).toContain('path: artifacts/agent-flow/')
    // The lane must stay runnable on an untrusted fork: no desktop install, no
    // secrets, no live provider.
    expect(steps.some((step) => String(step.run ?? '').includes('secrets'))).toBe(false)
  })
})

describe('full quality workflow', () => {
  test('runs every deterministic lane on demand without secrets or live providers', () => {
    const workflow = readFileSync('.github/workflows/nightly-quality.yml', 'utf8')
    const jobs = workflowJobs(workflow)
    const runs = (jobs['full-deterministic'].steps ?? []).map((step) => step.run ?? '')

    expect(workflow).toContain('workflow_dispatch:')
    // Daily, by maintainer decision (2026-10). More often than that is a call for the
    // maintainer, not for a drive-by edit: the sweep costs about ninety minutes.
    const schedule = (parse(workflow) as { on: { schedule?: Array<{ cron: string }> } }).on.schedule ?? []
    expect(schedule).toEqual([{ cron: '0 19 * * *' }])
    for (const command of [
      'bun run check:policy',
      'bun run check:agent-flow',
      'bun run check:agent-e2e',
      'bun run check:server',
      'bun run check:provider-contract',
      'bun run check:chat-contract',
      'bun run check:adapters',
      'bun run check:desktop',
      'bun run check:mobile',
      'bun run check:electron',
      'bun run check:persistence-upgrade',
      'bun run check:quarantine',
      'bun run check:coverage',
    ]) {
      expect(runs, `full sweep must run ${command}`).toContain(command)
    }

    expect(workflow).not.toContain('--allow-live')
    expect(workflow).not.toContain('secrets.')
    expect(workflow.match(/persist-credentials: false/g)?.length).toBe(
      workflow.match(/uses: actions\/checkout@v4/g)?.length,
    )
  })

  test('installs ripgrep before every runtime suite in every workflow', () => {
    // Agent and skill discovery lists files through ripgrep. A job that runs the
    // runtime suites without it reports "create agent" as a 500, which kept the
    // full sweep red on every run while the PR gate, which installs it, stayed green.
    for (const file of ['.github/workflows/pr-quality.yml', '.github/workflows/nightly-quality.yml']) {
      for (const [name, job] of Object.entries(workflowJobs(readFileSync(file, 'utf8')))) {
        const steps = job.steps ?? []
        const check = steps.findIndex(step => /\bcheck:(server|coverage|native|agent-e2e)\b/.test(step.run ?? ''))
        if (check < 0) continue
        const ripgrep = steps.findIndex(step => step.run?.includes('apt-get install') && /\bripgrep\b/.test(step.run))
        expect(ripgrep, `${file} ${name} must install ripgrep`).toBeGreaterThanOrEqual(0)
        expect(ripgrep, `${file} ${name} must install ripgrep before its runtime suites`).toBeLessThan(check)
      }
    }
  })

  test('re-proves the dependency graph so PR selection cannot silently degrade', () => {
    const workflow = readFileSync('.github/workflows/nightly-quality.yml', 'utf8')
    const jobs = workflowJobs(workflow)
    const runs = (jobs['selection-drift'].steps ?? []).map((step) => step.run ?? '')

    expect(runs.some((run) => run.includes('module-graph.test.ts'))).toBe(true)
    expect(runs.some((run) => run.includes('check:impact'))).toBe(true)
  })
})

describe('Windows installer lane preparation and isolation', () => {
  test('keeps the Windows 2022 pin confined to isolated installer jobs', () => {
    const ordinary = workflowJobs(readFileSync('.github/workflows/pr-quality.yml', 'utf8'))
    const full = workflowJobs(readFileSync('.github/workflows/nightly-quality.yml', 'utf8'))
    expect(ordinary['windows-installer-checks']['runs-on']).toBe('windows-2022')
    expect(full['p1879u-functional-upgrade']['runs-on']).toBe('windows-2022')
    for (const name of ['windows-candidate-package', 'windows-profile-only-review']) expect(ordinary[name]['runs-on']).toBe('windows-latest')
    for (const name of ['full-deterministic', 'selection-drift']) expect(full[name]['runs-on']).toBe('ubuntu-latest')
  })

  test('builds a complete candidate only after successful ordinary reviewed-PR Windows checks, outside the gate', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')
    const jobs = workflowJobs(workflow)
    const job = jobs['windows-candidate-package']!
    expect(job.needs).toBe('windows-installer-checks')
    for (const condition of ["github.event_name == 'pull_request'", "github.repository == 'NanmiCoder/cc-haha'",
      'github.event.pull_request.number == 1883', "github.event.pull_request.base.ref == 'main'",
      "github.event.pull_request.head.repo.full_name == 'toBerlinWay/cc-haha'",
      "github.event.pull_request.head.ref == 'fix/installer-fallback-foreign-helpers'",
      "needs.windows-installer-checks.result == 'success'", 'github.run_attempt == 1',
      "fromJSON('[\"opened\",\"synchronize\",\"reopened\",\"ready_for_review\"]')",
    ]) expect(job.if).toContain(condition)
    expect(job.if).not.toContain('label')
    expect(job['runs-on']).toBe('windows-latest')
    expect((job as any).permissions).toEqual({ contents: 'read' })
    expect(jobs['pr-quality-gate']!.needs).not.toContain('windows-candidate-package')
    const checkout = job.steps!.find(step => step.uses === 'actions/checkout@v4')!
    expect(checkout.with).toMatchObject({ ref: '${{ github.event.pull_request.head.sha }}', 'persist-credentials': false })
    const steps = job.steps!.map(step => step.run ?? '').join('\n')
    expect(steps).toContain('bun --no-env-file test ./scripts/pr/prepare-windows-installer-candidate-package.test.ts')
    expect(steps).toContain('bun --no-env-file scripts/pr/prepare-windows-installer-candidate-package.ts')
    expect(JSON.stringify(job)).not.toContain('secrets.')
    expect(steps).not.toContain('profile-review.ts')
    const upload = job.steps!.find(step => step.uses === 'actions/upload-artifact@v4')!
    expect(upload.if).toBe('always()')
    expect(upload.with).toMatchObject({ path: 'artifacts/windows-installer-candidate-package/', 'compression-level': 0 })
  })

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'cc-haha-installer-lane-unit-'))
    const sourceRoot = join(root, 'source')
    const tempParent = join(root, 'system-temp')
    const manifestFile = join(sourceRoot, 'artifacts/windows-installer/prepared.json')
    mkdirSync(sourceRoot)
    mkdirSync(tempParent)
    const bytes = Buffer.from('locked installer fixture bytes')
    const expected = {
      tag: 'fixture', assetId: 1, fileName: 'fixture-setup.exe', url: 'https://example.invalid/locked-setup',
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    }
    const options = {
      platform: 'win32' as const, sourceRoot, tempParent, manifestFile, fixture: expected,
      acquireTools: async (_source: string, dependencyRoot: string) => {
        const compiler = join(dependencyRoot, 'nsis/Bin/makensis.exe')
        const templates = join(sourceRoot, 'desktop/node_modules/app-builder-lib/templates/nsis')
        mkdirSync(join(dependencyRoot, 'nsis/Bin'), { recursive: true })
        mkdirSync(join(templates, 'include'), { recursive: true })
        writeFileSync(compiler, 'fixture compiler; never executed')
        writeFileSync(join(templates, 'include/getProcessInfo.nsh'), '; fixture')
        const resources = join(dependencyRoot, 'nsis-resources')
        mkdirSync(join(resources, 'plugins/x86-unicode'), { recursive: true })
        const pluginsSha256: Record<string, string> = {}
        for (const name of pinnedNsisResources.plugins) {
          const bytes = `fixture ${name}; never loaded`
          writeFileSync(join(resources, 'plugins/x86-unicode', name), bytes)
          pluginsSha256[name] = createHash('sha256').update(bytes).digest('hex')
        }
        return { compiler, templates, ...pinnedNsisCompiler, compilerSha256: createHash('sha256').update('fixture compiler; never executed').digest('hex'), resources: {
          directory: resources, version: pinnedNsisResources.version, archiveSha512: pinnedNsisResources.archiveSha512, pluginsSha256,
        } }
      },
      download: async (url: string, file: string) => {
        expect(url).toBe(expected.url)
        writeFileSync(file, bytes)
      },
      extract: async (_source: string, _installer: string, output: string) => {
        const file = join(output, 'Uninstall fixture.exe')
        writeFileSync(file, 'MZ fixture bytes; never executed')
        return { status: 'extracted' as const, method: 'injected fixture extractor', diagnostics: [], file }
      },
    }
    return { root, sourceRoot, tempParent, manifestFile, bytes, expected, options }
  }

  test('prepares pinned dependencies before offline tests and keeps evidence before cleanup', () => {
    const jobs = workflowJobs(readFileSync('.github/workflows/pr-quality.yml', 'utf8'))
    const steps = jobs['windows-installer-checks'].steps ?? []
    const prepare = steps.findIndex(step => step.run === 'bun --no-env-file scripts/pr/prepare-windows-installer-tests.ts')
    const run = steps.findIndex(step => step.run === 'bun --no-env-file scripts/pr/run-windows-installer-checks.ts')
    expect(prepare).toBeGreaterThan(-1)
    expect(prepare).toBeLessThan(run)
    for (const directory of [undefined, 'desktop']) {
      const install = steps.findIndex(step => step['working-directory'] === directory && step.run === 'bun install --frozen-lockfile')
      expect(install).toBeGreaterThan(-1)
      expect(install).toBeLessThan(prepare)
    }
    const evidence = steps.findIndex(step => step.uses === 'actions/upload-artifact@v4' && step.with?.name === 'windows-installer-evidence')
    const cleanup = steps.findIndex(step => step.run?.endsWith('--cleanup-prepared'))
    expect(evidence).toBeGreaterThan(run)
    expect(cleanup).toBeGreaterThan(evidence)
    expect(steps[evidence].if).toBe('always()')
    expect(steps[cleanup].if).toBe('always()')
    expect(steps.map(step => step.run ?? '').join('\n')).not.toContain('windows-installer-smoke.ps1')
    expect(historicalInstallerFixture).toMatchObject({
      assetId: 730495182, bytes: 230611497,
      sha256: 'dca6bb82f4d0fbee8d43c91912e4d50e7dcea69a7cb22c51cdd9cb265767c7e7',
    })
    expect(pinnedNsisResources).toEqual({
      version: '3.4.1',
      archiveSha512: 'Dqd6g+2buwwvoG1Vyf6BHR1b+25QMmPcwZx40atOT57gH27rkjOei1L0JTldxZu4NFoEmW4kJgZ3DlSWVON3+Q==',
      plugins: ['StdUtils.dll', 'UAC.dll', 'WinShell.dll', 'nsProcess.dll'],
    })
  })

  test('verifies the whole fixture and records extraction without approving old-version compatibility', async () => {
    const f = fixture()
    try {
      const prepared = await prepareWindowsInstallerTests(f.options)
      expect(prepared.status).toBe('prepared')
      expect(prepared.historicalInstaller).toMatchObject({ verified: true, bytes: f.bytes.length, sha256: f.expected.sha256 })
      expect(prepared.extraction?.status).toBe('extracted')
      expect(prepared.extraction?.sha256).toBe(createHash('sha256').update('MZ fixture bytes; never executed').digest('hex'))
      expect(prepared.compatibilityEnabled).toBe(false)
      expect(prepared.compatibilityProfile).toBe('not_proven')
      expect(prepared.oldExit22BeforeMutation).toBe('not_run')
      expect(prepared.removalEquivalence).toBe('not_run')
      for (const name of pinnedNsisResources.plugins) {
        expect(prepared.tools!.resources.pluginsSha256[name]).toBe(createHash('sha256').update(readFileSync(join(prepared.tools!.resources.directory, 'plugins/x86-unicode', name))).digest('hex'))
      }
      assertOutsideSourceGit(prepared.tempRoot, f.sourceRoot)
      cleanupPreparedWindowsInstallerTests(prepared, f)
      expect(existsSync(prepared.tempRoot)).toBe(false)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('streams a loopback fixture and rejects HTTP failure before creating a candidate', async () => {
    const f = fixture()
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request =>
      new URL(request.url).pathname === '/locked-setup' ? new Response(f.bytes) : new Response('fixture failure', { status: 503 }),
    })
    try {
      const output = join(f.root, 'download.partial')
      await downloadPinnedInstaller(`http://127.0.0.1:${server.port}/locked-setup`, output)
      expect(await verifyInstallerFixture(output, f.expected)).toBe(f.expected.sha256)
      const rejected = join(f.root, 'http-error.partial')
      await expect(downloadPinnedInstaller(`http://127.0.0.1:${server.port}/unavailable`, rejected)).rejects.toThrow('HTTP 503')
      expect(existsSync(rejected)).toBe(false)
    } finally {
      server.stop(true)
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test.each(['truncated', 'wrong-sha'] as const)('rejects %s historical asset bytes before extracting', async kind => {
    const f = fixture()
    let extracted = false
    try {
      await expect(prepareWindowsInstallerTests({
        ...f.options,
        download: async (_url, file) => writeFileSync(file, kind === 'truncated' ? f.bytes.subarray(0, 3) : Buffer.alloc(f.bytes.length, 0)),
        extract: async (...args) => {
          extracted = true
          return f.options.extract(...args)
        },
      })).rejects.toThrow(kind === 'truncated' ? 'byte count' : 'SHA-256')
      expect(extracted).toBe(false)
      const report = JSON.parse(readFileSync(f.manifestFile, 'utf8'))
      expect(report.status).toBe('failed')
      expect(report.historicalInstaller).toBeUndefined()
      cleanupPreparedWindowsInstallerTests(report, f)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('keeps a verified setup with not_proven extraction instead of executing it', async () => {
    const f = fixture()
    try {
      const prepared = await prepareWindowsInstallerTests({ ...f.options,
        extract: async () => ({ status: 'not_proven', method: 'unsupported fixture format', diagnostics: ['static extraction unavailable'] }),
      })
      expect(prepared.status).toBe('prepared')
      expect(prepared.extraction?.status).toBe('not_proven')
      expect(prepared.extraction?.file).toBeUndefined()
      expect(await verifyInstallerFixture(prepared.historicalInstaller!.file, f.expected)).toBe(f.expected.sha256)
      cleanupPreparedWindowsInstallerTests(prepared, f)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('rejects source-root temporary directories before dependency acquisition', async () => {
    const f = fixture()
    let acquired = false
    try {
      const unsafeTemp = join(f.sourceRoot, 'temporary')
      mkdirSync(unsafeTemp)
      await expect(prepareWindowsInstallerTests({ ...f.options, tempParent: unsafeTemp,
        acquireTools: async (...args) => { acquired = true; return f.options.acquireTools(...args) },
      })).rejects.toThrow('outside source Git root')
      expect(acquired).toBe(false)
      expect(existsSync(f.manifestFile)).toBe(false)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('runs the real installer suites once with private state and propagates failure', async () => {
    const f = fixture()
    let sandbox = ''
    try {
      const prepared = await prepareWindowsInstallerTests(f.options)
      const result = await runWindowsInstallerChecks({ platform: 'win32', sourceRoot: f.sourceRoot,
        manifestFile: f.manifestFile, tempParent: f.tempParent,
        run: async (command, options) => {
          expect(command).toContain('--parallel=1')
          expect(command).toContain('--max-concurrency=1')
          expect(command).toContain('--no-orphans')
          expect(command).toContain('./scripts/pr/windows-installer-process-check.test.ts')
          expect(command).toContain('./scripts/pr/windows-installer-recovery.test.ts')
          expect(command).toContain('./scripts/pr/windows-installer-guarded-removal.test.ts')
          expect(command).toContain('./scripts/pr/windows-installer-member-proof.test.ts')
          expect(command.filter(file => file.endsWith('windows-installer-guarded-removal.test.ts'))).toHaveLength(1)
          expect(command.some(file => file.includes('windows-installer-etw-calibration'))).toBe(false)
          expect(options.cwd).toBe(realpathSync(f.sourceRoot))
          expect(options.env.CC_HAHA_TEST_MAKENSIS).toBe(prepared.tools!.compiler)
          expect(options.env.CC_HAHA_TEST_NSIS_TEMPLATES).toBe(prepared.tools!.templates)
          expect(options.env.CC_HAHA_TEST_NSIS_RESOURCES).toBe(prepared.tools!.resources.directory)
          for (const variable of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'GH_CONFIG_DIR', 'TEMP', 'TMP']) {
            expect(options.env[variable]).not.toBe(process.env[variable])
            assertOutsideSourceGit(options.env[variable], f.sourceRoot)
          }
          sandbox = options.env.HOME!
          expect(options.env.ANTHROPIC_API_KEY).toBeUndefined()
          return 7
        },
      })
      expect(result).toEqual({ status: 'failed', exitCode: 7 })
      expect(existsSync(sandbox)).toBe(false)
      const report = JSON.parse(readFileSync(join(f.sourceRoot, 'artifacts/windows-installer/checks.json'), 'utf8'))
      expect(report.exitCode).toBe(7)
      expect(report.fullPackageUpgrade).toBe('not_run')
      cleanupPreparedWindowsInstallerTests(prepared, f)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('does not run or acquire Windows dependencies on a non-Windows host', async () => {
    let ran = false
    expect(await runWindowsInstallerChecks({ platform: 'darwin', manifestFile: '/missing-preparation-file', run: async () => { ran = true; return 0 } }))
      .toEqual({ status: 'not_run', exitCode: 0 })
    expect(ran).toBe(false)
    await expect(prepareWindowsInstallerTests({ platform: 'darwin' })).rejects.toThrow('Windows-only')
  })

  test('rejects an extraction outside its private directory without executing the candidate', async () => {
    const f = fixture()
    try {
      const external = join(f.root, 'uninstall-outside.exe')
      writeFileSync(external, 'MZ outside candidate')
      await expect(prepareWindowsInstallerTests({ ...f.options,
        extract: async () => ({ status: 'extracted', method: 'fixture', diagnostics: [], file: external }),
      })).rejects.toThrow('escaped its private fixture directory')
      expect(readFileSync(external, 'utf8')).toBe('MZ outside candidate')
      cleanupPreparedWindowsInstallerTests(JSON.parse(readFileSync(f.manifestFile, 'utf8')), f)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('rejects a changed prepared compiler before starting a native harness', async () => {
    const f = fixture()
    let ran = false
    try {
      const prepared = await prepareWindowsInstallerTests(f.options)
      writeFileSync(prepared.tools!.compiler, 'changed compiler fixture')
      await expect(runWindowsInstallerChecks({ platform: 'win32', sourceRoot: f.sourceRoot,
        manifestFile: f.manifestFile, tempParent: f.tempParent,
        run: async () => { ran = true; return 0 },
      })).rejects.toThrow('compiler identity changed')
      expect(ran).toBe(false)
      cleanupPreparedWindowsInstallerTests(prepared, f)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test.each(pinnedNsisResources.plugins.flatMap(name => [
    { name, mutation: 'missing' }, { name, mutation: 'changed' },
  ]))('rejects $mutation prepared $name before invoking a compiler', async ({ name, mutation }) => {
    const f = fixture()
    let ran = false
    try {
      const prepared = await prepareWindowsInstallerTests(f.options)
      const plugin = join(prepared.tools!.resources.directory, 'plugins/x86-unicode', name)
      if (mutation === 'missing') rmSync(plugin)
      else writeFileSync(plugin, 'changed fixture plugin; never loaded')
      await expect(runWindowsInstallerChecks({ platform: 'win32', sourceRoot: f.sourceRoot,
        manifestFile: f.manifestFile, tempParent: f.tempParent,
        run: async () => { ran = true; return 0 },
      })).rejects.toThrow('resources identity changed')
      expect(ran).toBe(false)
      cleanupPreparedWindowsInstallerTests(prepared, f)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test.each(['missing', 'version', 'archive', 'missing-pin', 'extra-pin', 'directory-escape', 'plugin-link-escape'] as const)(
    'rejects %s prepared resources before invoking a compiler', async kind => {
      const f = fixture()
      let ran = false
      try {
        const prepared = await prepareWindowsInstallerTests(f.options)
        const resources = prepared.tools!.resources
        if (kind === 'missing') delete (prepared.tools as { resources?: unknown }).resources
        if (kind === 'version') resources.version = 'unreviewed'
        if (kind === 'archive') resources.archiveSha512 = 'unreviewed'
        if (kind === 'missing-pin') delete resources.pluginsSha256['StdUtils.dll']
        if (kind === 'extra-pin') resources.pluginsSha256['unexpected.dll'] = '0'.repeat(64)
        if (kind === 'directory-escape' || kind === 'plugin-link-escape') {
          const external = join(f.root, 'outside-dependency')
          const externalPlugins = join(external, 'plugins/x86-unicode')
          mkdirSync(externalPlugins, { recursive: true })
          for (const name of pinnedNsisResources.plugins) {
            writeFileSync(join(externalPlugins, name), readFileSync(join(resources.directory, 'plugins/x86-unicode', name)))
          }
          if (kind === 'directory-escape') resources.directory = external
          else {
            const plugins = join(resources.directory, 'plugins/x86-unicode')
            rmSync(plugins, { recursive: true })
            symlinkSync(externalPlugins, plugins, process.platform === 'win32' ? 'junction' : 'dir')
          }
        }
        writeFileSync(f.manifestFile, JSON.stringify(prepared))
        await expect(runWindowsInstallerChecks({ platform: 'win32', sourceRoot: f.sourceRoot,
          manifestFile: f.manifestFile, tempParent: f.tempParent,
          run: async () => { ran = true; return 0 },
        })).rejects.toThrow('resources identity changed')
        expect(ran).toBe(false)
        cleanupPreparedWindowsInstallerTests(prepared, f)
      } finally {
        rmSync(f.root, { recursive: true, force: true })
      }
    },
  )

  test.each(['owner', 'parent'] as const)('rejects changed prepared %s before starting a native harness', async kind => {
    const f = fixture()
    let ran = false
    try {
      const prepared = await prepareWindowsInstallerTests(f.options)
      writeFileSync(f.manifestFile, JSON.stringify({ ...prepared, ...(kind === 'owner' ? { owner: 'wrong-owner' } : { tempParent: f.root }) }))
      await expect(runWindowsInstallerChecks({ platform: 'win32', sourceRoot: f.sourceRoot,
        manifestFile: f.manifestFile, tempParent: f.tempParent,
        run: async () => { ran = true; return 0 },
      })).rejects.toThrow('unowned')
      expect(ran).toBe(false)
      expect(existsSync(prepared.tempRoot)).toBe(true)
      cleanupPreparedWindowsInstallerTests(prepared, f)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('refuses to remove a prepared directory with changed ownership or parent', async () => {
    const f = fixture()
    try {
      const prepared = await prepareWindowsInstallerTests(f.options)
      expect(() => cleanupPreparedWindowsInstallerTests({ ...prepared, owner: 'wrong-owner' }, f)).toThrow('unowned')
      expect(() => cleanupPreparedWindowsInstallerTests(prepared, { ...f, tempParent: f.root })).toThrow('unowned')
      expect(existsSync(prepared.tempRoot)).toBe(true)
      cleanupPreparedWindowsInstallerTests(prepared, f)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })
})

describe('Windows profile fixture Stage A', () => {
  function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-haha-profile-unit-')))
    const sourceRoot = join(root, 'source')
    const tempParent = join(root, 'private-temp')
    mkdirSync(tempParent)
    for (const file of profileFixtureSources) {
      mkdirSync(dirname(join(sourceRoot, file)), { recursive: true })
      writeFileSync(join(sourceRoot, file), '// deterministic C# source\r\n')
    }
    for (const file of profileOnlyPacketSources) {
      const target = join(sourceRoot, 'scripts/pr/windows-installer-profile-only', file)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, readFileSync(join('scripts/pr/windows-installer-profile-only', file)))
    }
    const compiler = join(root, 'csc.exe')
    writeFileSync(compiler, 'fake compiler; never executed')
    const powershell = join(root, 'powershell.exe')
    writeFileSync(powershell, 'fake PowerShell; never executed')
    const evidenceRoot = join(sourceRoot, 'artifacts/windows-installer/profile-stage-a')
    const result = (mode: string) => mode === 'profile-only-preflight' ? {
      version: 1, mode, status: 'passed', engine: 'WindowsPowerShell5.1-Desktop',
      checks: [
        'packet-explicitly-unadmitted',
        ...['launch-profile-only.proposed.ps1', 'reconcile-profile-only.proposed.ps1'].flatMap(name =>
          ['parse', 'no-automatic-variable-assignment', 'default', 'pending-denial', 'one-embedded-source', 'compile'].map(check => `${check}-${name}`)),
        'atomic-private-root-acl', 'existing-root-rejected', 'readonly-allow-synchronize-roundtrip',
        'readonly-extra-write-rejected', 'readonly-extra-principal-rejected', 'packet-source-unchanged',
      ].map(name => ({ name, status: 'passed' })),
      realAccountsCreated: 0, realProfilesCreated: 0, releasedPeExecuted: false, releasedPeMayHaveExecuted: false,
      compatibilityEnabled: false, oldExit22Policy: 'fatal', cleanup: 'passed', packetUnchanged: true,
      packetHashes: Object.fromEntries(profileOnlyPacketSources.filter(file => file !== 'preflight.ps1')
        .map(file => [file.split('/').at(-1)!, createHash('sha256')
          .update(readFileSync(join(sourceRoot, 'scripts/pr/windows-installer-profile-only', file))).digest('hex')])),
    } : { version: 1, mode, status: 'passed',
      binarySha256: createHash('sha256').update('MZ-owned-fixture-double').digest('hex'),
      cleanup: mode === 'abi-harness' ? 'passed' : 'not_run',
      checks: [{ name: 'fixture-case', status: 'passed' }], realAccountsCreated: 0, realProfilesCreated: 0,
      releasedPeExecuted: false, compatibilityEnabled: false, oldExit22Policy: 'fatal',
      releasedPeMayHaveExecuted: false, releasedPeExecutionStatus: 'not_run',
      member_proven: 'not_run', installed_bytes_equal: 'not_run', old22_before_protected_mutation: 'not_run',
      removal_equivalence: 'not_run', full_old_to_new: 'not_run',
      ...(mode === 'f1-native-canary' ? {
        mode: 'f1-native-zero-account', cleanup: 'passed', specSha256: null, failedStage: null,
        startedAtUtc: '2026-11-14T00:00:00.0000000Z', finishedAtUtc: '2026-11-14T00:00:01.0000000Z',
        checks: [{ name: 'f1-real-debug-pump-and-owned-metadata', status: 'passed', detail: 'Runtime observations only; provider scope support, complete lifecycle/namespace and F1 remain not_proven.' }],
        trace: [], phases: [], observations: [], evidenceFiles: {},
        f1NativeCanary: { status: 'not_proven', F1: 'not_proven', scopeSupport: 'not_proven',
          name: 'CcHaha1879-F1-00000000-0000-0000-0000-000000000001', guid: '00000000-0000-0000-0000-000000000002', retainedHandle: 2,
          startAttempted: true, started: true, stopAttempted: true, stopped: true, consumerDrained: true, closed: true, gap: false,
          childResumeAttempted: true, childResumed: true, childExited: true, eventsLost: 0, buffersLost: 0, processTraceResult: 0,
          fileEnableCode: 0, registryEnableCode: 0, ownedRecords: 10, otherHeaders: 1, unknownRecords: 0, mappedFileWrites: 3, mappedRegistrySets: 3,
          childPid: 123, childCreationTime: '2026-11-14T00:00:00.0000000Z', nativeSchemaShapes: [] },
      } : {}),
    }
    const calls: string[][] = []
    const run: NonNullable<Parameters<typeof runWindowsInstallerProfileChecks>[0]>['run'] = async (command, options) => {
      calls.push(command)
      expect(options.env.GITHUB_TOKEN).toBeUndefined()
      expect(options.env.ANTHROPIC_API_KEY).toBeUndefined()
      assertOutsideSourceGit(options.env.HOME!, sourceRoot)
      expect(options.timeoutMs).toBeGreaterThan(0)
      if (command[0] === compiler) {
        const target = command.find(arg => arg.startsWith('/out:'))!.slice(5)
        writeFileSync(target, 'MZ-owned-fixture-double')
      } else if (command[0] === powershell) {
        expect(command).toContain('-NoProfile')
        const output = command[command.indexOf('-OutputPath') + 1]!
        writeFileSync(output, JSON.stringify(result('profile-only-preflight')))
      } else {
        const output = command[command.indexOf('--output') + 1]!
        writeFileSync(output, JSON.stringify(result(command[1] === '--f1-audit-canary' ? 'f1-native-canary' : command[1]!.slice(2))))
      }
      return { exitCode: 0, stdout: command[1] === '--f1-audit-canary' ? '' : 'owned fixture test double', stderr: '' }
    }
    return { root, sourceRoot, tempParent, compiler, powershell, evidenceRoot, calls, run, result,
      options: { platform: 'win32' as const, sourceRoot, tempParent, compiler, powershell, run } }
  }

  test('wires ordinary Stage A after preparation even when offline regressions fail', () => {
    const jobs = workflowJobs(readFileSync('.github/workflows/pr-quality.yml', 'utf8'))
    const steps = jobs['windows-installer-checks'].steps ?? []
    const checks = steps.findIndex(step => step.run === 'bun --no-env-file scripts/pr/run-windows-installer-checks.ts')
    const profile = steps.findIndex(step => step.run === 'bun --no-env-file scripts/pr/run-windows-installer-profile-checks.ts')
    const primitives = steps.findIndex(step => step.run === 'bun --no-env-file test --parallel=1 --max-concurrency=1 --no-orphans ./scripts/pr/windows-installer-removal-primitives.test.ts')
    const upload = steps.findIndex(step => step.uses === 'actions/upload-artifact@v4')
    expect(profile).toBeGreaterThan(checks)
    expect(profile).toBeLessThan(upload)
    expect(steps[profile]['continue-on-error']).not.toBe(true)
    expect(steps[profile].if).toBe("always() && steps.prepare.outcome == 'success'")
    expect(primitives).toBeGreaterThan(profile)
    expect(primitives).toBeLessThan(upload)
    expect(steps[primitives].if).toBe("always() && steps.prepare.outcome == 'success'")
    expect(steps[primitives]['continue-on-error']).not.toBe(true)
    expect(steps.map(step => step.run ?? '').join('\n')).not.toContain('--role controller')
    expect(steps.map(step => step.run ?? '').join('\n')).not.toContain('--role subject')
    expect(steps.map(step => step.run ?? '').join('\n')).not.toContain('--role profile-only')
  })

  test('binds the separate profile-only argv/environment plan without installer or historical admission', () => {
    const bytes = readFileSync('scripts/pr/windows-installer-profile-only/argv-env-plan.json', 'utf8').replace(/\r\n/g, '\n')
    const plan = JSON.parse(bytes)
    const core = readFileSync('scripts/pr/windows-installer-profile-fixture.cs', 'utf8')
    const boundHash = /ProfileOnlyEnvironmentPlanHash = "([0-9a-f]{64})"/.exec(core)?.[1]
    expect(boundHash).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(plan.role).toBe('profile-only')
    expect(plan.specMode).toBe('createprofile-only-controller')
    expect(plan.executionStage).toBe('profile-only')
    expect(plan.argv.slice(1, 4)).toEqual(['--role', 'profile-only', '--spec'])
    expect(plan.CreateProfile.maximumCalls).toBe(1)
    expect(plan.CreateProfile.allocationCharacters).toBe(32768)
    expect(plan.CreateProfile.passedCchCharacters).toBe(260)
    expect(plan.stopBefore).toContain('LogonUserW')
    expect(plan.stopBefore).toContain('released setup or uninstaller')
    expect(plan.environment.base).toContain('clear inherited')
    expect(plan.rootAdmission).toContain('New exact source/spec/StageA-PE/head packet')
  })

  test('binds fresh profile ownership to same-handle metadata and the original creation context', () => {
    const native = readFileSync('scripts/pr/windows-installer-profile-native.cs', 'utf8')
    const create = native.slice(native.indexOf('public override void CreateFreshProfile('), native.indexOf('private static void ProfileTrace('))
    expect(create).toContain('string callTokenOwner = RecordCreateProfileDiagnostics(state, path, "before")')
    expect(create.indexOf('string callTokenOwner = RecordCreateProfileDiagnostics(state, path, "before")')).toBeLessThan(create.indexOf('int status = CreateProfile('))
    expect(create).toContain('state.profileCreationTokenOwner = callTokenOwner')
    expect(create).toContain('AssertOwnedProfileMetadata(state, pin)')
    const metadata = native.slice(native.indexOf('private void AssertOwnedProfileMetadata('), native.indexOf('public override void SetOwnedAccountDisabled('))
    expect(metadata.indexOf('RecordFreshProfileMetadata(state, pin.initial, state.profileCreationTokenOwner)')).toBeGreaterThan(-1)
    expect(metadata.indexOf('RecordFreshProfileMetadata(state, pin.initial, state.profileCreationTokenOwner)')).toBeLessThan(metadata.indexOf('RequireFreshProfileOwner(owner, state.account.sid, state.profileCreationTokenOwner'))
    expect(metadata).not.toContain('Directory.GetAccessControl')
    expect(metadata).toContain('OwnProfileRegistration(state, true, true)')
    const diagnostics = native.slice(native.indexOf('private void RecordFreshProfileMetadata('), native.indexOf('private bool OwnProfileRegistration('))
    expect(diagnostics).toContain('OwnProfileRegistration(state, true)')
    expect(diagnostics).toContain('metadata.aces')
    expect(diagnostics).toContain('leaseGranted=false')
    expect(diagnostics).not.toMatch(/NetUser|DeleteProfile|SetAccessControl|SetOwner|profileOwnershipProven\s*=|profileCreationUncertain\s*=|error\.Message/)
    expect(native).toContain('TokenBuffer(token, 4); // TOKEN_OWNER, not TokenUser.')
    expect(native).toContain('(owner == boundSid || owner == "S-1-5-18")')
    expect(native).toContain('CorePolicy.Require(state.profileCreationAttempts == 1 && state.profileOwnershipProven && !state.profileCreationUncertain')
    const pin = native.slice(native.indexOf('private sealed class ProfileDirectoryPin'), native.indexOf('private static FileIdentity CopyProfileIdentity'))
    expect(pin).toContain('CreateFileW(path, 0x20081, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)')
    expect(pin).toContain('GetSecurityInfo(handle, 1, 5,')
    expect(pin).toContain('ReadHandleIdentity(handle, true,')
    expect(pin).toContain('(flags & 1) == 0')
    expect(pin).toContain('RequireSameProfileMetadata(initial, current)')
    expect(pin).not.toContain('Directory.GetAccessControl')
    expect(pin).toContain('if (profilesDirectory == null) CorePolicy.ValidateAbsolutePath(path)')
    expect(pin).toContain('else CorePolicy.ValidateProfileAncestorPath(path, profilesDirectory, directory)')
    const parents = native.slice(native.indexOf('private void RequireTrustedProfileParents('), native.indexOf('internal static string ProfileDaclObservation('))
    expect(parents).toContain('CorePolicy.ProfileParentPaths(profiles, directory)')
    expect(parents).toContain('ProfileDirectoryPin.OpenAncestor(parent, profiles, directory)')
    expect(parents).toContain('string profiles = ReadProfilesDirectory()')
    expect(parents).toContain('pin.RequireTrustedParentDacl(state.account.sid, profilesPin.initial.identity)')
    expect(pin).toContain('ancestorProfilesDirectory != null && ancestorDirectory != null')
    expect(pin).toContain('RequireTrustedProfileAncestorDacl(initial, boundSid, ancestorProfilesDirectory, ancestorDirectory, profilesIdentity)')
    const probe = native.slice(native.indexOf('private static void RunProfilesParentProbe('), native.indexOf('internal static FixtureReport RunAbiHarness('))
    expect(probe).toContain('CorePolicy.ProfileParentPaths(profiles, profiles)')
    expect(probe).toContain('const string syntheticBoundSid = "S-1-5-21-1879-1879-1879-4242"')
    expect(probe).toContain('syntheticBoundSid != runnerSid')
    expect(probe).toContain('pin.RequireTrustedParentDacl(syntheticBoundSid, profilesPin.initial.identity)')
    expect(probe.indexOf('ProfileAceObservations(pin.initial, syntheticBoundSid)')).toBeLessThan(probe.indexOf('pin.RequireTrustedParentDacl(syntheticBoundSid'))
    expect(probe).toContain('aceDiagnosticCharacters + row.Length > 262144')
    const policy = native.slice(native.indexOf('internal static void RequireTrustedProfileAncestorDacl('), native.indexOf('internal static void RequireFreshProfileOwner(string owner, string boundSid, string creationTokenOwner'))
    expect(policy).toContain('CorePolicy.ValidateProfileAncestorPath(metadata.identity.canonicalPath, profilesDirectory, directory)')
    expect(policy).toContain('metadata.identity.volumePath == profilesIdentity.volumePath')
    expect(policy).not.toMatch(/ProfileOwnerObservation|ProfileDaclObservation|ProfileAceObservations|allowTrustedInstaller/)
    expect(probe).not.toMatch(/CreateProfile\(|LoadUserProfileW\(|DeleteProfileW\(|NetUser|GetFileSystemEntries|EnumerateFileSystemEntries|SetAccessControl|SetOwner/)
    for (const name of ['owned-profile-metadata-same-handle', 'owned-profile-pin-rename-delete-refused', 'owned-profile-pin-release-restores-operations', 'readonly-profiles-parent-chain']) expect(native).toContain(`report.Check("${name}"`)
  })

  test('releases directory pins at the proven ledger and before each single userenv boundary', () => {
    const native = readFileSync('scripts/pr/windows-installer-profile-native.cs', 'utf8')
    const core = readFileSync('scripts/pr/windows-installer-profile-fixture.cs', 'utf8')
    const creation = core.slice(core.indexOf('private static void CreateOwnedProfileOnce('), core.indexOf('private static FixtureReport RunProfileOnly('))
    expect(creation.indexOf('state.stage = "createprofile-owner-proven"')).toBeLessThan(creation.indexOf('ReleaseProfileCreationPin(state)'))
    expect(creation).toContain('state.profileOwnershipProven = false; state.profileCreationUncertain = true')
    const ledger = core.slice(core.indexOf('private static void Ledger('), core.indexOf('public static FixtureState NewState('))
    expect(ledger).not.toMatch(/profileCreationTokenOwner|profileCreationIdentity|profileCreationPin/)
    const load = native.slice(native.indexOf('public override void LoadProfile('), native.indexOf('private static string KnownFolder('))
    expect(load).toContain('}\n      state.profileLoadAttempted = true;\n      bool loaded = LoadUserProfileW')
    expect(load.match(/bool loaded = LoadUserProfileW/g)).toHaveLength(1)
    expect(load).toContain('bool loaded = LoadUserProfileW(state.token, ref profile);\n      int loadError = Marshal.GetLastWin32Error()')
    expect(load).toContain('if (loaded) { state.profile = profile.profile; state.profileLoaded = true; }')
    expect(load.indexOf('bool loaded = LoadUserProfileW')).toBeLessThan(load.lastIndexOf('AssertOwnedProfileMetadata(state, pin)'))
    expect(load.indexOf('if (!loaded) throw new Win32Exception(loadError')).toBeGreaterThan(load.lastIndexOf('AssertOwnedProfileMetadata(state, pin)'))
    const remove = native.slice(native.indexOf('public override void DeleteOwnedProfile('), native.indexOf('public override void DeleteOwnedAccount('))
    expect(remove).toContain('}\n      state.profileDeleteAttempted = true;\n      bool deleted = DeleteProfileW')
    expect(remove.match(/bool deleted = DeleteProfileW/g)).toHaveLength(1)
    expect(remove).toContain('if (!absent) using (ProfileDirectoryPin pin')
    expect(remove).toContain('state.profileCreationUncertain = true')
  })

  test('does not acquire a compiler or run a fixture on another OS', async () => {
    const result = await runWindowsInstallerProfileChecks({ platform: 'darwin', compiler: '/not-present',
      run: async () => { throw new Error('must not execute') } })
    expect(result).toEqual({ status: 'not_run', exitCode: 0 })
  })

  test.each(['controller', 'profile-only'])('rejects %s real-execution arguments at the actual Stage A entry point', role => {
    const root = mkdtempSync(join(tmpdir(), 'cc-haha-profile-cli-'))
    try {
      const env = createSandboxedTestEnvironment(join(root, 'home'))
      const result = spawnSync(process.execPath, ['--no-env-file', 'scripts/pr/run-windows-installer-profile-checks.ts',
        '--role', role, '--spec', join(root, 'not-an-admission.json')], { env, encoding: 'utf8', timeout: 10_000 })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Stage A accepts no account/profile execution arguments')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('compiles private frozen source bytes and runs both modes with the same binary before cleanup', async () => {
    const f = fixture()
    try {
      expect(await runWindowsInstallerProfileChecks(f.options)).toEqual({ status: 'passed', exitCode: 0 })
      expect(f.calls).toHaveLength(5)
      expect(f.calls[4]![1]).toBe('--f1-audit-canary')
      expect(f.calls[0]).toContain('/platform:x64')
      expect(f.calls[0]).toContain('/r:System.Management.dll')
      expect(f.calls[0]!.filter(arg => arg.endsWith('.cs'))).toHaveLength(3)
      expect(f.calls[1]![0]).toBe(f.calls[2]![0])
      expect(f.calls[1]![1]).toBe('--self-test')
      expect(f.calls[2]![1]).toBe('--abi-harness')
      expect(f.calls[3]![0]).toBe(f.powershell)
      expect(f.calls[3]).toContain('-PacketDirectory')
      expect(f.calls.flat()).not.toContain('--role')
      const report = JSON.parse(readFileSync(join(f.evidenceRoot, 'checks.json'), 'utf8'))
      expect(report.runner).toBe('test-double')
      expect(report.status).toBe('passed')
      expect(report.realAccountsCreated).toBe(0)
      expect(report.full_old_to_new).toBe('not_run')
      expect(report.privateRootRemoved).toBe(true)
      expect(report.f1NativeCanary.status).toBe('not_proven')
      expect(existsSync(report.temporaryRoot)).toBe(false)
      expect(report.sources[0].sha256).not.toBe(report.sources[0].canonicalSha256)
      expect(report.executableSha256).toBe(createHash('sha256').update('MZ-owned-fixture-double').digest('hex'))
      expect(JSON.parse(readFileSync(join(f.evidenceRoot, 'profile-only-preflight.raw.json'), 'utf8')).checks).toHaveLength(19)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })


  test('owned native canary preserves exact raw provenance without upgrading F1 or Stage A semantics', async () => {
    const f = fixture()
    try {
      let raw = ''
      expect(await runWindowsInstallerProfileChecks({ ...f.options, run: async (command, options) => {
        const result = await f.run!(command, options)
        if (command[1] === '--f1-audit-canary') {
          expect(options.env.CI).toBe('true')
          expect(options.env.GITHUB_ACTIONS).toBe('true')
          expect(options.timeoutMs).toBeLessThanOrEqual(60_000)
          raw = JSON.stringify(f.result('f1-native-canary')).replace('"retainedHandle":2', '"retainedHandle":18446744073709551615')
          writeFileSync(command[command.indexOf('--output') + 1]!, raw)
        }
        return result
      } })).toEqual({ status: 'passed', exitCode: 0 })
      expect(readFileSync(join(f.evidenceRoot, 'f1-native-canary.raw.json'), 'utf8')).toBe(raw)
      const consumer = JSON.parse(readFileSync(join(f.evidenceRoot, 'f1-native-canary-consumer.json'), 'utf8'))
      expect(consumer.status).toBe('not_proven')
      expect(consumer.capability).toBe('not_proven')
      expect(consumer.F1).toBe('not_proven')
      expect(consumer.reportSha256).toBe(createHash('sha256').update(raw).digest('hex'))
      expect(consumer.privateRootRetained).toBe(false)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })


  test.each(['safe-report', 'unsafe-report'])('owned native canary safety repair keeps %s stdio markers private before every publication path', async fault => {
    const f = fixture()
    const marker = 'CapturedData=PRIVATE_CANARY_MARKER_1879'
    try {
      expect(await runWindowsInstallerProfileChecks({ ...f.options, run: async (command, options) => {
        if (command[1] !== '--f1-audit-canary') return f.run!(command, options)
        f.calls.push(command)
        const value = f.result('f1-native-canary') as Record<string, unknown>
        if (fault === 'unsafe-report') value.CapturedData = marker
        writeFileSync(command[command.indexOf('--output') + 1]!, JSON.stringify(value))
        return { exitCode: 0, stdout: fault === 'safe-report' ? marker : '', stderr: fault === 'unsafe-report' ? marker : '' }
      } })).toEqual({ status: 'failed', exitCode: 1 })
      const checks = readFileSync(join(f.evidenceRoot, 'checks.json'), 'utf8')
      const report = JSON.parse(checks)
      expect(checks).not.toContain(marker)
      expect(readFileSync(join(f.evidenceRoot, 'f1-native-canary.log'), 'utf8')).not.toContain(marker)
      expect(readFileSync(join(f.evidenceRoot, 'f1-native-canary-consumer.json'), 'utf8')).not.toContain(marker)
      expect(existsSync(join(f.evidenceRoot, 'f1-native-canary.raw.json'))).toBe(false)
      expect(report.privateRootRemoved).toBe(false)
      const privateLog = join(report.temporaryRoot, `f1-native-canary.${fault === 'safe-report' ? 'stdout' : 'stderr'}.private.log`)
      expect(readFileSync(privateLog, 'utf8')).toContain(marker)
      const command = report.commands.find((entry: { name: string }) => entry.name === 'f1-native-canary')
      expect(command.stdout).toBeUndefined()
      expect(command.stderr).toBeUndefined()
      expect(command.stdoutSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(command.stderrSha256).toMatch(/^[0-9a-f]{64}$/)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  test.each(['18446744073709551616', '-1', '1.0', '1e0'])('owned native canary safety repair rejects lossless invalid UInt64 token %s', token => {
    const f = fixture()
    try {
      const value = f.result('f1-native-canary')
      const raw = JSON.stringify(value).replace('"retainedHandle":2', `"retainedHandle":${token}`)
      expect(() => validateF1NativeCanaryResult(raw, value.binarySha256)).toThrow('UInt64')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  test.each(['unsupported', 'missing-report', 'timeout'])('owned native canary keeps %s advisory evidence unproven and preserves unknown resources', async fault => {
    const f = fixture()
    try {
      expect(await runWindowsInstallerProfileChecks({ ...f.options, run: async (command, options) => {
        if (command[1] !== '--f1-audit-canary') return f.run!(command, options)
        f.calls.push(command)
        if (fault !== 'missing-report') {
          const value = f.result('f1-native-canary')
          value.status = 'failed'
          value.checks = [{ name: 'f1-zero-account-native', status: 'failed', detail: 'f1-native-provider-unsupported' }]
          value.cleanup = fault === 'timeout' ? 'unknown' : 'passed'
          writeFileSync(command[command.indexOf('--output') + 1]!, JSON.stringify(value))
        }
        return { exitCode: 1, stdout: '', stderr: 'Installer profile fixture stopped: Native operation failed (Win32 50)\n', timedOut: fault === 'timeout' }
      } })).toEqual({ status: 'passed', exitCode: 0 })
      const report = JSON.parse(readFileSync(join(f.evidenceRoot, 'checks.json'), 'utf8'))
      const consumer = JSON.parse(readFileSync(join(f.evidenceRoot, 'f1-native-canary-consumer.json'), 'utf8'))
      expect(consumer.status).not.toBe('passed')
      expect(consumer.F1).toBe('not_proven')
      expect(report.status).toBe('passed')
      expect(report.privateRootRemoved).toBe(fault === 'unsupported')
      expect(existsSync(report.temporaryRoot)).toBe(fault !== 'unsupported')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  test.each(['account', 'profile', 'product', 'promoted', 'payload', 'unknown-field', 'wrong-hash', 'false-success', 'oversize', 'changed-binary', 'output-link', 'cleanup-contradiction', 'duplicate-key'])('owned native canary rejects unsafe %s reports without publishing their raw bytes', async fault => {
    const f = fixture()
    try {
      expect(await runWindowsInstallerProfileChecks({ ...f.options, run: async (command, options) => {
        if (command[1] !== '--f1-audit-canary') return f.run!(command, options)
        f.calls.push(command)
        const value = f.result('f1-native-canary') as Record<string, unknown>
        const native = value.f1NativeCanary as Record<string, unknown>
        if (fault === 'account') value.realAccountsCreated = 1
        if (fault === 'profile') value.realProfilesCreated = 1
        if (fault === 'product') value.releasedPeMayHaveExecuted = true
        if (fault === 'promoted') value.full_old_to_new = 'passed'
        if (fault === 'payload') native.CapturedData = 'never publish'
        if (fault === 'unknown-field') value.extra = { value: 'never publish' }
        if (fault === 'wrong-hash') value.binarySha256 = '0'.repeat(64)
        if (fault === 'false-success') native.eventsLost = null
        if (fault === 'cleanup-contradiction') { value.status = 'failed'; native.closed = false }
        const output = command[command.indexOf('--output') + 1]!
        if (fault === 'output-link') {
          const outside = join(f.root, 'owned-outside.json')
          writeFileSync(outside, JSON.stringify(value))
          symlinkSync(outside, output)
        } else {
          const raw = JSON.stringify(value)
          writeFileSync(output, fault === 'duplicate-key' ? raw.replace('"trace":[]', '"trace":{"CapturedData":"never publish"},"trace":[]') : raw)
        }
        if (fault === 'changed-binary') writeFileSync(command[0]!, 'MZ-mutated-after-canary')
        return { exitCode: 0, stdout: '', stderr: fault === 'oversize' ? 'x'.repeat(65_537) : '' }
      } })).toEqual({ status: 'failed', exitCode: 1 })
      expect(existsSync(join(f.evidenceRoot, 'f1-native-canary.raw.json'))).toBe(false)
      const report = JSON.parse(readFileSync(join(f.evidenceRoot, 'checks.json'), 'utf8'))
      expect(report.status).toBe('failed')
      expect(report.privateRootRemoved).toBe(false)
      expect(existsSync(report.temporaryRoot)).toBe(true)
      expect(JSON.parse(readFileSync(join(f.evidenceRoot, 'f1-native-canary-consumer.json'), 'utf8')).status).toBe('failed')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  test('owned native canary validator rejects a summary-only exit-zero report', () => {
    expect(() => validateF1NativeCanaryResult({ version: 1, status: 'passed' }, '0'.repeat(64))).toThrow('canary')
  })

  test.each(['schema', 'counter', 'unknown-field', 'unencoded'])('owned native canary rejected %s reports publish only fixed field diagnostics and encoded failures', async fault => {
    const f = fixture()
    const marker = 'PRIVATE_REJECTED_NATIVE_VALUE_1879'
    const labelSha256 = createHash('sha256').update('fixed operation label').digest('hex')
    try {
      expect(await runWindowsInstallerProfileChecks({ ...f.options, run: async (command, options) => {
        if (command[1] !== '--f1-audit-canary') return f.run!(command, options)
        const value = f.result('f1-native-canary') as Record<string, unknown>
        value.status = 'failed'
        value.cleanup = 'unknown'
        value.checks = [{ name: 'f1-zero-account-native', status: 'failed', detail: fault === 'unencoded'
          ? `Native operation failed (${marker})`
          : `f1-canary-failure-operation-code-00000005-labelchars-21-labelsha-${labelSha256}` }]
        const native = value.f1NativeCanary as Record<string, unknown>
        if (fault === 'schema' || fault === 'unencoded') native.nativeSchemaShapes = [marker]
        if (fault === 'counter') native.ownedRecords = -1
        if (fault === 'unknown-field') native[marker] = marker
        writeFileSync(command[command.indexOf('--output') + 1]!, JSON.stringify(value))
        return { exitCode: 1, stdout: '', stderr: '' }
      } })).toEqual({ status: 'failed', exitCode: 1 })
      const raw = readFileSync(join(f.evidenceRoot, 'f1-native-canary-consumer.json'), 'utf8')
      const consumer = JSON.parse(raw)
      expect(consumer.validationFailure).toMatchObject(fault === 'schema' || fault === 'unencoded'
        ? { path: 'f1NativeCanary.nativeSchemaShapes[0]', reason: 'metadata-shape', valueType: 'string', characters: marker.length,
          sha256: createHash('sha256').update(marker).digest('hex') }
        : fault === 'counter'
          ? { path: 'f1NativeCanary.ownedRecords', reason: 'unsigned-counter', valueType: 'number' }
          : { path: 'f1NativeCanary', reason: 'unknown-field', valueType: 'object' })
      expect(consumer.producerFailures).toEqual(fault === 'unencoded' ? undefined : [{ check: 'f1-zero-account-native', kind: 'operation', code: '00000005',
        labelCharacters: 21, labelHashState: 'sha256', labelSha256 }])
      expect(consumer.status).toBe('failed')
      expect(consumer.F1).toBe('not_proven')
      expect(consumer.privateRootRetained).toBe(true)
      expect(existsSync(join(f.evidenceRoot, 'f1-native-canary.raw.json'))).toBe(false)
      expect(raw).not.toContain(marker)
      expect(readFileSync(join(f.evidenceRoot, 'checks.json'), 'utf8')).not.toContain(marker)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  test.each(['compile', 'self-test', 'abi-harness', 'profile-only-preflight'])('propagates a failing %s and never runs the following phase', async phase => {
    const f = fixture()
    try {
      const result = await runWindowsInstallerProfileChecks({ ...f.options, run: async (command, options) => {
        const name = command[0] === f.compiler ? 'compile' : command[0] === f.powershell ? 'profile-only-preflight' : command[1]!.slice(2)
        if (name === phase) {
          f.calls.push(command)
          if (phase !== 'compile') {
            const output = command[command.indexOf(phase === 'profile-only-preflight' ? '-OutputPath' : '--output') + 1]!
            writeFileSync(output, JSON.stringify({ ...f.result(phase), status: 'failed', failedStage: 'owned-API' }))
          }
          return { exitCode: 7, stdout: '', stderr: 'fixture failure' }
        }
        return f.run!(command, options)
      } })
      expect(result).toEqual({ status: 'failed', exitCode: 1 })
      expect(f.calls).toHaveLength(['compile', 'self-test', 'abi-harness', 'profile-only-preflight'].indexOf(phase) + 1)
      const report = JSON.parse(readFileSync(join(f.evidenceRoot, 'checks.json'), 'utf8'))
      expect(report.error).toContain(`${phase} failed`)
      expect(report.realAccountsCreated).toBe('not_proven')
      expect(report.privateRootRemoved).toBe(true)
      if (phase !== 'compile') {
        expect(JSON.parse(readFileSync(join(f.evidenceRoot, `${phase}.raw.json`), 'utf8')).failedStage).toBe('owned-API')
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test.each(['missing-result', 'empty-checks', 'real-account', 'promoted-profile', 'binary-changed', 'binary-report-mismatch', 'timeout'])('rejects false success from %s', async fault => {
    const f = fixture()
    try {
      const result = await runWindowsInstallerProfileChecks({ ...f.options, run: async (command, options) => {
        if (command[1] !== '--self-test') return f.run!(command, options)
        f.calls.push(command)
        const output = command[command.indexOf('--output') + 1]!
        const result = f.result('self-test')
        if (fault === 'empty-checks') result.checks = []
        if (fault === 'real-account') result.realAccountsCreated = 1
        if (fault === 'promoted-profile') result.full_old_to_new = 'passed'
        if (fault === 'binary-report-mismatch') result.binarySha256 = '0'.repeat(64)
        if (fault !== 'missing-result') writeFileSync(output, JSON.stringify(result))
        if (fault === 'binary-changed') writeFileSync(command[0]!, 'MZ-changed')
        return { exitCode: 0, stdout: '', stderr: '', timedOut: fault === 'timeout' }
      } })
      expect(result).toEqual({ status: 'failed', exitCode: 1 })
      expect(f.calls).toHaveLength(2)
      const report = JSON.parse(readFileSync(join(f.evidenceRoot, 'checks.json'), 'utf8'))
      expect(report.status).toBe('failed')
      expect(report.privateRootRemoved).toBe(true)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('rejects profile claims and a temporary root inside source before invoking a compiler', async () => {
    const f = fixture()
    try {
      expect(() => validateStageAResult({ ...f.result('abi-harness'), realProfilesCreated: 1 }, 'abi-harness')).toThrow('Stage B')
      await expect(runWindowsInstallerProfileChecks({ ...f.options, tempParent: f.sourceRoot })).rejects.toThrow('outside source')
      expect(f.calls).toHaveLength(0)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('fails an exit-zero ABI report when cleanup failed', async () => {
    const f = fixture()
    try {
      const result = await runWindowsInstallerProfileChecks({ ...f.options, run: async (command, options) => {
        const result = await f.run!(command, options)
        if (command[1] === '--abi-harness') {
          const output = command[command.indexOf('--output') + 1]!
          writeFileSync(output, JSON.stringify({ ...f.result('abi-harness'), cleanup: 'failed' }))
        }
        return result
      } })
      expect(result).toEqual({ status: 'failed', exitCode: 1 })
      const report = JSON.parse(readFileSync(join(f.evidenceRoot, 'checks.json'), 'utf8'))
      expect(report.error).toContain('ABI cleanup')
      expect(report.privateRootRemoved).toBe(true)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test.each(['engine', 'missing-check', 'real-account', 'cleanup', 'source-pin'])(
    'rejects an exit-zero PowerShell preflight with invalid %s evidence', async fault => {
      const f = fixture()
      try {
        const result = await runWindowsInstallerProfileChecks({ ...f.options, run: async (command, options) => {
          if (command[0] !== f.powershell) return f.run!(command, options)
          const value = f.result('profile-only-preflight')
          if (fault === 'engine') value.engine = 'PowerShell7-Core'
          if (fault === 'missing-check') value.checks.pop()
          if (fault === 'real-account') value.realAccountsCreated = 1
          if (fault === 'cleanup') value.cleanup = 'failed'
          if (fault === 'source-pin') value.packetHashes!['pins.proposed.json'] = '0'.repeat(64)
          writeFileSync(command[command.indexOf('-OutputPath') + 1]!, JSON.stringify(value))
          return { exitCode: 0, stdout: '', stderr: '' }
        } })
        expect(result).toEqual({ status: 'failed', exitCode: 1 })
        const report = JSON.parse(readFileSync(join(f.evidenceRoot, 'checks.json'), 'utf8'))
        expect(report.status).toBe('failed')
        expect(report.privateRootRemoved).toBe(true)
        expect(report.realAccountsCreated).toBe('not_proven')
      } finally {
        rmSync(f.root, { recursive: true, force: true })
      }
    },
  )

  test('does not accept a summary-only preflight success', () => {
    expect(() => validateProfileOnlyPreflightResult({ version: 1, status: 'passed' })).toThrow('preflight')
  })
})

describe('docs deployment workflow', () => {
  test('builds and uploads the isolated React site', () => {
    const workflow = readFileSync('.github/workflows/deploy-docs.yml', 'utf8')

    expect(workflow).toContain("      - 'site/**'")
    expect(workflow).toContain('cache-dependency-path: site/package-lock.json')
    expect(workflow).toContain('run: npm --prefix site ci')
    expect(workflow).toContain('run: npm --prefix site run build')
    expect(workflow).toContain('path: site/dist')
    expect(workflow).not.toContain('vitepress')
    expect(workflow).not.toContain('docs/.vitepress/dist')
  })
})
