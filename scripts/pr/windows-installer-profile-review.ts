import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

// This entry point only claims/stages/collects evidence. It never starts the
// native fixture, a product executable, or the account-disable proposal.
export const profileReview = {
  repository: 'NanmiCoder/cc-haha',
  actor: 'NanmiCoder',
  number: 1883,
  headRepository: 'toBerlinWay/cc-haha',
  branch: 'fix/installer-fallback-foreign-helpers',
  admittedHead: '9578b040d3f41060fc9b1e0a16fab2233939287c',
  consumedRunId: 43380589124,
  runNamePrefix: 'profile1879-b:',
  labelPrefix: 'p1879b-',
  runId: '52f4ce19-5ded-4b27-8268-a2840809e0ca',
  owner: 'codex:local:01a1c9a5-381e-7b33-9648-c8968b61de4c',
  specSha256: '337f999c0c3a0417c90ab4aae501849901ddf82c1d44d522083f311036de0a90',
  binarySha256: 'da7dfc9ffa9adbeb693736b79afaf78e9872a1df239b4e1e1eb6b377690c5cf8',
  binaryBytes: 195584,
  setupSha256: 'dca6bb82f4d0fbee8d43c91912e4d50e7dcea69a7cb22c51cdd9cb265767c7e7',
  setupBytes: 230611497,
  sourceRun: 43361834858,
  stageBase: 'D:\\a\\_temp\\cc-haha-1879-b-e5aad0f-52f4ce19-g1',
  files: {
    'launch-stage-b.proposed.ps1': '5ec0e3b5eabd25f366a9bf14a6980ca8308695120dcfeae9d67a13a4083ada6d',
    'reconcile-stage-b.proposed.ps1': '905a35d62ff264ce12b4440134a534dd3031a3bac2d90372d2a2e68ec2ef3136',
    'controller-spec.proposed-admitted.json': '337f999c0c3a0417c90ab4aae501849901ddf82c1d44d522083f311036de0a90',
    'pins.json': '0ff5b638c795c87bb6d0c364b66bb3dce43b81a9773c18bae8d0b366ad38326b',
  },
  sources: [
    { file: 'windows-installer-profile-fixture.cs', raw: 'be94a5b91a66f9d30eb8ecf459520fa07089d1db777771ef2e00738d8cfe99eb', canonical: '31a2110598c6985656f0df3ec717f973c01160519677c7e4101d1195d9e8d4ae' },
    { file: 'windows-installer-profile-native.cs', raw: '6c32ed94be091b3ed60875edc538ca12aaca2585c30f44842539871271792a63', canonical: 'fa12526e9f78946443115b598bb9e128cbf3ef0e2dbd5388399e3de782920b2b' },
    { file: 'windows-installer-profile-fixture-tests.cs', raw: 'f49653cbd4ee376bf697fbe24ed284bdc93718bb638c4cfd3bc6348869bd4fc1', canonical: '1cc49d1e4825db0c770eeed898bd7ad3214123d6a9c60fde595c83ad453361f0' },
  ],
  artifacts: [
    { id: 14008657574, name: 'windows-installer-evidence', size: 250963, digest: 'sha256:d824034fbfb1e28aa2bc68307ca6a85878891d599b32db2accd8d2b1e6a87e25' },
    { id: 14007544990, name: 'windows-installer-v078-fixture', size: 230574750, digest: 'sha256:23b814c8bd7df50db1a749cb600d6696cf72e0516c1eb6cdba215bee3d4be54b' },
  ],
} as const

function requireReview(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

export function reviewHash(bytes: Uint8Array | string) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function canonicalReviewBytes(bytes: Uint8Array) {
  // Checkout may translate text to CRLF. The approved scripts/spec/pins are LF
  // without BOM. The three compiled A sources retain their separate RAW pins.
  return Buffer.from(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n'))
}

export type ReviewInvocation = { head: string; runId: number; runNumber: number }
type ReviewEvent = {
  action?: string
  number?: number
  label?: { name?: string }
  sender?: { login?: string }
  repository?: { full_name?: string }
  pull_request?: { number?: number; base?: { ref?: string }; head?: { sha?: string; ref?: string; repo?: { full_name?: string } } }
}

export function validateReviewInvocation(event: ReviewEvent, env: Record<string, string | undefined>): ReviewInvocation {
  const head = event.pull_request?.head?.sha
  requireReview(env.CI === 'true' && env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'pull_request', 'Explicit Actions pull_request context required')
  requireReview(env.GITHUB_REPOSITORY === profileReview.repository && event.repository?.full_name === profileReview.repository, 'Wrong repository')
  requireReview(event.action === 'labeled' && event.number === profileReview.number && event.pull_request?.number === profileReview.number, 'Only original PR label admission is accepted')
  requireReview(event.pull_request.base?.ref === 'main', 'Original main target required')
  requireReview(env.GITHUB_ACTOR === profileReview.actor && event.sender?.login === profileReview.actor, 'Only the reviewed coordinator actor may activate this run')
  requireReview(typeof head === 'string' && /^[0-9a-f]{40}$/.test(head), 'Exact PR head required')
  requireReview(head === profileReview.admittedHead, 'Historical admission cannot be reused for a new fixture head')
  requireReview(event.pull_request?.head?.repo?.full_name === profileReview.headRepository && event.pull_request.head.ref === profileReview.branch, 'Original fork and branch required')
  requireReview(event.label?.name === profileReview.labelPrefix + head, 'Label must bind this exact PR head')
  requireReview(env.GITHUB_RUN_ATTEMPT === '1', 'Reruns are forbidden, including after failure')
  const runId = Number(env.GITHUB_RUN_ID)
  const runNumber = Number(env.GITHUB_RUN_NUMBER)
  requireReview(Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(runNumber) && runNumber > 0, 'Exact run identity required')
  return { head, runId, runNumber }
}

type ReviewRun = { id: number; workflow_id: number; run_number: number; run_attempt: number; head_sha: string; event: string; display_title: string; actor: { login: string } }

export function validateFirstReviewRun(invocation: ReviewInvocation, current: ReviewRun, history: { total_count: number; workflow_runs: ReviewRun[] }) {
  const validRun = (run: ReviewRun) => run && Number.isSafeInteger(run.id) && run.id > 0 &&
    Number.isSafeInteger(run.workflow_id) && run.workflow_id > 0 &&
    Number.isSafeInteger(run.run_number) && run.run_number > 0 &&
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0 &&
    typeof run.head_sha === 'string' && /^[0-9a-f]{40}$/.test(run.head_sha) &&
    typeof run.event === 'string' && typeof run.display_title === 'string' && run.display_title.length > 0 &&
    typeof run.actor?.login === 'string' && run.actor.login.length > 0
  requireReview(validRun(current), 'Malformed current workflow run')
  const title = profileReview.runNamePrefix + invocation.head
  requireReview(current.id === invocation.runId && current.run_number === invocation.runNumber && current.run_attempt === 1 && current.head_sha === invocation.head && current.event === 'pull_request' && current.display_title === title && current.actor?.login === profileReview.actor, 'Current workflow run does not match admission')
  requireReview(Number.isSafeInteger(history.total_count) && history.total_count > 0 && history.total_count <= 100 && Array.isArray(history.workflow_runs) && history.total_count === history.workflow_runs.length, 'Incomplete workflow history; stop without retry')
  const ids = new Set<number>()
  const numbers = new Set<number>()
  for (const run of history.workflow_runs) {
    requireReview(validRun(run) && run.workflow_id === current.workflow_id && run.head_sha === invocation.head && run.event === 'pull_request', 'Malformed or unassociated workflow history row')
    requireReview(run.display_title === title || run.display_title === 'inactive-profile-review', 'Unrecognized workflow history title; stop unknown')
    requireReview(!ids.has(run.id) && !numbers.has(run.run_number), 'Duplicate workflow history identity')
    ids.add(run.id)
    numbers.add(run.run_number)
    if (run.id === current.id) requireReview(run.run_number === current.run_number && run.run_attempt === current.run_attempt && run.display_title === current.display_title && run.actor.login === current.actor.login, 'Current workflow history row changed')
  }
  const admitted = history.workflow_runs.filter(run => run.workflow_id === current.workflow_id && run.head_sha === invocation.head && run.event === 'pull_request' && run.display_title === title && run.actor?.login === profileReview.actor)
  requireReview(admitted.some(run => run.id === current.id), 'Current run is absent from history')
  requireReview(admitted.every(run => Number.isSafeInteger(run.run_number) && run.run_number >= current.run_number), 'This head already consumed its first activation; no retries')
}

function ordinaryFile(path: string, maximumBytes: number) {
  const file = lstatSync(path)
  requireReview(file.isFile() && !file.isSymbolicLink() && file.size <= maximumBytes, 'Expected bounded ordinary file')
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const directory = lstatSync(parent)
    requireReview(directory.isDirectory() && !directory.isSymbolicLink(), 'Reparse or invalid input ancestor')
    if (dirname(parent) === parent) break
  }
  return readFileSync(path)
}

export function normalizedReviewedFiles(source: string) {
  return Object.entries(profileReview.files).map(([name, expected]) => {
    const bytes = canonicalReviewBytes(ordinaryFile(join(source, name), 65536))
    requireReview(reviewHash(bytes) === expected, `Reviewed file changed: ${name}`)
    return { name, bytes }
  })
}

export function validateOriginalAInputs(sourceRoot: string, stageA: string, setup: string) {
  for (const pin of profileReview.sources) {
    requireReview(reviewHash(ordinaryFile(join(stageA, pin.file), 262144)) === pin.raw, 'Original A raw source changed')
    requireReview(reviewHash(canonicalReviewBytes(ordinaryFile(join(sourceRoot, 'scripts/pr', pin.file), 262144))) === pin.canonical, 'Current fixture source differs from the original A binary')
  }
  const binary = ordinaryFile(join(stageA, 'profile-fixture.exe'), profileReview.binaryBytes)
  requireReview(binary.length === profileReview.binaryBytes && reviewHash(binary) === profileReview.binarySha256, 'Original A PE changed; rebuilding is forbidden')
  const setupBytes = ordinaryFile(setup, profileReview.setupBytes)
  requireReview(setupBytes.length === profileReview.setupBytes && reviewHash(setupBytes) === profileReview.setupSha256, 'Original full released setup changed')
}

type GitHubRead = (path: string) => Promise<unknown>
export async function claimProfileReview(invocation: ReviewInvocation, get: GitHubRead) {
  const current = await get(`/actions/runs/${invocation.runId}`) as ReviewRun
  requireReview(Number.isSafeInteger(current.workflow_id) && current.workflow_id > 0, 'Workflow identity missing')
  const history = await get(`/actions/workflows/${current.workflow_id}/runs?head_sha=${invocation.head}&event=pull_request&per_page=100`) as { total_count: number; workflow_runs: ReviewRun[] }
  validateFirstReviewRun(invocation, current, history)
  for (const pin of profileReview.artifacts) {
    const artifact = await get(`/actions/artifacts/${pin.id}`) as { id: number; name: string; size_in_bytes: number; digest: string; expired: boolean; workflow_run?: { id: number } }
    requireReview(artifact.id === pin.id && artifact.name === pin.name && artifact.size_in_bytes === pin.size && artifact.digest === pin.digest && artifact.expired === false && artifact.workflow_run?.id === profileReview.sourceRun, 'Original reviewed artifact is missing, expired or changed')
  }
}

function output(name: string, value: string) {
  requireReview(!/[\r\n]/.test(value), 'Multiline Actions output rejected')
  requireReview(process.env.GITHUB_OUTPUT, 'Actions output file missing')
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

function runnerPaths() {
  requireReview(process.platform === 'win32' && process.env.RUNNER_TEMP === 'D:\\a\\_temp' && process.env.GITHUB_WORKSPACE === 'D:\\a\\cc-haha\\cc-haha', 'Reviewed disposable Windows runner paths required')
  return { workspace: process.env.GITHUB_WORKSPACE, temporary: process.env.RUNNER_TEMP }
}

function invocationFromEnvironment() {
  requireReview(process.env.GITHUB_EVENT_PATH, 'Actions event file missing')
  return validateReviewInvocation(JSON.parse(ordinaryFile(process.env.GITHUB_EVENT_PATH, 1048576).toString('utf8')), process.env)
}

const evidenceNames = [
  'launch-receipt.json', 'controller.stdout.log', 'controller.stderr.log', 'reconcile-receipt.json',
  'controller/controller-report.json', 'controller/ledger.json',
  'controller/evidence/negative-before.json', 'controller/evidence/negative-after.json',
  'controller/evidence/positive-kept-before.json', 'controller/evidence/positive-kept-after.json',
] as const

export function collectProfileReviewEvidence(stageBase: string, destination: string, launcherOutcome: string) {
  mkdirSync(destination, { recursive: true })
  const files: { name: string; bytes: number; sha256: string }[] = []
  const errors: string[] = []
  for (const name of evidenceNames) {
    const input = join(stageBase, name)
    if (!existsSync(input)) continue
    try {
      const bytes = ordinaryFile(input, 16777216)
      const target = join(destination, name)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes, { flag: 'wx' })
      files.push({ name, bytes: bytes.length, sha256: reviewHash(bytes) })
    } catch { errors.push(`Evidence unavailable or unsafe: ${name}`) }
  }
  if (launcherOutcome === 'success') {
    const requiredFiles = evidenceNames.filter(name => name !== 'reconcile-receipt.json')
    for (const required of requiredFiles) {
      if (!files.some(file => file.name === required)) errors.push(`Successful launcher evidence is missing: ${required}`)
    }
    if (errors.length === 0) {
      try {
        const json = (name: string) => {
          const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(join(destination, name))))
          requireReview(value && typeof value === 'object' && !Array.isArray(value), 'Native evidence is not an object')
          return value
        }
        const launch = json('launch-receipt.json')
        const native = json('controller/controller-report.json')
        const ledger = json('controller/ledger.json')
        const bound = (value: Record<string, unknown>) => value.runId === profileReview.runId && value.owner === profileReview.owner && value.generation === 1 && value.specSha256 === profileReview.specSha256
        requireReview(bound(launch) && bound(ledger), 'Native ownership report binding changed')
        requireReview(typeof launch.runnerSid === 'string' && /^S-1-5-(?:[0-9]+-)*[0-9]+$/.test(launch.runnerSid) && launch.stageBase === profileReview.stageBase && Number.isSafeInteger(launch.controllerPid) && launch.controllerPid > 4 && typeof launch.controllerBirthUtc === 'string' && launch.controllerBirthUtc.endsWith('Z') && Number.isFinite(Date.parse(launch.controllerBirthUtc)), 'Original runner/process receipt identity missing')
        requireReview(launch.status === 'native_historical_B_passed_only_F1_incomplete' && launch.controllerStartAttempted === true && launch.controllerStarted === true && launch.nativeExitCode === 0 && launch.nativeCleanup === 'cleaned' && launch.binarySha256 === profileReview.binarySha256 && launch.releasedPeMayHaveExecuted === true, 'Successful launcher terminal binding changed')
        requireReview(native.version === 1 && native.mode === 'controller' && native.status === 'passed' && native.cleanup === 'cleaned' && native.binarySha256 === profileReview.binarySha256 && native.specSha256 === profileReview.specSha256, 'Successful native terminal binding changed')
        requireReview(native.realAccountsCreated === 1 && native.realProfilesCreated === 1 && native.releasedPeExecuted === true && native.releasedPeMayHaveExecuted === true && native.compatibilityEnabled === false && native.oldExit22Policy === 'fatal' && native.member_proven === 'not_run' && native.full_old_to_new === 'not_run', 'Native scope facts changed')
        requireReview(native.installed_bytes_equal === 'native_equal_exact_pin' && native.old22_before_protected_mutation === 'native_exit22_and_final_state_equal_only;transient_operation_order_not_proven' && native.removal_equivalence === 'old_binary_positive_only;trusted_replacement_equivalence_not_run', 'Historical evidence scope changed')
        requireReview(ledger.version === 1 && ledger.accountBound === true && ledger.accountCreated === true && ledger.account?.sid !== launch.runnerSid && /^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+$/.test(ledger.account?.sid ?? ''), 'Owned ledger SID binding missing')
        const marker = /^CcHaha1879:52f4ce19-5ded-4b27-8268-a2840809e0ca:([0-9a-f]{32})$/.exec(ledger.marker)
        requireReview(marker && ledger.account.marker === ledger.marker && ledger.intentSam === `c1879_${marker[1].slice(0, 12)}` && ledger.account.sam === ledger.intentSam, 'Owned ledger marker binding changed')
        const snapshots = ['negative-before.json', 'negative-after.json', 'positive-kept-before.json', 'positive-kept-after.json']
        requireReview(native.evidenceFiles && Object.keys(native.evidenceFiles).sort().join('|') === snapshots.toSorted().join('|'), 'Missing original historical evidence bindings')
        for (const name of snapshots) {
          const copied = files.find(file => file.name === `controller/evidence/${name}`)!
          requireReview(copied.sha256 === native.evidenceFiles[name], 'Historical snapshot bytes changed')
        }
      } catch { errors.push('Successful native evidence binding failed; preserve originals and reconcile') }
    }
  }
  const report = {
    kind: 'bounded-B-evidence-collection-only', launcherOutcome, files, errors,
    effects: 'Read original native reports; missing/stale/failed reports remain unknown, never not_run or cleaned',
    compatibilityEnabled: false, oldExit22Policy: 'fatal', fullF1: 'not_complete',
  }
  writeFileSync(join(destination, 'collection.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  requireReview(errors.length === 0, 'Bounded evidence collection failed')
  return report
}

async function main() {
  requireReview(process.argv.length === 3 && ['--claim', '--prepare', '--collect'].includes(process.argv[2]), 'Explicit claim/prepare/collect mode required; no native execution mode exists')
  const paths = runnerPaths()
  const invocation = invocationFromEnvironment()
  requireReview(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: paths.workspace, encoding: 'utf8' }).trim() === invocation.head, 'Checkout is not the admitted exact head')
  const receipt = join(paths.temporary, `cc-haha-1879-b-claim-${invocation.runId}.json`)
  if (process.argv[2] === '--claim') {
    requireReview(process.env.PROFILE_REVIEW_TOKEN, 'Read-only Actions token missing')
    const get: GitHubRead = async path => {
      const response = await fetch(`https://api.github.com/repos/${profileReview.repository}${path}`, { headers: { Authorization: `Bearer ${process.env.PROFILE_REVIEW_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } })
      requireReview(response.ok, `GitHub read failed (${response.status})`)
      return response.json()
    }
    await claimProfileReview(invocation, get)
    writeFileSync(receipt, `${JSON.stringify(invocation)}\n`, { flag: 'wx' })
    return
  }
  const claimed = JSON.parse(ordinaryFile(receipt, 4096).toString('utf8')) as ReviewInvocation
  requireReview(claimed.head === invocation.head && claimed.runId === invocation.runId && claimed.runNumber === invocation.runNumber, 'Claim receipt does not bind this run')
  const evidence = join(paths.workspace, 'artifacts/windows-installer-profile-review')
  if (process.argv[2] === '--collect') {
    collectProfileReviewEvidence(profileReview.stageBase, evidence, process.env.PROFILE_LAUNCHER_OUTCOME ?? 'unknown')
    return
  }
  const stageA = join(paths.temporary, 'cc-haha-1879-reviewed-A', 'profile-stage-a')
  const setup = join(paths.temporary, 'cc-haha-1879-reviewed-v078', 'Claude-Code-Haha-0.7.8-Windows-x64-Setup.exe')
  validateOriginalAInputs(paths.workspace, stageA, setup)
  const reviewed = normalizedReviewedFiles(join(paths.workspace, 'scripts/pr/windows-installer-profile-review'))
  const staged = join(paths.temporary, `cc-haha-1879-reviewed-scripts-${invocation.runId}`)
  mkdirSync(staged)
  for (const file of reviewed) writeFileSync(join(staged, file.name), file.bytes, { flag: 'wx' })
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, 'activation.json'), `${JSON.stringify({ ...invocation, actor: profileReview.actor, label: profileReview.labelPrefix + invocation.head, sourceRun: profileReview.sourceRun, originalBinarySha256: profileReview.binarySha256, specSha256: profileReview.specSha256, stageB: 'not_started_by_preparation' }, null, 2)}\n`, { flag: 'wx' })
  output('package_dir', staged)
  output('stage_a_dir', stageA)
  output('setup_path', setup)
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Profile review preparation failed')
    process.exitCode = 1
  })
}
