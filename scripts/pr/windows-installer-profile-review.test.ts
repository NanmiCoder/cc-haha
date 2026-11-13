import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { profileOnlyBootstrapEnvironment, profileOnlyPowerShell51, claimProfileOnlyReview, collectProfileOnlyEvidence, prepareProfileOnlyPacket, profileOnlyPaths, profileOnlyReview, validateProfileOnlyAInputs, validateProfileOnlyClaim, type ProfileOnlyClaim, canonicalReviewBytes, claimProfileReview, collectProfileReviewEvidence, normalizedReviewedFiles, profileReview, reviewHash, validateFirstReviewRun, validateOriginalAInputs, validateReviewInvocation } from './windows-installer-profile-review'

const head = profileReview.admittedHead
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

  test('a correctly labeled future head cannot reuse the consumed historical admission', () => {
    const { event, env } = context()
    event.pull_request.head.sha = 'b'.repeat(40)
    event.label.name = profileReview.labelPrefix + event.pull_request.head.sha
    expect(() => validateReviewInvocation(event, env)).toThrow('Historical admission cannot be reused')
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
    // The current fixture evolves after the historical admission was consumed.
    // Its frozen A pins remain enforced by the input validator, not rewritten
    // to make a new fixture look like the original PE.
  })

  test('new fixture source cannot substitute for an original A raw source', () => temporary(root => {
    const source = join(root, 'source')
    const stageA = join(root, 'stage-a')
    mkdirSync(source)
    mkdirSync(stageA)
    writeFileSync(join(stageA, profileReview.sources[0].file), 'new source; not the frozen historical A input')
    expect(() => validateOriginalAInputs(source, stageA, join(root, 'not-a-setup.exe'))).toThrow('Original A raw source changed')
  }))

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

test('consumed workflow cannot serve a new head or run and preserves its historical serial record', () => {
  const workflow = parse(readFileSync('.github/workflows/windows-installer-profile-review.yml', 'utf8'))
  expect(workflow.on).toEqual({ pull_request: { types: ['labeled'] } })
  expect(workflow.permissions).toEqual({})
  expect(workflow.concurrency['cancel-in-progress']).toBe(false)
  const job = workflow.jobs['historical-profile']
  expect(job.if).toContain(`github.event.pull_request.head.sha == '${profileReview.admittedHead}'`)
  expect(job.if).toContain(`github.run_id == '${profileReview.consumedRunId}'`)
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


describe('separate profile-only review', () => {
  test.each(['missing', 'Core7', 'uppercase', 'duplicate-casing'])('binds fresh 5.1 module discovery independently of %s parent paths', mode => {
    const parent: Record<string, string | undefined> = { GITHUB_RUN_ID: '43434043080', GITHUB_EVENT_PATH: 'D:\\a\\event.json', SystemRoot: 'C:\\Windows', PATH: 'kept' }
    if (mode === 'Core7') parent.PSModulePath = 'C:\\Program Files\\PowerShell\\7\\Modules'
    if (mode === 'uppercase') parent.PSMODULEPATH = 'Z:\\untrusted-parent-modules'
    if (mode === 'duplicate-casing') { parent.PSModulePath = 'bad-one'; parent.psmodulepath = 'bad-two' }
    const before = { ...parent }
    const child = profileOnlyBootstrapEnvironment(parent)
    expect(child.PSModulePath).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules')
    expect(Object.keys(child).filter(key => key.toUpperCase() === 'PSMODULEPATH')).toEqual(['PSModulePath'])
    expect(child.GITHUB_RUN_ID).toBe(parent.GITHUB_RUN_ID)
    expect(child.GITHUB_EVENT_PATH).toBe(parent.GITHUB_EVENT_PATH)
    expect(child.SystemRoot).toBe(parent.SystemRoot)
    expect(child.PATH).toBe(parent.PATH)
    expect(parent).toEqual(before)
    expect(profileOnlyPowerShell51).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  test('persists armed intent before the sole native Start and retains bounded failure metadata', () => {
    const launch = readFileSync('scripts/pr/windows-installer-profile-only/fixtures/launch-profile-only.proposed.ps1', 'utf8')
    expect(launch.indexOf("$stage='persist-arm-before-start'")).toBeLessThan(launch.indexOf("$stage='process-start'"))
    expect(launch.indexOf("$stage='process-start'")).toBeLessThan(launch.indexOf('Require-True ($process.Start())'))
    expect(launch.match(/\$process\.Start\(\)/g)).toHaveLength(1)
    for (const name of ['launch', 'reconcile']) {
      const source = readFileSync(`scripts/pr/windows-installer-profile-only/fixtures/${name}-profile-only.proposed.ps1`, 'utf8')
      expect(source).toContain('[IO.File]::Replace($temporary,$Path,[System.Management.Automation.Language.NullString]::Value)')
      expect(source).not.toContain('[IO.File]::Replace($temporary,$Path,$null)')
      expect(source).toContain('Get-SafeFailure $_')
      expect(source).toContain('receiptWriteError=Get-SafeFailure $_')
      expect(source).toContain("$type='unavailable'")
    }
  })

  const workspace = resolve('.')
  const head = 'a'.repeat(40)
  const claimantHash = reviewHash(canonicalReviewBytes(readFileSync('scripts/pr/windows-installer-profile-review.ts')))
  function context() {
    return {
      event: { action: 'labeled', number: 1883, label: { name: profileOnlyReview.labelPrefix + head }, sender: { login: 'NanmiCoder' }, repository: { full_name: profileReview.repository }, pull_request: { number: 1883, base: { ref: 'main' }, head: { sha: head, ref: profileReview.branch, repo: { full_name: profileReview.headRepository } } } },
      env: { CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: profileReview.repository, GITHUB_ACTOR: 'NanmiCoder', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '501', GITHUB_RUN_NUMBER: '117' },
    }
  }
  function invocation() { return validateReviewInvocation(context().event, context().env, 'profile-only') }
  function current() { return { id: 501, workflow_id: profileOnlyReview.workflowId, run_number: 117, run_attempt: 1, head_sha: head, event: 'pull_request', display_title: profileOnlyReview.runNamePrefix + head, actor: { login: profileReview.actor } } }
  function artifact() { const pin = profileOnlyReview.artifact; return { id: pin.id, name: pin.name, size_in_bytes: pin.size, digest: pin.digest, expired: false, workflow_run: { id: profileOnlyReview.sourceRun, head_sha: profileOnlyReview.sourceHead } } }
  function claim(): ProfileOnlyClaim { return { version: 1, status: 'first_matching_run_claimed', repository: profileReview.repository, ...invocation(), runAttempt: 1, workflowId: profileOnlyReview.workflowId, displayTitle: current().display_title, minimumMatchingRunNumber: 117, minimumMatchingRunId: 501, completePagination: true, claimantSourceSha256: claimantHash } }
  function packet() { return prepareProfileOnlyPacket(workspace, invocation(), claim()) }
  function temporary<T>(run: (root: string) => T) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'profile-only-contract-')))
    try { return run(root) } finally { rmSync(root, { recursive: true, force: true }) }
  }

  describe('separate profile-only activation and complete first invocation claim', () => {
    test('accepts the new exact-head coordinator label while historical admission still refuses it', () => {
      expect(invocation()).toEqual({ head, runId: 501, runNumber: 117 })
      expect(() => validateReviewInvocation(context().event, context().env)).toThrow('Historical admission cannot be reused')
    })

    test.each(['ordinary-push', 'synchronize', 'old-label', 'old-head', 'actor', 'sender', 'number', 'base', 'fork', 'branch', 'repository', 'attempt', 'head', 'run-id'])('denies %s before a request or write', fault => {
      const { event, env } = context()
      if (fault === 'ordinary-push') env.GITHUB_EVENT_NAME = 'push'
      if (fault === 'synchronize') event.action = 'synchronize'
      if (fault === 'old-label') event.label.name = profileReview.labelPrefix + head
      if (fault === 'old-head') { event.pull_request.head.sha = profileReview.admittedHead; event.label.name = profileOnlyReview.labelPrefix + profileReview.admittedHead }
      if (fault === 'actor') env.GITHUB_ACTOR = 'other'
      if (fault === 'sender') event.sender.login = 'other'
      if (fault === 'number') event.pull_request.number = 1879
      if (fault === 'base') event.pull_request.base.ref = 'other'
      if (fault === 'fork') event.pull_request.head.repo.full_name = 'other/repo'
      if (fault === 'branch') event.pull_request.head.ref = 'other'
      if (fault === 'repository') event.repository.full_name = 'other/repo'
      if (fault === 'attempt') env.GITHUB_RUN_ATTEMPT = '2'
      if (fault === 'head') event.pull_request.head.sha = 'merge-ref'
      if (fault === 'run-id') env.GITHUB_RUN_ID = '../fake'
      expect(() => validateReviewInvocation(event, env, 'profile-only')).toThrow()
    })

    test('fully paginates ordinary PR runs and claims only the earliest matching invocation', async () => {
      const ordinary = Array.from({ length: 100 }, (_, index) => ({ ...current(), id: 1000 + index, run_number: index + 1, display_title: 'ordinary PR title', actor: { login: 'contributor' } }))
      const calls: string[] = []
      const result = await claimProfileOnlyReview(invocation(), async path => {
        calls.push(path)
        if (path === '/actions/runs/501') return current()
        if (path === `/actions/artifacts/${profileOnlyReview.artifact.id}`) return artifact()
        return { total_count: 101, workflow_runs: path.endsWith('page=1') ? ordinary : [current()] }
      }, claimantHash)
      expect(result).toEqual(claim())
      expect(calls).toHaveLength(4)
      expect(calls[2]).toEndWith('per_page=100&page=2')
    })

  test('an earlier consumed invocation on a later page still forbids a new activation', async () => {
    const first = [current(), ...Array.from({ length: 99 }, (_, index) => ({ ...current(), id: 2000 + index, run_number: 17 + index, display_title: 'ordinary PR title' }))]
    let artifactRequested = false
    await expect(claimProfileOnlyReview(invocation(), async path => {
      if (path === '/actions/runs/501') return current()
      if (path.startsWith('/actions/artifacts/')) { artifactRequested = true; return artifact() }
      return { total_count: 101, workflow_runs: path.endsWith('page=1') ? first : [{ ...current(), id: 9999, run_number: 16 }] }
    }, claimantHash)).rejects.toThrow('already consumed')
    expect(artifactRequested).toBe(false)
  })

    test.each(['earlier-failed-invocation', 'duplicate-id', 'duplicate-number', 'changed-total', 'short-page', 'API-truncation', 'unassociated-row', 'wrong-title', 'current-rerun', 'wrong-workflow', 'artifact-expired', 'artifact-digest', 'artifact-run', 'artifact-head'])('rejects %s without treating history as complete', async fault => {
      const run = current()
      const previous = { ...current(), id: 9999, run_number: 116 }
      const pin = artifact()
      if (fault === 'wrong-title') run.display_title = 'ordinary PR title'
      if (fault === 'current-rerun') run.run_attempt = 2
      if (fault === 'wrong-workflow') run.workflow_id++
      if (fault === 'artifact-expired') pin.expired = true
      if (fault === 'artifact-digest') pin.digest = 'sha256:' + '0'.repeat(64)
      if (fault === 'artifact-run') pin.workflow_run.id++
      if (fault === 'artifact-head') pin.workflow_run.head_sha = 'b'.repeat(40)
      await expect(claimProfileOnlyReview(invocation(), async path => {
        if (path === '/actions/runs/501') return run
        if (path.startsWith('/actions/artifacts/')) return pin
        if (fault === 'API-truncation') return { total_count: 1001, workflow_runs: [run] }
        if (fault === 'short-page') return { total_count: 2, workflow_runs: [run] }
        if (fault === 'changed-total') return { total_count: path.endsWith('page=1') ? 101 : 102, workflow_runs: Array.from({ length: 100 }, (_, index) => ({ ...run, id: 2000 + index, run_number: index + 1, display_title: 'ordinary' })) }
        if (fault === 'earlier-failed-invocation') return { total_count: 2, workflow_runs: [run, previous] }
        if (fault === 'duplicate-id') return { total_count: 2, workflow_runs: [run, { ...previous, id: run.id }] }
        if (fault === 'duplicate-number') return { total_count: 2, workflow_runs: [run, { ...previous, run_number: run.run_number }] }
        if (fault === 'unassociated-row') return { total_count: 2, workflow_runs: [run, { ...previous, head_sha: 'c'.repeat(40) }] }
        return { total_count: 1, workflow_runs: [run] }
      }, claimantHash)).rejects.toThrow()
    })

    test('a historical three-field receipt and changed complete fields cannot become a protected claim', () => {
      expect(() => validateProfileOnlyClaim(invocation() as ProfileOnlyClaim, invocation(), claimantHash)).toThrow('Complete profile-only claim')
      for (const [key, value] of Object.entries({ runAttempt: 2, workflowId: 90, displayTitle: profileReview.runNamePrefix + head, completePagination: false, minimumMatchingRunNumber: 116, minimumMatchingRunId: 7, claimantSourceSha256: '0'.repeat(64) })) {
        expect(() => validateProfileOnlyClaim({ ...claim(), [key]: value }, invocation(), claimantHash)).toThrow()
      }
    })
  })

  describe('runtime profile-only packet, without account or Profile execution', () => {
    test('binds a new activation separately from the verified owner-diagnostic Stage A source/PE', () => {
      const prepared = packet()
      expect(prepared.pins.activationHead).toBe(head)
      expect(profileOnlyReview.sourceHead).toBe('96bbcdf2a863f015202107790466411f1ac6b4b8')
      expect(prepared.pins.candidateSourceCommit).toBe(profileOnlyReview.sourceHead)
      expect(prepared.pins.stageA.head).toBe(prepared.pins.candidateSourceCommit)
      expect(prepared.pins.stageA.head).not.toBe(prepared.pins.activationHead)
      expect(prepared.pins.binarySha256).toBe(profileOnlyReview.binarySha256)
      expect(prepared.spec.expectedBinarySha256).toBe('973f1d1b24f238f83482a6de0f1480c385d2a989a36c84d3d6926a2134048d9e')
      expect(prepared.pins.binaryBytes).toBe(238080)
      expect(prepared.pins.stageA.artifactId).toBe(14054648898)
      expect(prepared.pins.stageA.runId).toBe(43458800075)
      expect(prepared.pins.stageA.zipBytes).toBe(profileOnlyReview.artifact.size)
      expect(`sha256:${prepared.pins.stageA.zipSha256}`).toBe(profileOnlyReview.artifact.digest)
      expect(prepared.pins.stageA.selfTestChecks).toBe(102)
      expect(prepared.pins.stageA.selfTestSha256).toBe('765a7eaf921b66ef4306caaae927598efb3f0a6e40f354f90f3b129c33900222')
      expect(prepared.spec.sourcePins).toEqual(prepared.pins.sourcePins.map(({ file, sha256 }: { file: string; sha256: string }) => ({ file, sha256 })))
      expect(prepared.spec.setupPath).toBeNull()
      expect(prepared.spec.mode).toBe('createprofile-only-controller')
      expect(prepared.spec.executionStage).toBe('profile-only')
      expect(prepared.spec.realExecutionAdmitted).toBe(true)
      expect(prepared.paths).toEqual(profileOnlyPaths(head))
      expect(prepared.spec.sourceRoot).toBe(prepared.paths.stageBase + '\\input')
      expect(prepared.spec.controllerRoot).toBe(prepared.paths.stageBase + '\\controller')
      expect(prepared.admission.allowedRunId).toBeNull()
      expect(prepared.admission.allowedWorkflowId).toBe(profileOnlyReview.workflowId)
      expect(prepared.admission.maximumControllerStarts).toBe(1)
      expect(prepared.admission.maximumCreateProfileCalls).toBe(1)
      expect(prepared.admission.maximumFreshOwnedSids).toBe(1)
      for (const [key, name] of [['pins', 'pins.proposed.json'], ['spec', 'profile-only-spec.proposed.json'], ['admission', 'root-admission.proposed.json']] as const) expect(prepared.hashes[key]).toBe(reviewHash(prepared.files.find(file => file.name === name)!.bytes))
      expect(prepared.pins.launcherSha256).toBe(reviewHash(prepared.files.find(file => file.name.startsWith('launch-'))!.bytes))
      expect(prepared.pins.reconcileSha256).toBe(reviewHash(prepared.files.find(file => file.name.startsWith('reconcile-'))!.bytes))
      for (const name of ['launch', 'reconcile']) {
        const source = readFileSync(`scripts/pr/windows-installer-profile-only/fixtures/${name}-profile-only.proposed.ps1`, 'utf8')
        expect(source).toContain(`$pins.binarySha256 -ceq '${profileOnlyReview.binarySha256}'`)
        expect(source).toContain(`$pins.binaryBytes -eq ${profileOnlyReview.binaryBytes}`)
        expect(source).toContain(`$pins.candidateSourceCommit -ceq '${profileOnlyReview.sourceHead}'`)
        expect(source).toContain('$pins.stageA.head -ceq $pins.candidateSourceCommit')
      }
      expect(JSON.parse(readFileSync('scripts/pr/windows-installer-profile-only/fixtures/profile-only-spec.proposed.json', 'utf8')).realExecutionAdmitted).toBe(false)
      expect(JSON.parse(readFileSync('scripts/pr/windows-installer-profile-only/fixtures/pins.proposed.json', 'utf8')).activationHead).toBeNull()
    })

    test.each(['candidate-source', 'stage-a-head', 'stage-a-run', 'stage-a-artifact', 'binary', 'binary-bytes', 'spec-binary'])('refuses the old148 %s identity before preparing new diagnostic inputs', fault => temporary(root => {
      const templates = join(root, 'scripts/pr/windows-installer-profile-only/fixtures')
      mkdirSync(templates, { recursive: true })
      writeFileSync(join(root, 'scripts/pr/windows-installer-profile-review.ts'), readFileSync('scripts/pr/windows-installer-profile-review.ts'))
      for (const name of ['pins.proposed.json', 'profile-only-spec.proposed.json', 'root-admission.proposed.json']) {
        const value = JSON.parse(readFileSync(join('scripts/pr/windows-installer-profile-only/fixtures', name), 'utf8'))
        if (name === 'pins.proposed.json') {
          if (fault === 'candidate-source') value.candidateSourceCommit = '1482440377d9de67f5222a3fc3db2758f03c5297'
          if (fault === 'stage-a-head') value.stageA.head = '1482440377d9de67f5222a3fc3db2758f03c5297'
          if (fault === 'stage-a-run') value.stageA.runId = 43420260030
          if (fault === 'stage-a-artifact') value.stageA.artifactId = 14034096259
          if (fault === 'binary') value.binarySha256 = 'be48adb570326e5fd23161e2f51a6af2cf4aa7f0316e6dbd85fe8a09b99fc312'
          if (fault === 'binary-bytes') value.binaryBytes = 225792
        }
        if (name === 'profile-only-spec.proposed.json' && fault === 'spec-binary') value.expectedBinarySha256 = 'be48adb570326e5fd23161e2f51a6af2cf4aa7f0316e6dbd85fe8a09b99fc312'
        writeFileSync(join(templates, name), JSON.stringify(value))
      }
      expect(() => prepareProfileOnlyPacket(root, invocation(), claim())).toThrow('Profile-only template A binding changed')
    }))

    test('denies a changed claimant and a changed raw A source before bootstrap', () => temporary(root => {
      expect(() => prepareProfileOnlyPacket(workspace, invocation(), { ...claim(), claimantSourceSha256: '0'.repeat(64) })).toThrow()
      mkdirSync(join(root, 'A'))
      writeFileSync(join(root, 'A/windows-installer-profile-fixture.cs'), 'changed')
      expect(() => validateProfileOnlyAInputs(workspace, join(root, 'A'), packet().pins)).toThrow('Current source or original raw A source changed')
    }))

    test('failure collection leaves missing/unknown state unknown, and never calls it a pass', () => temporary(root => {
      const prepared = packet()
      prepared.paths.stageBase = join(root, 'absent')
      const report = collectProfileOnlyEvidence(prepared, join(root, 'evidence'), 'failure')
      expect(report.files).toEqual([])
      expect(report.fullF1).toBe('not_proven')
      expect(report.compatibilityEnabled).toBe(false)
      expect(report.oldExit22Policy).toBe('fatal')
      expect(report.retryAllowed).toBe(false)
      expect(() => collectProfileOnlyEvidence(prepared, join(root, 'success-evidence'), 'success')).toThrow()
    }))

    test('default bootstrap has no compilation or filesystem effect and imports declarations only after its admission gate', () => {
      const source = readFileSync('scripts/pr/windows-installer-profile-only/bootstrap.ps1', 'utf8')
      expect(source.indexOf('if(-not $PrepareReviewedProfileOnly)')).toBeLessThan(source.indexOf('Get-FileHash'))
      expect(source.indexOf("'specific_profile_only_label_required'")).toBeLessThan(source.indexOf('WindowsIdentity'))
      expect(source).toContain('::CreateOwnedDirectory($directory,$runnerSid)')
      expect(source).toContain('[IO.FileMode]::CreateNew')
      expect(source).toContain('Assert-PrivateAcl (Get-Acl -LiteralPath $Path) $runnerSid $true $true $ReadOnly')
      expect(source.indexOf('SetAttributes($Path')).toBeLessThan(source.indexOf('SetAccessControl($Path'))
      expect(source).not.toMatch(/CreateProfile\(|NetUser(Add|Del)|LoadUserProfile\(|LogonUser\(|::Start\(|Remove-Item|Directory\]::Delete/)
      const launch = readFileSync('scripts/pr/windows-installer-profile-only/fixtures/launch-profile-only.proposed.ps1', 'utf8')
      expect(launch.indexOf('SetAttributes($To')).toBeLessThan(launch.indexOf('SetAccessControl($To'))
    })

    test.each(['valid', 'claim', 'activation-head', 'bootstrap', 'ledger', 'report-mode', 'binary', 'cleanup', 'F1', 'log'])('collects bounded profile-only mock evidence and rejects %s substitutions', fault => temporary(root => {
      const prepared = packet()
      Object.assign(prepared.paths, { stageBase: join(root, 'stage'), privateBootstrapRoot: join(root, 'bootstrap'), packageDirectory: join(root, 'bootstrap/packet'), stageAInputDirectory: join(root, 'A'), claimFile: join(root, 'bootstrap/claim.json') })
      mkdirSync(join(root, 'stage/controller'), { recursive: true })
      mkdirSync(join(root, 'bootstrap'))
      const bytes = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
      const binding = { runId: profileReview.runId, owner: profileReview.owner, generation: 1, specSha256: prepared.hashes.spec }
      const scope = { releasedPeExecuted: false, releasedPeMayHaveExecuted: false, releasedPeExecutionStatus: 'not_run', compatibilityEnabled: false, oldExit22Policy: 'fatal', member_proven: 'not_run', installed_bytes_equal: 'not_run', old22_before_protected_mutation: 'not_run', removal_equivalence: 'not_run', full_old_to_new: 'not_run' }
      const native = { ...scope, version: 1, mode: fault === 'report-mode' ? 'A' : 'profile-only', status: 'passed', cleanup: fault === 'cleanup' ? 'unknown' : 'cleaned', binarySha256: fault === 'binary' ? '0'.repeat(64) : profileOnlyReview.binarySha256, specSha256: prepared.hashes.spec, realAccountsCreated: 1, realProfilesCreated: 1, checks: [{ name: 'mock-profile-only', status: 'passed' }] }
      if (fault === 'F1') native.full_old_to_new = 'passed'
      writeFileSync(join(root, 'stage/controller/profile-only-report.json'), bytes(native))
      const marker = `CcHaha1879:${profileReview.runId}:${'a'.repeat(32)}`
      const ledger = { ...binding, version: 1, accountBound: true, accountCreated: true, marker, intentSam: 'c1879_aaaaaaaaaaaa', account: { sid: 'S-1-5-21-1-2-3-1002', marker, sam: 'c1879_aaaaaaaaaaaa' } }
      if (fault === 'ledger') ledger.account.sid = 'S-1-5-21-1-2-3-1001'
      writeFileSync(join(root, 'stage/controller/ledger.json'), bytes(ledger))
      const claimSha256 = reviewHash(bytes(prepared.claim))
      const launch = { ...scope, ...binding, version: 1, mode: 'profile-only-launch', status: 'native_profile_only_passed_and_cleaned_no_F1_claim', activationHead: fault === 'activation-head' ? profileOnlyReview.sourceHead : head, actionsRunId: 501, pinsSha256: prepared.hashes.pins, rootAdmissionSha256: prepared.hashes.admission, stageBase: prepared.paths.stageBase, claimFile: prepared.paths.claimFile, claimSha256: fault === 'claim' ? '0'.repeat(64) : claimSha256, nativeExitCode: 0, nativeCleanup: 'cleaned', controllerStartAttempted: true, controllerStarted: true, controllerIdentityVerified: true, controllerPid: 777, controllerBirthUtc: '2026-11-13T00:00:00.0000000Z', runnerSid: 'S-1-5-21-1-2-3-1001', stdoutComplete: true, stderrComplete: true, rawLogOverflow: false, binarySha256: profileOnlyReview.binarySha256, binaryBytes: profileOnlyReview.binaryBytes, terminalReportSha256: reviewHash(bytes(native)) }
      writeFileSync(join(root, 'stage/launch-receipt.json'), bytes(launch))
      const bootstrap = { version: 1, status: 'prepared_no_native_execution', activationHead: head, actionsRunId: 501, runnerSid: launch.runnerSid, claimSha256, accountApi: 'not_run', nativeExecution: 'not_run', roots: [prepared.paths.privateBootstrapRoot, prepared.paths.packageDirectory, prepared.paths.stageAInputDirectory].map(path => ({ path, fileIdentity: '12345678:1234567890abcdef' })) }
      if (fault === 'bootstrap') bootstrap.roots.pop()
      writeFileSync(join(root, 'bootstrap/bootstrap-receipt.json'), bytes(bootstrap))
      if (fault !== 'log') writeFileSync(join(root, 'stage/controller.stdout.raw.log'), 'mock stdout')
      writeFileSync(join(root, 'stage/controller.stderr.raw.log'), '')
      if (fault === 'valid') expect(collectProfileOnlyEvidence(prepared, join(root, 'evidence'), 'success').files).toHaveLength(6)
      else expect(() => collectProfileOnlyEvidence(prepared, join(root, 'evidence'), 'success')).toThrow()
    }))
  })

  test('existing PR Quality contains an isolated, least-permission, exact-head activation job and leaves B frozen', () => {
    const workflow = parse(readFileSync('.github/workflows/pr-quality.yml', 'utf8'))
    const job = workflow.jobs['windows-profile-only-review']
    for (const condition of ["github.event_name == 'pull_request'", "github.event.action == 'labeled'", 'github.event.pull_request.number == 1883', "github.actor == 'NanmiCoder'", "format('p1879p-{0}', github.event.pull_request.head.sha)", "github.event.pull_request.head.repo.full_name == 'toBerlinWay/cc-haha'"]) {
      expect(job.if).toContain(condition)
      expect(workflow['run-name']).toContain(condition)
      expect(workflow.concurrency.group).toContain(condition)
      expect(workflow.concurrency['cancel-in-progress']).toContain(condition)
    }
    expect(job.if).toContain('github.run_attempt == 1')
    // A forbidden rerun must keep the original title/group in history, so a
    // later label application cannot make the first consumed run disappear.
    expect(workflow['run-name']).not.toContain('github.run_attempt')
    expect(workflow.concurrency.group).not.toContain('github.run_attempt')
    expect(workflow['run-name']).toContain("format('profile1879-p:{0}', github.event.pull_request.head.sha)")
    expect(workflow.concurrency.group).toContain("format('profile1879-p-{0}-{1}'")
    expect(workflow.concurrency['cancel-in-progress']).toStartWith("${{ github.event_name == 'pull_request' && !(")
    expect(job.permissions).toEqual({ contents: 'read', actions: 'read' })
    const moduleSteps = job.steps.filter((step: { shell?: string }) => step.shell === 'powershell')
    expect(moduleSteps).toHaveLength(2)
    for (const step of moduleSteps) expect(step.env.PSModulePath).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules')
    expect(workflow.jobs['pr-quality-gate'].needs).not.toContain('windows-profile-only-review')
    const ordinaryCommands = workflow.jobs['windows-installer-checks'].steps.map((step: { run?: string }) => step.run ?? '').join('\n')
    expect(ordinaryCommands).toContain('--profile-only-bootstrap-preflight')
    expect(ordinaryCommands).toContain('$env:CC1879_PREFLIGHT_PARENT_PSHOME = $PSHOME')
    expect(ordinaryCommands).not.toContain('-PrepareReviewedProfileOnly')
    const steps = job.steps as { uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown> }[]
    const download = steps.filter(step => step.uses === 'actions/download-artifact@v4')
    expect(download).toHaveLength(1)
    expect(download[0].with?.['artifact-ids']).toBe('14054648898')
    expect(download[0].with?.['run-id']).toBe('43458800075')
    expect(steps.filter(step => step.env?.PROFILE_REVIEW_TOKEN)).toHaveLength(1)
    const commands = steps.map(step => step.run ?? '').join('\n')
    expect(commands).toContain('--profile-only-claim')
    expect(commands).toContain('--profile-only-prepare')
    expect(commands).toContain('--profile-only-collect')
    expect(commands).not.toMatch(/--role controller|--ExecuteReviewedStageB|setup\.exe|csc\.exe|--self-test/)
    const historical = readFileSync('.github/workflows/windows-installer-profile-review.yml', 'utf8')
    expect(historical).toContain("github.run_id == '43380589124'")
    expect(historical).toContain("github.event.pull_request.head.sha == '9578b040d3f41060fc9b1e0a16fab2233939287c'")
  })
})
