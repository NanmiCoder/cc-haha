import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { canonicalReviewBytes, claimProfileReview, collectProfileReviewEvidence, normalizedReviewedFiles, profileReview, reviewHash, validateFirstReviewRun, validateReviewInvocation } from './windows-installer-profile-review'

const head = 'a'.repeat(40)
function context() {
  return {
    event: { action: 'labeled', number: 1883, label: { name: profileReview.labelPrefix + head }, sender: { login: 'NanmiCoder' }, repository: { full_name: profileReview.repository }, pull_request: { number: 1883, base: { ref: 'main' }, head: { sha: head, ref: profileReview.branch, repo: { full_name: profileReview.headRepository } } } },
    env: { CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: profileReview.repository, GITHUB_ACTOR: 'NanmiCoder', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '501', GITHUB_RUN_NUMBER: '17' },
  }
}
function current() {
  return { id: 501, workflow_id: 90, run_number: 17, run_attempt: 1, head_sha: head, event: 'pull_request', display_title: profileReview.runNamePrefix + head, actor: { login: 'NanmiCoder' } }
}
function temporary<T>(run: (root: string) => T) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'profile-review-policy-')))
  try { return run(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

describe('explicit historical profile review admission', () => {
  test('accepts only the exact original PR/head/actor label, with no native operation', () => {
    const { event, env } = context()
    expect(validateReviewInvocation(event, env)).toEqual({ head, runId: 501, runNumber: 17 })
  })

  test.each(['push', 'synchronize', 'actor', 'sender', 'label', 'head', 'fork', 'branch', 'base', 'number', 'repository', 'rerun', 'local', 'run-id'])(
    'rejects a missing or changed admission boundary: %s', fault => {
      const { event, env } = context()
      if (fault === 'push') env.GITHUB_EVENT_NAME = 'push'
      if (fault === 'synchronize') event.action = 'synchronize'
      if (fault === 'actor') env.GITHUB_ACTOR = 'contributor'
      if (fault === 'sender') event.sender.login = 'contributor'
      if (fault === 'label') event.label.name = profileReview.labelPrefix + 'b'.repeat(40)
      if (fault === 'head') event.pull_request.head.sha = 'main'
      if (fault === 'fork') event.pull_request.head.repo.full_name = 'other/cc-haha'
      if (fault === 'branch') event.pull_request.head.ref = 'other'
      if (fault === 'base') event.pull_request.base.ref = 'release'
      if (fault === 'number') event.number++
      if (fault === 'repository') env.GITHUB_REPOSITORY = 'other/cc-haha'
      if (fault === 'rerun') env.GITHUB_RUN_ATTEMPT = '2'
      if (fault === 'local') env.GITHUB_ACTIONS = 'false'
      if (fault === 'run-id') env.GITHUB_RUN_ID = '../not-a-run'
      expect(() => validateReviewInvocation(event, env)).toThrow()
    },
  )

  test('missing fork event payload fails closed', () => {
    expect(() => validateReviewInvocation({}, context().env)).toThrow()
  })

  test('uses workflow run_number, rather than assuming run_id ordering', () => {
    const invocation = validateReviewInvocation(context().event, context().env)
    expect(() => validateFirstReviewRun(invocation, current(), { total_count: 2, workflow_runs: [current(), { ...current(), id: 100, run_number: 18 }] })).not.toThrow()
    expect(() => validateFirstReviewRun(invocation, current(), { total_count: 2, workflow_runs: [current(), { ...current(), id: 999, run_number: 16 }] })).toThrow('already consumed')
  })

  test.each(['failed-first-run', 'missing-current', 'incomplete-page', 'rerun', 'wrong-current-actor', 'duplicate-id', 'duplicate-number', 'missing-actor', 'missing-title', 'empty-title', 'unknown-title', 'changed-current', 'unassociated-row'])(
    'never retries or accepts incomplete first-use evidence: %s', fault => {
      const invocation = validateReviewInvocation(context().event, context().env)
      const run = current()
      let history = { total_count: 1, workflow_runs: [current()] }
      if (fault === 'failed-first-run') history = { total_count: 2, workflow_runs: [{ ...current(), id: 500, run_number: 16 }, current()] }
      if (fault === 'missing-current') history = { total_count: 0, workflow_runs: [] }
      if (fault === 'incomplete-page') history.total_count = 101
      if (fault === 'rerun') run.run_attempt = 2
      if (fault === 'wrong-current-actor') run.actor.login = 'other'
      if (fault === 'duplicate-id') history = { total_count: 2, workflow_runs: [current(), current()] }
      if (fault === 'duplicate-number') history = { total_count: 2, workflow_runs: [current(), { ...current(), id: 502 }] }
      if (fault === 'missing-actor') history = { total_count: 2, workflow_runs: [current(), { ...current(), id: 500, run_number: 16, actor: undefined as never }] }
      if (fault === 'missing-title') history = { total_count: 2, workflow_runs: [current(), { ...current(), id: 500, run_number: 16, display_title: undefined as never }] }
      if (fault === 'empty-title') history = { total_count: 2, workflow_runs: [current(), { ...current(), id: 500, run_number: 16, display_title: '' }] }
      if (fault === 'unknown-title') history = { total_count: 2, workflow_runs: [current(), { ...current(), id: 500, run_number: 16, display_title: 'unrecognized' }] }
      if (fault === 'changed-current') history.workflow_runs[0].display_title = 'changed'
      if (fault === 'unassociated-row') history = { total_count: 2, workflow_runs: [current(), { ...current(), id: 500, run_number: 16, workflow_id: 91 }] }
      expect(() => validateFirstReviewRun(invocation, run, history)).toThrow()
    },
  )

  test('unrelated/inactive label runs do not consume this activation', () => {
    const invocation = validateReviewInvocation(context().event, context().env)
    expect(() => validateFirstReviewRun(invocation, current(), { total_count: 2, workflow_runs: [current(), { ...current(), id: 400, run_number: 16, display_title: 'inactive-profile-review' }] })).not.toThrow()
  })

  test.each(['valid', 'expired', 'source-run', 'digest', 'size'])(
    'reads only immutable original artifacts before any staging: %s', async fault => {
      const invocation = validateReviewInvocation(context().event, context().env)
      const calls: string[] = []
      const get = async (path: string) => {
        calls.push(path)
        if (path === '/actions/runs/501') return current()
        if (path.startsWith('/actions/workflows/90/runs?')) return { total_count: 1, workflow_runs: [current()] }
        const pin = profileReview.artifacts.find(item => path === `/actions/artifacts/${item.id}`)!
        expect(pin).toBeDefined()
        return { id: pin.id, name: pin.name, size_in_bytes: fault === 'size' ? 1 : pin.size, digest: fault === 'digest' ? 'changed' : pin.digest, expired: fault === 'expired', workflow_run: { id: fault === 'source-run' ? 1 : profileReview.sourceRun } }
      }
      if (fault === 'valid') await expect(claimProfileReview(invocation, get)).resolves.toBeUndefined()
      else await expect(claimProfileReview(invocation, get)).rejects.toThrow()
      expect(calls.every(path => path.startsWith('/actions/'))).toBe(true)
    },
  )
})

describe('reviewed bytes and bounded evidence', () => {
  test('preserves raw-source distinction while normalizing approved text to LF/no BOM', () => {
    expect(canonicalReviewBytes(Buffer.from('\ufeffline\r\n')).toString()).toBe('line\n')
    expect(() => canonicalReviewBytes(Buffer.from([0xff]))).toThrow()
    const files = normalizedReviewedFiles(resolve('scripts/pr/windows-installer-profile-review'))
    expect(files).toHaveLength(4)
    for (const file of files) expect(reviewHash(file.bytes)).toBe(profileReview.files[file.name as keyof typeof profileReview.files])
    for (const pin of profileReview.sources) expect(reviewHash(canonicalReviewBytes(readFileSync(join('scripts/pr', pin.file))))).toBe(pin.canonical)
  })

  test('detects script edits even when checkout line endings differ', () => temporary(root => {
    for (const name of Object.keys(profileReview.files)) {
      const bytes = readFileSync(join('scripts/pr/windows-installer-profile-review', name), 'utf8')
      writeFileSync(join(root, name), '\ufeff' + bytes.replace(/\n/g, '\r\n'))
    }
    expect(normalizedReviewedFiles(root)).toHaveLength(4)
    writeFileSync(join(root, 'launch-stage-b.proposed.ps1'), 'unreviewed command')
    expect(() => normalizedReviewedFiles(root)).toThrow('Reviewed file changed')
  }))

  test('missing native reports remain unknown after failure', () => temporary(root => {
    const result = collectProfileReviewEvidence(join(root, 'absent'), join(root, 'evidence'), 'failure')
    expect(result.effects).toContain('unknown')
    expect(result).not.toHaveProperty('cleanup')
    expect(result).not.toHaveProperty('releasedPeExecuted')
    expect(result.fullF1).toBe('not_complete')
  }))

  test('a successful launcher without its original reports is an evidence failure', () => temporary(root => {
    expect(() => collectProfileReviewEvidence(join(root, 'absent'), join(root, 'evidence'), 'success')).toThrow()
    expect(JSON.parse(readFileSync(join(root, 'evidence/collection.json'), 'utf8')).errors).toHaveLength(9)
  }))

  function mockCompletedEvidence(stage: string) {
    mkdirSync(join(stage, 'controller/evidence'), { recursive: true })
    const binding = { runId: profileReview.runId, owner: profileReview.owner, generation: 1, specSha256: profileReview.specSha256 }
    const accountSid = 'S-1-5-21-1-2-3-1003'
    const marker = `CcHaha1879:${profileReview.runId}:${'a'.repeat(32)}`
    const evidenceFiles: Record<string, string> = {}
    for (const name of ['negative-before.json', 'negative-after.json', 'positive-kept-before.json', 'positive-kept-after.json']) {
      const content = JSON.stringify({ fixture: name })
      writeFileSync(join(stage, 'controller/evidence', name), content)
      evidenceFiles[name] = reviewHash(content)
    }
    writeFileSync(join(stage, 'launch-receipt.json'), JSON.stringify({ ...binding, runnerSid: 'S-1-5-21-1-2-3-1001', stageBase: profileReview.stageBase, controllerPid: 777, controllerBirthUtc: '2026-01-01T00:00:00.0000000Z', binarySha256: profileReview.binarySha256, status: 'native_historical_B_passed_only_F1_incomplete', controllerStartAttempted: true, controllerStarted: true, nativeExitCode: 0, nativeCleanup: 'cleaned', releasedPeMayHaveExecuted: true }))
    writeFileSync(join(stage, 'controller/ledger.json'), JSON.stringify({ ...binding, version: 1, accountBound: true, accountCreated: true, marker, intentSam: 'c1879_aaaaaaaaaaaa', account: { sid: accountSid, sam: 'c1879_aaaaaaaaaaaa', marker } }))
    writeFileSync(join(stage, 'controller/controller-report.json'), JSON.stringify({ version: 1, mode: 'controller', status: 'passed', cleanup: 'cleaned', binarySha256: profileReview.binarySha256, specSha256: profileReview.specSha256, realAccountsCreated: 1, realProfilesCreated: 1, releasedPeExecuted: true, releasedPeMayHaveExecuted: true, compatibilityEnabled: false, oldExit22Policy: 'fatal', member_proven: 'not_run', full_old_to_new: 'not_run', installed_bytes_equal: 'native_equal_exact_pin', old22_before_protected_mutation: 'native_exit22_and_final_state_equal_only;transient_operation_order_not_proven', removal_equivalence: 'old_binary_positive_only;trusted_replacement_equivalence_not_run', evidenceFiles }))
    writeFileSync(join(stage, 'controller.stdout.log'), '')
    writeFileSync(join(stage, 'controller.stderr.log'), '')
  }

  test('copies only exact bounded mock reports, never subject inputs, executable or profile files', () => temporary(root => {
    const stage = join(root, 'stage')
    mockCompletedEvidence(stage)
    mkdirSync(join(stage, 'controller/subject-input'), { recursive: true })
    writeFileSync(join(stage, 'controller/subject-input/old-setup.exe'), 'do not copy')
    const report = collectProfileReviewEvidence(stage, join(root, 'evidence'), 'success')
    expect(report.files).toHaveLength(9)
    expect(report.files.some(file => file.name.includes('subject-input'))).toBe(false)
  }))

  test('reads Windows PowerShell UTF8-BOM receipts while preserving original bytes and hashes', () => temporary(root => {
    const stage = join(root, 'stage')
    mockCompletedEvidence(stage)
    const receipt = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(join(stage, 'launch-receipt.json'))])
    writeFileSync(join(stage, 'launch-receipt.json'), receipt)
    const destination = join(root, 'evidence')
    const result = collectProfileReviewEvidence(stage, destination, 'success')
    expect(readFileSync(join(destination, 'launch-receipt.json')).equals(receipt)).toBe(true)
    expect(result.files.find(file => file.name === 'launch-receipt.json')?.sha256).toBe(reviewHash(receipt))
  }))

  test.each(['ledger', 'snapshot', 'log', 'empty-report', 'stage-a-report', 'binary', 'spec', 'scope', 'snapshot-hash', 'marker', 'runner-sid', 'stage-base', 'pid', 'birth'])(
    'successful collection rejects missing or unbound original evidence: %s', fault => temporary(root => {
      const stage = join(root, 'stage')
      mockCompletedEvidence(stage)
      if (fault === 'ledger') rmSync(join(stage, 'controller/ledger.json'))
      if (fault === 'snapshot') rmSync(join(stage, 'controller/evidence/negative-before.json'))
      if (fault === 'log') rmSync(join(stage, 'controller.stdout.log'))
      if (fault === 'snapshot-hash') writeFileSync(join(stage, 'controller/evidence/negative-before.json'), '{"changed":true}')
      if (fault === 'marker') {
        const ledger = JSON.parse(readFileSync(join(stage, 'controller/ledger.json'), 'utf8'))
        ledger.account.marker = 'other'
        writeFileSync(join(stage, 'controller/ledger.json'), JSON.stringify(ledger))
      }
      if (['runner-sid', 'stage-base', 'pid', 'birth'].includes(fault)) {
        const launch = JSON.parse(readFileSync(join(stage, 'launch-receipt.json'), 'utf8'))
        if (fault === 'runner-sid') delete launch.runnerSid
        if (fault === 'stage-base') launch.stageBase = 'other'
        if (fault === 'pid') delete launch.controllerPid
        if (fault === 'birth') launch.controllerBirthUtc = 'unknown'
        writeFileSync(join(stage, 'launch-receipt.json'), JSON.stringify(launch))
      }
      const native = JSON.parse(readFileSync(join(stage, 'controller/controller-report.json'), 'utf8'))
      if (fault === 'binary') native.binarySha256 = '0'.repeat(64)
      if (fault === 'spec') native.specSha256 = '0'.repeat(64)
      if (fault === 'scope') native.full_old_to_new = 'passed'
      if (fault === 'stage-a-report') Object.assign(native, { mode: 'abi-harness', cleanup: 'passed', realAccountsCreated: 0, realProfilesCreated: 0, releasedPeExecuted: false })
      if (fault === 'empty-report') writeFileSync(join(stage, 'controller/controller-report.json'), '{}')
      else writeFileSync(join(stage, 'controller/controller-report.json'), JSON.stringify(native))
      expect(() => collectProfileReviewEvidence(stage, join(root, 'evidence'), 'success')).toThrow()
      expect(JSON.parse(readFileSync(join(root, 'evidence/collection.json'), 'utf8')).errors.length).toBeGreaterThan(0)
    }),
  )

  test.skipIf(process.platform === 'win32')('rejects a symlink rather than following it into other state', () => temporary(root => {
    mkdirSync(join(root, 'stage'))
    writeFileSync(join(root, 'outside'), 'protected')
    symlinkSync(join(root, 'outside'), join(root, 'stage/launch-receipt.json'))
    expect(() => collectProfileReviewEvidence(join(root, 'stage'), join(root, 'evidence'), 'failure')).toThrow()
  }))
})

test('manual workflow stays inactive by default and preserves serial fail-closed execution', () => {
  const workflow = parse(readFileSync('.github/workflows/windows-installer-profile-review.yml', 'utf8'))
  expect(workflow.on).toEqual({ pull_request: { types: ['labeled'] } })
  expect(workflow.permissions).toEqual({})
  expect(workflow.concurrency['cancel-in-progress']).toBe(false)
  const job = workflow.jobs['historical-profile']
  expect(job.if).toContain("github.actor == 'NanmiCoder'")
  expect(job.if).toContain("github.run_attempt == 1")
  expect(job.if).toContain("format('p1879b-{0}', github.event.pull_request.head.sha)")
  expect(job.permissions).toEqual({ contents: 'read', actions: 'read' })
  expect(job['timeout-minutes']).toBe(25)
  const steps = job.steps
  expect(steps[0].with.ref).toBe('${{ github.event.pull_request.head.sha }}')
  const native = steps.findIndex((step: { id?: string }) => step.id === 'historical')
  const reconcile = steps.findIndex((step: { name?: string }) => step.name?.startsWith('Reconcile only'))
  expect(reconcile).toBe(native + 1)
  expect(steps[native].shell).toBe('powershell')
  expect(steps[reconcile].shell).toBe('powershell')
  expect(steps[reconcile].if).toContain("steps.historical.outcome != 'success'")
  for (const step of steps) expect(step['continue-on-error']).toBeUndefined()
  expect(steps.filter((step: { uses?: string }) => step.uses === 'actions/download-artifact@v4').map((step: { with: Record<string, unknown> }) => step.with['artifact-ids'])).toEqual(['14008657574', '14007544990'])
})
