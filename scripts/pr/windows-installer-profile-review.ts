import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

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

// Only the fd452 Stage A component passed. Its Windows job failed the separate
// removal primitive probe. These A inputs admit no profile action, historical
// B repetition or released PE execution; a new exact-head grant is separate.
export const profileOnlyReview = {
  workflowId: 269753168,
  workflowPath: '.github/workflows/pr-quality.yml',
  runNamePrefix: 'profile1879-p:',
  labelPrefix: 'p1879p-',
  sourceHead: 'fd452cd919d1f2c79eecc3e4b7697862b3ed5a8c',
  sourceRun: 43492838022,
  artifact: { id: 14070542178, name: 'windows-installer-evidence', size: 347574, digest: 'sha256:9c6331357c6ad3693ca4c589ce20750bbd01e0e76dd9dad47f0270643a8474af' },
  binarySha256: '9c03e5b01b25503cbae216854d70991a7f781020ef8262c356dc75eea0acb782',
  binaryBytes: 283136,
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

export function validateReviewInvocation(event: ReviewEvent, env: Record<string, string | undefined>, kind: 'historical' | 'profile-only' = 'historical'): ReviewInvocation {
  const head = event.pull_request?.head?.sha
  requireReview(env.CI === 'true' && env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'pull_request', 'Explicit Actions pull_request context required')
  requireReview(env.GITHUB_REPOSITORY === profileReview.repository && event.repository?.full_name === profileReview.repository, 'Wrong repository')
  requireReview(event.action === 'labeled' && event.number === profileReview.number && event.pull_request?.number === profileReview.number, 'Only original PR label admission is accepted')
  requireReview(event.pull_request.base?.ref === 'main', 'Original main target required')
  requireReview(env.GITHUB_ACTOR === profileReview.actor && event.sender?.login === profileReview.actor, 'Only the reviewed coordinator actor may activate this run')
  requireReview(typeof head === 'string' && /^[0-9a-f]{40}$/.test(head), 'Exact PR head required')
  if (kind === 'historical') requireReview(head === profileReview.admittedHead, 'Historical admission cannot be reused for a new fixture head')
  else requireReview(head !== profileReview.admittedHead, 'Consumed historical head cannot activate profile-only')
  requireReview(event.pull_request?.head?.repo?.full_name === profileReview.headRepository && event.pull_request.head.ref === profileReview.branch, 'Original fork and branch required')
  requireReview(event.label?.name === (kind === 'historical' ? profileReview : profileOnlyReview).labelPrefix + head, 'Label must bind this exact PR head')
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

// Read-only F1 preparation. This is deliberately not a claim/activation mode.
// A complete metadata packet still cannot launch the new native role: the
// source's native audit adapter and a separate exact-head first-run grant are absent.
export const f1Preparation = {
  controllerMode: 'guarded-f1-controller', subjectMode: 'guarded-f1-subject', executionStage: 'F1',
  planSha256: '2de900f8e84dd881a9654f202dfcb651f8e143f1a817a5c1cee3db62e4ea82ad',
  environmentSha256: 'af4ce4ad3d0efb7b67b36b92149fde28a7723b79bd60e65eecc22c56402c67bd',
  nativeAuditAvailable: false, activationHead: null,
} as const

export function inspectF1ProposedSpec(workspace: string, value: unknown) {
  const spec = value as Record<string, any>
  requireReview(spec && spec.version === 1 && spec.mode === f1Preparation.controllerMode && spec.executionStage === 'F1', 'Separate F1 proposed controller spec required')
  requireReview(spec.realExecutionAdmitted === false && spec.runId === profileReview.runId && spec.owner === profileReview.owner && spec.generation === 1, 'F1 proposal cannot inherit an admission or another owner')
  requireReview(spec.frozenPlanManifestSha256 === f1Preparation.planSha256 && spec.argvEnvPlanSha256 === f1Preparation.environmentSha256, 'F1 proposal plan binding changed')
  const bindings = spec.f1
  requireReview(bindings && bindings.version === 1 && bindings.status === 'proposed' && bindings.activationHead === null, 'F1 activation must remain null and proposed')
  const missing: string[] = []
  const hash = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
  const commit = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v)
  const required = (name: string, v: unknown, valid: (value: any) => boolean) => {
    if (v === null || v === undefined) missing.push(name)
    else requireReview(valid(v), `Invalid proposed F1 ${name}`)
  }
  const absolute = (v: unknown) => typeof v === 'string' && /^[A-Za-z]:[\\/]/.test(v) && !/[\0\r\n"*?]/.test(v) && v.indexOf(':', 2) < 0 && !v.split(/[\\/]/).some(v => v === '.' || v === '..')
  for (const name of ['gitRoot', 'sourceRoot', 'controllerRoot', 'output', 'setupPath']) required(name, spec[name], absolute)
  if (spec.gitRoot && spec.sourceRoot && spec.controllerRoot && spec.output) {
    const inside = (root: string, file: string) => win32.normalize(file).toLowerCase().startsWith(win32.normalize(root).replace(/[\\/]$/, '').toLowerCase() + '\\')
    requireReview(!inside(spec.gitRoot, spec.controllerRoot) && win32.normalize(spec.gitRoot).toLowerCase() !== win32.normalize(spec.controllerRoot).toLowerCase()
      && inside(spec.controllerRoot, spec.output) && !inside(spec.controllerRoot, spec.sourceRoot) && win32.normalize(spec.controllerRoot).toLowerCase() !== win32.normalize(spec.sourceRoot).toLowerCase(), 'F1 private source and controller boundaries changed')
  }
  required('candidateSourceHead', bindings.candidateSourceHead, commit)
  required('stageASourceHead', bindings.stageASourceHead, commit)
  required('stageARunId', bindings.stageARunId, v => Number.isSafeInteger(v) && v > 0)
  required('stageAArtifactId', bindings.stageAArtifactId, v => Number.isSafeInteger(v) && v > 0)
  required('stageAArtifactSha256', bindings.stageAArtifactSha256, hash)
  required('fixtureBytes', bindings.fixtureBytes, v => Number.isSafeInteger(v) && v > 0)
  required('expectedBinarySha256', spec.expectedBinarySha256, hash)
  const blob = (name: string, pin: any) => {
    if (pin === null || pin === undefined) { missing.push(name); return }
    requireReview(typeof pin.file === 'string' && /^[A-Za-z]:[\\/]/.test(pin.file) && !/[\0\r\n"*?]/.test(pin.file)
      && pin.file.indexOf(':', 2) < 0 && !pin.file.split(/[\\/]/).some((v: string) => v === '.' || v === '..')
      && Number.isSafeInteger(pin.bytes) && pin.bytes > 0 && pin.bytes <= 4_294_967_296 && hash(pin.sha256), `Invalid proposed F1 ${name}`)
  }
  blob('stageAReceipt', bindings.stageAReceipt)
  blob('oldMemberReceipt', bindings.oldMemberReceipt)
  let sourceBinding = 'missing'
  if (spec.sourcePins === null || spec.sourcePins === undefined) missing.push('sourcePins')
  else {
    const names = ['windows-installer-profile-fixture.cs', 'windows-installer-profile-native.cs', 'windows-installer-profile-fixture-tests.cs']
    requireReview(Array.isArray(spec.sourcePins) && spec.sourcePins.length === names.length
      && new Set(spec.sourcePins.map((pin: any) => pin?.file)).size === names.length, 'F1 exact three reviewed sources required')
    for (const pin of spec.sourcePins) {
      requireReview(names.includes(pin?.file) && hash(pin.sha256), 'Invalid F1 source pin')
      requireReview(reviewHash(canonicalReviewBytes(ordinaryFile(join(workspace, 'scripts/pr', pin.file), 1048576))) === pin.sha256, 'F1 proposed source bytes changed')
    }
    sourceBinding = 'canonical-reviewed-bytes-matched'
  }
  const pkg = bindings.newPackage
  if (pkg === null || pkg === undefined) missing.push('newPackage')
  else {
    required('newPackage.sourceHead', pkg.sourceHead, commit)
    if (pkg.sourceHead && bindings.candidateSourceHead) requireReview(pkg.sourceHead === bindings.candidateSourceHead, 'F1 full package is from another candidate source')
    requireReview(typeof pkg.displayVersion === 'string' && pkg.displayVersion.length > 0 && pkg.displayVersion.length <= 32, 'F1 package version metadata required')
    blob('newPackage.setup', pkg.setup); blob('newPackage.buildReceipt', pkg.buildReceipt); blob('newPackage.memberReceipt', pkg.memberReceipt)
    if (pkg.setup) requireReview(pkg.setup.bytes >= 104_857_600 && pkg.setup.sha256 !== profileReview.setupSha256, 'F1 requires the actual full current package, not old or tiny setup')
    requireReview(Number.isSafeInteger(pkg.uninstallerBytes) && pkg.uninstallerBytes > 0 && hash(pkg.uninstallerSha256)
      && pkg.uninstallerSha256 !== 'b0242b31b839cc8bf40ba4ac492004629bcf8ed28f8648d8c46b1797f7befb60'
      && Number.isSafeInteger(pkg.guardedRemovalBytes) && pkg.guardedRemovalBytes > 0 && hash(pkg.guardedRemovalSha256), 'F1 current uninstaller and packaged component pins required')
    requireReview(typeof pkg.archiveLiteral === 'string' && pkg.archiveLiteral.length < 256 && !/[:*?\0\r\n]/.test(pkg.archiveLiteral)
      && !/^[\\/]/.test(pkg.archiveLiteral) && !pkg.archiveLiteral.split(/[\\/]/).some((v: string) => !v || v === '.' || v === '..'), 'F1 exact current archive literal required')
    requireReview(Array.isArray(pkg.payloads) && pkg.payloads.length >= 3 && pkg.payloads.length <= 20000
      && new Set(pkg.payloads.map((pin: any) => pin?.relativePath?.toLowerCase())).size === pkg.payloads.length, 'F1 current payload manifest required')
    for (const pin of pkg.payloads) requireReview(pin && ['app-exe', 'app-asar', 'sidecar', 'payload'].includes(pin.kind)
      && typeof pin.relativePath === 'string' && pin.relativePath.length < 512 && !/^[\\/]|[:*?\0\r\n]/.test(pin.relativePath)
      && !pin.relativePath.split(/[\\/]/).some((v: string) => !v || v === '.' || v === '..')
      && Number.isSafeInteger(pin.bytes) && pin.bytes > 0 && hash(pin.sha256), 'Invalid F1 relative payload pin')
    requireReview(pkg.payloads.filter((pin: any) => pin.kind === 'app-asar' && pin.relativePath === 'resources\\app.asar').length === 1
      && pkg.payloads.filter((pin: any) => pin.kind === 'app-exe' && pin.relativePath === 'Claude Code Haha.exe').length === 1
      && pkg.payloads.some((pin: any) => pin.kind === 'sidecar'), 'F1 exact app, asar and sidecar identities required')
  }
  return { version: 1, status: 'not_proven', preparation: missing.length ? 'incomplete' : 'metadata-bound-only', sourceBinding,
    missing, nativeAuditAvailable: false, nativeExecutionAdmitted: false, activationHead: null, claim: null, command: null,
    fullF1: 'not_proven', compatibilityEnabled: false, oldExit22Policy: 'fatal' } as const
}

async function main() {
  if (process.argv[2]?.startsWith('--functional-upgrade-')) return functionalUpgradeMain()
  if (process.argv[2] === '--f1-proposed-check') {
    requireReview(process.argv.length === 4, 'F1 proposed check accepts only its JSON file; no execution arguments')
    const value = JSON.parse(ordinaryFile(process.argv[3], 4194304).toString('utf8'))
    console.log(JSON.stringify(inspectF1ProposedSpec(process.cwd(), value)))
    process.exitCode = 2 // Valid proposal is still not native evidence or admission.
    return
  }
  requireReview(!process.argv[2]?.startsWith('--f1-'), 'F1 claim and execution modes are not admitted')
  if (process.argv[2] === '--profile-only-bootstrap-preflight') return profileOnlyBootstrapPreflight()
  if (process.argv[2]?.startsWith('--profile-only-')) return profileOnlyMain()
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

export type ProfileOnlyClaim = ReviewInvocation & {
  version: 1
  status: 'first_matching_run_claimed'
  repository: string
  runAttempt: 1
  workflowId: number
  displayTitle: string
  minimumMatchingRunNumber: number
  minimumMatchingRunId: number
  completePagination: true
  claimantSourceSha256: string
}

export async function claimProfileOnlyReview(invocation: ReviewInvocation, get: GitHubRead, claimantSourceSha256: string): Promise<ProfileOnlyClaim> {
  requireReview(/^[0-9a-f]{64}$/.test(claimantSourceSha256), 'Exact claimant source required')
  const current = await get(`/actions/runs/${invocation.runId}`) as ReviewRun
  const title = profileOnlyReview.runNamePrefix + invocation.head
  requireReview(current?.workflow_id === profileOnlyReview.workflowId && current.id === invocation.runId && current.run_number === invocation.runNumber && current.run_attempt === 1 && current.head_sha === invocation.head && current.event === 'pull_request' && current.display_title === title && current.actor?.login === profileReview.actor, 'Current profile-only run does not match admission')
  const rows: ReviewRun[] = []
  let total: number | undefined
  for (let page = 1; ; page++) {
    const history = await get(`/actions/workflows/${profileOnlyReview.workflowId}/runs?head_sha=${invocation.head}&event=pull_request&per_page=100&page=${page}`) as { total_count: number; workflow_runs: ReviewRun[] }
    // The filtered Actions endpoint exposes at most 1000 rows. Never call that
    // truncated result complete, nor accept a changing total between pages.
    requireReview(Number.isSafeInteger(history?.total_count) && history.total_count > 0 && history.total_count <= 1000 && Array.isArray(history.workflow_runs) && (total === undefined || total === history.total_count), 'Incomplete or changing profile-only workflow history')
    total = history.total_count
    requireReview(history.workflow_runs.length === Math.min(100, total - rows.length), 'Incomplete profile-only history page')
    rows.push(...history.workflow_runs)
    if (rows.length === total) break
  }
  const ids = new Set<number>()
  const numbers = new Set<number>()
  for (const run of rows) {
    requireReview(run && Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.run_number) && run.run_number > 0 && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0 && run.workflow_id === current.workflow_id && run.head_sha === invocation.head && run.event === 'pull_request' && typeof run.display_title === 'string' && run.display_title.length > 0 && typeof run.actor?.login === 'string' && run.actor.login.length > 0, 'Unassociated profile-only history row')
    requireReview(!ids.has(run.id) && !numbers.has(run.run_number), 'Duplicate profile-only history identity')
    ids.add(run.id)
    numbers.add(run.run_number)
    if (run.id === current.id) requireReview(JSON.stringify(runIdentity(run)) === JSON.stringify(runIdentity(current)), 'Current profile-only history row changed')
  }
  const matching = rows.filter(run => run.display_title === title)
  requireReview(matching.some(run => run.id === current.id) && matching.every(run => run.actor.login === profileReview.actor && run.run_number >= current.run_number), 'Profile-only head already consumed or current run absent; no retry')
  const pin = profileOnlyReview.artifact
  const artifact = await get(`/actions/artifacts/${pin.id}`) as { id: number; name: string; size_in_bytes: number; digest: string; expired: boolean; workflow_run?: { id: number; head_sha: string } }
  requireReview(artifact?.id === pin.id && artifact.name === pin.name && artifact.size_in_bytes === pin.size && artifact.digest === pin.digest && artifact.expired === false && artifact.workflow_run?.id === profileOnlyReview.sourceRun && artifact.workflow_run.head_sha === profileOnlyReview.sourceHead, 'Successful profile-only A artifact is missing, expired or changed')
  return { version: 1, status: 'first_matching_run_claimed', repository: profileReview.repository, ...invocation, runAttempt: 1, workflowId: current.workflow_id, displayTitle: title, minimumMatchingRunNumber: current.run_number, minimumMatchingRunId: current.id, completePagination: true, claimantSourceSha256 }
}

function runIdentity(run: ReviewRun) {
  return [run.id, run.workflow_id, run.run_number, run.run_attempt, run.head_sha, run.event, run.display_title, run.actor.login]
}

export function validateProfileOnlyClaim(claim: ProfileOnlyClaim, invocation: ReviewInvocation, claimantSourceSha256: string) {
  requireReview(claim?.version === 1 && claim.status === 'first_matching_run_claimed' && claim.repository === profileReview.repository && claim.head === invocation.head && claim.runId === invocation.runId && claim.runNumber === invocation.runNumber && claim.runAttempt === 1 && claim.workflowId === profileOnlyReview.workflowId && claim.displayTitle === profileOnlyReview.runNamePrefix + invocation.head && claim.minimumMatchingRunNumber === invocation.runNumber && claim.minimumMatchingRunId === invocation.runId && claim.completePagination === true && claim.claimantSourceSha256 === claimantSourceSha256, 'Complete profile-only claim missing or changed')
}

export function profileOnlyPaths(head: string) {
  requireReview(/^[0-9a-f]{40}$/.test(head) && head !== profileReview.admittedHead, 'New exact activation head required')
  const stageBase = `D:\\a\\_temp\\cc-haha-1879-p-${head}-52f4ce19-g1`
  const privateBootstrapRoot = stageBase + '-bootstrap'
  return { stageBase, privateBootstrapRoot, stageAInputDirectory: stageBase + '-A', claimFile: win32.join(privateBootstrapRoot, 'claim.json'), packageDirectory: win32.join(privateBootstrapRoot, 'packet') }
}

const profileOnlyTemplateNames = ['launch-profile-only.proposed.ps1', 'reconcile-profile-only.proposed.ps1', 'argv-env-plan.json'] as const
function sourceHash(workspace: string, path: string, maximumBytes = 262144) {
  return reviewHash(canonicalReviewBytes(ordinaryFile(join(workspace, path), maximumBytes)))
}
function jsonBytes(value: unknown) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`) }

// Pure packet production is shared by contract tests and the Actions prepare
// step. Only the separately applied exact-head coordinator label is admission.
// Checked-in JSON stays unadmitted; previewing/preparing source grants nothing.
export function prepareProfileOnlyPacket(workspace: string, invocation: ReviewInvocation, claim: ProfileOnlyClaim) {
  const claimantSourceSha256 = sourceHash(workspace, 'scripts/pr/windows-installer-profile-review.ts')
  validateProfileOnlyClaim(claim, invocation, claimantSourceSha256)
  const root = join(workspace, 'scripts/pr/windows-installer-profile-only/fixtures')
  const read = (name: string) => JSON.parse(canonicalReviewBytes(ordinaryFile(join(root, name), 65536)).toString('utf8'))
  const pins = read('pins.proposed.json')
  const spec = read('profile-only-spec.proposed.json')
  const admission = read('root-admission.proposed.json')
  requireReview(pins.status === 'DRAFT_NOT_READY' && pins.admissionStatus === 'not_admitted' && pins.activationHead === null && spec.realExecutionAdmitted === false && admission.status === 'not_admitted', 'Only unadmitted profile-only templates accepted')
  requireReview(pins.candidateSourceCommit === profileOnlyReview.sourceHead && pins.binarySha256 === profileOnlyReview.binarySha256 && pins.binaryBytes === profileOnlyReview.binaryBytes && spec.expectedBinarySha256 === pins.binarySha256 && pins.stageA.head === profileOnlyReview.sourceHead && pins.stageA.runId === profileOnlyReview.sourceRun && pins.stageA.artifactId === profileOnlyReview.artifact.id, 'Profile-only template A binding changed')
  const paths = profileOnlyPaths(invocation.head)
  const files: { name: string; bytes: Buffer }[] = profileOnlyTemplateNames.map(name => ({ name, bytes: canonicalReviewBytes(ordinaryFile(join(root, name), 65536)) }))
  const hash = (name: string) => reviewHash(files.find(file => file.name === name)!.bytes)
  Object.assign(spec, { realExecutionAdmitted: true, sourceRoot: win32.join(paths.stageBase, 'input'), controllerRoot: win32.join(paths.stageBase, 'controller'), output: win32.join(paths.stageBase, 'controller/profile-only-report.json') })
  const specBytes = jsonBytes(spec)
  Object.assign(pins, paths, { status: 'FROZEN_PROFILE_ONLY_INPUTS', admissionStatus: 'external_root_grant_required', activationHead: invocation.head, specSha256: reviewHash(specBytes), launcherSha256: hash(profileOnlyTemplateNames[0]), reconcileSha256: hash(profileOnlyTemplateNames[1]), workflow: { path: profileOnlyReview.workflowPath, sha256: sourceHash(workspace, profileOnlyReview.workflowPath), workflowId: profileOnlyReview.workflowId, claimantSourceSha256 } })
  const pinsBytes = jsonBytes(pins)
  Object.assign(admission, { status: 'admitted_profile_only_once', scope: 'Exact-head coordinator label, first matching invocation only; profile-only diagnostic, no F1 admission', activationHead: invocation.head, pinsSha256: reviewHash(pinsBytes), specSha256: pins.specSha256, launcherSha256: pins.launcherSha256, reconcileSha256: pins.reconcileSha256, newTriggerLabel: profileOnlyReview.labelPrefix + invocation.head, allowedWorkflowId: profileOnlyReview.workflowId, stageBase: paths.stageBase, privateBootstrapRoot: paths.privateBootstrapRoot, rootReportReference: `https://github.com/${profileReview.repository}/actions/runs/${invocation.runId}`, runAuthorization: 'first_exact_head_once_no_rerun', claimantSourceSha256 })
  files.push({ name: 'profile-only-spec.proposed.json', bytes: specBytes }, { name: 'pins.proposed.json', bytes: pinsBytes }, { name: 'root-admission.proposed.json', bytes: jsonBytes(admission) })
  return { invocation, paths, claim, pins, spec, admission, files, hashes: { pins: reviewHash(pinsBytes), spec: pins.specSha256 as string, admission: reviewHash(jsonBytes(admission)) } }
}

export function validateProfileOnlyAInputs(workspace: string, stageA: string, pins: ReturnType<typeof prepareProfileOnlyPacket>['pins']) {
  requireReview(pins.sourcePins.length === 3, 'Exactly three reviewed A sources required')
  for (const pin of pins.sourcePins) {
    requireReview(profileReview.sources.some(source => source.file === pin.file), 'Unexpected A source')
    const raw = ordinaryFile(join(stageA, pin.file), 262144)
    requireReview(raw.length === pin.bytes && reviewHash(raw) === pin.sha256 && sourceHash(workspace, `scripts/pr/${pin.file}`) === pin.canonicalSha256, 'Current source or original raw A source changed')
  }
  const binary = ordinaryFile(join(stageA, 'profile-fixture.exe'), profileOnlyReview.binaryBytes)
  requireReview(binary.length === profileOnlyReview.binaryBytes && reviewHash(binary) === profileOnlyReview.binarySha256, 'Profile-only original PE changed; rebuilding forbidden')
  for (const [name, hash] of Object.entries({ 'checks.json': pins.stageA.checksSha256, 'self-test.raw.json': pins.stageA.selfTestSha256, 'abi-harness.raw.json': pins.stageA.abiHarnessSha256, 'profile-only-preflight.raw.json': pins.stageA.preflightSha256 })) {
    requireReview(reviewHash(ordinaryFile(join(stageA, name), 1048576)) === hash, 'Profile-only A report changed')
  }
}

export function collectProfileOnlyEvidence(packet: ReturnType<typeof prepareProfileOnlyPacket>, destination: string, launcherOutcome: string) {
  mkdirSync(destination, { recursive: true })
  const names = ['bootstrap-receipt.json', 'launch-receipt.json', 'controller.stdout.raw.log', 'controller.stderr.raw.log', 'reconcile-receipt.json', 'controller/profile-only-report.json', 'controller/ledger.json']
  const files: { name: string; bytes: number; sha256: string }[] = []
  const errors: string[] = []
  for (const name of names) {
    const path = join(name === 'bootstrap-receipt.json' ? packet.paths.privateBootstrapRoot : packet.paths.stageBase, name)
    if (!existsSync(path)) continue
    try {
      const bytes = ordinaryFile(path, 1048576)
      const target = join(destination, name)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes, { flag: 'wx' })
      files.push({ name, bytes: bytes.length, sha256: reviewHash(bytes) })
    } catch { errors.push(`Profile-only evidence unavailable or unsafe: ${name}`) }
  }
  if (launcherOutcome === 'success') {
    for (const name of names.filter(name => name !== 'reconcile-receipt.json')) if (!files.some(file => file.name === name)) errors.push(`Successful profile-only evidence missing: ${name}`)
    if (errors.length === 0) {
      try {
        const json = (name: string) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(ordinaryFile(join(destination, name), 1048576)))
        const launch = json('launch-receipt.json')
        const bootstrap = json('bootstrap-receipt.json')
        const native = json('controller/profile-only-report.json')
        const ledger = json('controller/ledger.json')
        const bound = (value: Record<string, unknown>) => value.runId === profileReview.runId && value.owner === profileReview.owner && value.generation === 1 && value.specSha256 === packet.hashes.spec
        requireReview(bound(launch) && bound(ledger), 'Profile-only ownership binding changed')
        requireReview(bootstrap.version === 1 && bootstrap.status === 'prepared_no_native_execution' && bootstrap.activationHead === packet.invocation.head && String(bootstrap.actionsRunId) === String(packet.invocation.runId) && bootstrap.runnerSid === launch.runnerSid && bootstrap.claimSha256 === reviewHash(jsonBytes(packet.claim)) && bootstrap.accountApi === 'not_run' && bootstrap.nativeExecution === 'not_run' && Array.isArray(bootstrap.roots) && bootstrap.roots.length === 3 && [packet.paths.privateBootstrapRoot, packet.paths.packageDirectory, packet.paths.stageAInputDirectory].every(path => bootstrap.roots.filter((root: { path: string; fileIdentity: string }) => root.path === path && /^[0-9a-f]{8}:[0-9a-f]{16}$/.test(root.fileIdentity)).length === 1), 'Profile-only atomic bootstrap evidence missing')
        requireReview(typeof launch.runnerSid === 'string' && /^S-1-5-(?:[0-9]+-)*[0-9]+$/.test(launch.runnerSid) && Number.isSafeInteger(launch.controllerPid) && launch.controllerPid > 4 && typeof launch.controllerBirthUtc === 'string' && launch.controllerBirthUtc.endsWith('Z') && Number.isFinite(Date.parse(launch.controllerBirthUtc)) && launch.stdoutComplete === true && launch.stderrComplete === true && launch.rawLogOverflow === false && launch.binarySha256 === profileOnlyReview.binarySha256 && launch.binaryBytes === profileOnlyReview.binaryBytes, 'Profile-only held-process receipt missing')
        requireReview(launch.status === 'native_profile_only_passed_and_cleaned_no_F1_claim' && launch.activationHead === packet.invocation.head && String(launch.actionsRunId) === String(packet.invocation.runId) && launch.pinsSha256 === packet.hashes.pins && launch.rootAdmissionSha256 === packet.hashes.admission && launch.stageBase === packet.paths.stageBase && launch.claimFile === packet.paths.claimFile && launch.claimSha256 === reviewHash(jsonBytes(packet.claim)) && launch.nativeExitCode === 0 && launch.nativeCleanup === 'cleaned' && launch.controllerStartAttempted === true && launch.controllerStarted === true && launch.controllerIdentityVerified === true, 'Profile-only launch binding changed')
        requireReview(native.version === 1 && native.mode === 'profile-only' && native.status === 'passed' && native.cleanup === 'cleaned' && native.binarySha256 === profileOnlyReview.binarySha256 && native.specSha256 === packet.hashes.spec && native.realAccountsCreated === 1 && native.realProfilesCreated === 1 && Array.isArray(native.checks) && native.checks.length > 0 && native.checks.every((check: { status: string }) => check.status === 'passed'), 'Profile-only native terminal binding changed')
        requireReview(files.find(file => file.name === 'controller/profile-only-report.json')!.sha256 === launch.terminalReportSha256, 'Profile-only terminal report hash changed')
        const marker = /^CcHaha1879:52f4ce19-5ded-4b27-8268-a2840809e0ca:([0-9a-f]{32})$/.exec(ledger.marker)
        requireReview(ledger.version === 1 && ledger.accountBound === true && ledger.accountCreated === true && ledger.account?.sid !== launch.runnerSid && /^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+$/.test(ledger.account?.sid ?? '') && marker && ledger.account.marker === ledger.marker && ledger.intentSam === `c1879_${marker[1].slice(0, 12)}` && ledger.account.sam === ledger.intentSam, 'Profile-only fresh owned ledger changed')
        for (const value of [launch, native]) {
          requireReview(value.releasedPeExecuted === false && value.releasedPeMayHaveExecuted === false && value.releasedPeExecutionStatus === 'not_run' && value.compatibilityEnabled === false && value.oldExit22Policy === 'fatal', 'Profile-only effect scope changed')
          for (const key of ['member_proven', 'installed_bytes_equal', 'old22_before_protected_mutation', 'removal_equivalence', 'full_old_to_new']) requireReview(value[key] === 'not_run', 'Profile-only F1 overclaim')
        }
      } catch { errors.push('Profile-only terminal binding failed; preserve originals, cleanup remains unknown') }
    }
  }
  const report = { kind: 'profile-only-evidence-collection', launcherOutcome, activationHead: packet.invocation.head, stageASourceHead: profileOnlyReview.sourceHead, files, errors, compatibilityEnabled: false, oldExit22Policy: 'fatal', fullF1: 'not_proven', retryAllowed: false }
  writeFileSync(join(destination, 'collection.json'), jsonBytes(report), { flag: 'wx' })
  requireReview(errors.length === 0, 'Profile-only evidence collection failed')
  return report
}

async function profileOnlyMain() {
  const mode = process.argv[2]
  requireReview(process.argv.length === 3 && ['--profile-only-claim', '--profile-only-prepare', '--profile-only-collect'].includes(mode), 'Explicit profile-only claim/prepare/collect required')
  const paths = runnerPaths()
  requireReview(process.env.GITHUB_EVENT_PATH, 'Actions event required')
  const invocation = validateReviewInvocation(JSON.parse(ordinaryFile(process.env.GITHUB_EVENT_PATH, 1048576).toString('utf8')), process.env, 'profile-only')
  requireReview(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: paths.workspace, encoding: 'utf8' }).trim() === invocation.head, 'Profile-only exact-head checkout required')
  const receipt = join(paths.temporary, `cc-haha-1879-p-claim-transfer-${invocation.runId}.json`)
  const claimantHash = sourceHash(paths.workspace, 'scripts/pr/windows-installer-profile-review.ts')
  if (mode === '--profile-only-claim') {
    requireReview(process.env.PROFILE_REVIEW_TOKEN, 'Read-only Actions token missing')
    const get: GitHubRead = async path => {
      const response = await fetch(`https://api.github.com/repos/${profileReview.repository}${path}`, { headers: { Authorization: `Bearer ${process.env.PROFILE_REVIEW_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } })
      requireReview(response.ok, `GitHub read failed (${response.status})`)
      return response.json()
    }
    const claim = await claimProfileOnlyReview(invocation, get, claimantHash)
    writeFileSync(receipt, jsonBytes(claim), { flag: 'wx' })
    return
  }
  const claim = JSON.parse(ordinaryFile(receipt, 65536).toString('utf8')) as ProfileOnlyClaim
  const packet = prepareProfileOnlyPacket(paths.workspace, invocation, claim)
  const evidence = join(paths.workspace, 'artifacts/windows-installer-profile-only')
  if (mode === '--profile-only-collect') {
    collectProfileOnlyEvidence(packet, evidence, process.env.PROFILE_LAUNCHER_OUTCOME ?? 'unknown')
    return
  }
  const stageA = join(paths.temporary, 'cc-haha-1879-profile-only-download/profile-stage-a')
  validateProfileOnlyAInputs(paths.workspace, stageA, packet.pins)
  const plan = { version: 1, invocation, claim, claimBase64: jsonBytes(claim).toString('base64'), paths: packet.paths, hashes: packet.hashes, stageA, files: packet.files.map(file => ({ name: file.name, base64: file.bytes.toString('base64'), sha256: reviewHash(file.bytes) })), aInputs: [{ file: 'profile-fixture.exe', bytes: profileOnlyReview.binaryBytes, sha256: profileOnlyReview.binarySha256 }, ...packet.pins.sourcePins, ...Object.entries({ 'checks.json': packet.pins.stageA.checksSha256, 'self-test.raw.json': packet.pins.stageA.selfTestSha256, 'abi-harness.raw.json': packet.pins.stageA.abiHarnessSha256, 'profile-only-preflight.raw.json': packet.pins.stageA.preflightSha256 }).map(([file, sha256]) => ({ file, sha256, bytes: ordinaryFile(join(stageA, file), 1048576).length }))] }
  const planPath = join(paths.temporary, `cc-haha-1879-p-prepare-${invocation.runId}.json`)
  const planBytes = jsonBytes(plan)
  writeFileSync(planPath, planBytes, { flag: 'wx' })
  mkdirSync(evidence, { recursive: true })
  for (const [name, value] of Object.entries({ 'activation.json': { ...invocation, sourceHead: profileOnlyReview.sourceHead, sourceRun: profileOnlyReview.sourceRun, compatibilityEnabled: false, oldExit22Policy: 'fatal', fullF1: 'not_proven' }, 'pins.json': packet.pins, 'spec.json': packet.spec, 'root-admission.json': packet.admission, 'claim.json': claim })) writeFileSync(join(evidence, name), jsonBytes(value), { flag: 'wx' })
  const bootstrap = join(paths.workspace, 'scripts/pr/windows-installer-profile-only/bootstrap.ps1')
  execFileSync(profileOnlyPowerShell51, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bootstrap, '-PrepareReviewedProfileOnly', '-PlanPath', planPath, '-ApprovedPlanSha256', reviewHash(planBytes)], { stdio: 'inherit', timeout: 120000, env: profileOnlyBootstrapEnvironment(process.env) })
  output('package_dir', packet.paths.packageDirectory)
  output('stage_a_dir', packet.paths.stageAInputDirectory)
  output('claim_file', packet.paths.claimFile)
  output('pins_sha256', packet.hashes.pins)
  output('spec_sha256', packet.hashes.spec)
  output('admission_sha256', packet.hashes.admission)
}

export const profileOnlyPowerShell51 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

export function profileOnlyBootstrapEnvironment(env: Record<string, string | undefined>) {
  const child: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() !== 'PSMODULEPATH') child[key] = value
  }
  child.PSModulePath = win32.join(win32.dirname(profileOnlyPowerShell51), 'Modules')
  return child
}

// Ordinary zero-account fixture: use the same Core -> Bun -> fixed 5.1 child
// boundary as preparation. No Actions claim or profile role is manufactured.
function profileOnlyBootstrapPreflight() {
  requireReview(process.argv.length === 3, 'Bootstrap preflight accepts no role or live arguments')
  const paths = runnerPaths()
  requireReview(process.env.CC1879_PREFLIGHT_PARENT_PSHOME === 'C:\\Program Files\\PowerShell\\7', 'Real parent PowerShell Core 7 required')
  const evidence = join(paths.workspace, 'artifacts/windows-installer')
  mkdirSync(evidence, { recursive: true })
  const fixture = join(paths.workspace, 'scripts/pr/windows-installer-profile-only/bootstrap.test.ps1')
  const invoke = (name: string, extra: string[], parent: Record<string, string | undefined>) => {
    const childEnv = profileOnlyBootstrapEnvironment(parent)
    const result = spawnSync(profileOnlyPowerShell51, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture, ...extra], { env: childEnv, timeout: 120000, maxBuffer: 1048576 })
    writeFileSync(join(evidence, `profile-only-bootstrap-${name}.stdout.raw.log`), result.stdout ?? Buffer.alloc(0), { flag: 'wx' })
    writeFileSync(join(evidence, `profile-only-bootstrap-${name}.stderr.raw.log`), result.stderr ?? Buffer.alloc(0), { flag: 'wx' })
    requireReview(!result.error && result.status === 0 && result.signal === null, 'Fixed WindowsPS5.1 bootstrap fixture failed')
    return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout)
  }
  const cases = []
  for (const mode of ['missing', 'polluted']) {
    const parent = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'))
    if (mode === 'polluted') parent.PSModulePath = 'Z:\\cc1879-fixture-core-only-missing-modules'
    const text = invoke(mode, ['-StartupProbeOnly'], parent)
    const prefix = 'CC1879_PROBE_JSON='
    const row = text.split(/\r?\n/).find(line => line.startsWith(prefix))
    requireReview(row, 'WindowsPS5.1 startup diagnostic is missing')
    const probe = JSON.parse(row.slice(prefix.length))
    requireReview(probe.status === 'passed' && typeof probe.psHome === 'string' && probe.psHome.toLowerCase() === win32.dirname(profileOnlyPowerShell51).toLowerCase() && probe.engine === 'WindowsPowerShell5.1-Desktop' && probe.commands.length === 8 && probe.safeModulePaths.length === 1 && probe.safeModulePaths[0].toLowerCase() === win32.join(win32.dirname(profileOnlyPowerShell51), 'Modules').toLowerCase(), 'Wrong startup engine or command-source evidence')
    cases.push({ parentModulePath: mode, probe })
  }
  writeFileSync(join(evidence, 'profile-only-bootstrap-startup.raw.json'), jsonBytes({ version: 1, status: 'passed', parentPSHome: process.env.CC1879_PREFLIGHT_PARENT_PSHOME, cases, realAccountsCreated: 0, realProfilesCreated: 0, nativeProfileExecution: 'not_run' }), { flag: 'wx' })
  invoke('producer', ['-OutputPath', join(evidence, 'profile-only-bootstrap.raw.json')], process.env)
  // The ordinary Windows job already calls this zero-account entry. Exercise
  // the new scripts with the same real fixed 5.1 boundary before any live grant.
  const functionalCases: Array<{ script: string; operation: string; status: string }> = []
  for (const [name, deniedSwitch, denial] of [['bootstrap.ps1', '-PrepareFunctionalUpgrade', 'exact_preparation_hash_required'], ['launch.ps1', '-ExecuteFunctionalUpgrade', 'external_reviewed_packet_hashes_required']]) {
    const script = join(paths.workspace, 'scripts/pr/windows-installer-functional-upgrade', name)
    for (const operation of ['default', 'pending']) {
      const result = spawnSync(profileOnlyPowerShell51, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...(operation === 'pending' ? [deniedSwitch] : [])], { env: profileOnlyBootstrapEnvironment(process.env), timeout: 30000, maxBuffer: 1048576 })
      writeFileSync(join(evidence, `functional-${name}-${operation}.stdout.raw.log`), result.stdout ?? Buffer.alloc(0), { flag: 'wx' })
      writeFileSync(join(evidence, `functional-${name}-${operation}.stderr.raw.log`), result.stderr ?? Buffer.alloc(0), { flag: 'wx' })
      requireReview(!result.error && result.signal === null, 'Functional default-denial preflight did not terminate')
      if (operation === 'default') {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.stdout))
        requireReview(result.status === 0 && value.status === 'not_run' && value.accountApi === 'not_run' && value.nativeExecution === 'not_run', 'Functional default must have no native/account effect')
      } else requireReview(result.status !== 0 && new TextDecoder('utf-8', { fatal: true }).decode(result.stderr).includes(denial), 'Functional missing authorization must deny before native APIs')
      functionalCases.push({ script: name, operation, status: 'passed' })
    }
  }
  const lockFixture = spawnSync(profileOnlyPowerShell51, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(paths.workspace, 'scripts/pr/windows-installer-functional-upgrade/launch.test.ps1')], { env: profileOnlyBootstrapEnvironment(process.env), timeout: 30000, maxBuffer: 1048576 })
  writeFileSync(join(evidence, 'functional-actual-import-lock.stdout.raw.log'), lockFixture.stdout ?? Buffer.alloc(0), { flag: 'wx' })
  writeFileSync(join(evidence, 'functional-actual-import-lock.stderr.raw.log'), lockFixture.stderr ?? Buffer.alloc(0), { flag: 'wx' })
  requireReview(!lockFixture.error && lockFixture.status === 0 && lockFixture.signal === null, 'Actual functional import/Lock fixture failed')
  const lock = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(lockFixture.stdout))
  requireReview(lock.version === 1 && lock.status === 'passed' && lock.actualSelectedDeclarations === true && lock.correctHashRetained === true && lock.wrongHashRejected === true && lock.streamsClosed === true && lock.missingDependency === null && lock.realAccountsCreated === 0 && lock.realProfilesCreated === 0 && lock.nativeExecution === 'not_run', 'Actual selected Lock body did not retain/reject/close owned streams')
  functionalCases.push({ script: 'launch.test.ps1', operation: 'actual-import-lock', status: 'passed' })
  writeFileSync(join(evidence, 'functional-entry-preflight.raw.json'), jsonBytes({ version: 1, status: 'passed', engine: 'WindowsPowerShell5.1-Desktop', checks: functionalCases, realAccountsCreated: 0, realProfilesCreated: 0, nativeExecution: 'not_run' }), { flag: 'wx' })
}

// This separately named functional regression is not the exhaustive F1 audit.
// A checked-in proposal is never admission. Only the reviewed structured input
// of the first exact-head manual invocation can produce an executable packet.
export const functionalUpgrade = {
  workflowId: 327327938,
  workflowPath: '.github/workflows/nightly-quality.yml',
  executionRef: 'refs/heads/fix/issue-1879-functional-validation',
  runNamePrefix: 'functional1879-u:',
  runId: 'a2c7e590-96df-40b1-8943-8e4bcf07a6d2',
  owner: profileReview.owner,
  planSha256: '37d4f8d484a7797e9eaa6d89c05d4f53716cf6ec350936126f5bb6e665f6ef53',
  environmentSha256: '4b2e46bfde62ddb189734e42c4fb258ddab687878b7f9ff8393ddf70d8770252',
  oldFixtureRun: 43581658402,
  oldFixtureArtifact: { id: 14109065646, name: 'windows-installer-v078-fixture', size: 230729090, digest: 'sha256:f4865a57fb8b0437dc2ba9a1dc23bdda089f99b7fb699643fc14448800daaf85' },
} as const

const functionalDirectory = 'scripts/pr/windows-installer-functional-upgrade'
const functionalSourceNames = profileReview.sources.map(source => source.file)
const functionalReportNames = ['checks.json', 'self-test.raw.json', 'abi-harness.raw.json', 'profile-only-preflight.raw.json']
const f1FactNames = ['member_proven', 'installed_bytes_equal', 'old22_before_protected_mutation', 'removal_equivalence', 'full_old_to_new']
const functionalBooleanFacts = ['oldInstalledUninstallerExact', 'currentPayloadExact', 'currentRegistrationExact', 'shortcutTargetsExact', 'fakeUserDataUnchanged', 'legacyOnlyCanaryAbsent', 'normalRemovalReferencePassed', 'rebuiltOldEquivalent', 'helperIdentityVerified', 'helperAlive', 'helperUsable', 'ownedCleanupKnown']
const functionalSnapshots = ['negative-before.json', 'negative-after.json', 'positive-kept-before.json', 'positive-kept-after.json', 'functional-rebuilt-old.json', 'functional-upgrade-kept-before.json', 'functional-upgrade-kept-after.json']
type FunctionalBlob = { file: string; bytes: number; sha256: string }
type FunctionalArtifact = { id: number; name: string; size: number; digest: string }
export type FunctionalStageA = {
  sourceHead: string; runId: number; jobId: number; artifact: FunctionalArtifact
  fixtureSha256: string; fixtureBytes: number; sourceSetSha256: string
  sources: Array<FunctionalBlob & { canonicalSha256: string }>
  reports: FunctionalBlob[]
  oldMemberProof: FunctionalBlob
}
export type FunctionalOncePacket = Record<string, any> & {
  version: 1; kind: 'isolated-functional-upgrade-once'; status: 'root_admitted_once'
  activationHead: string; candidateSourceHead: string; candidateTree: string; mainHead: string
  sourceSetSha256: string; fixtureSha256: string; fixtureBytes: number; stageA: FunctionalStageA
}
type FunctionalClaim = ProfileOnlyClaim & { rootPacketSha256: string }
const shaValue = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const headValue = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
const positiveSafe = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const functionalFileTime = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n

export function functionalPackageTrackedDiffSha256(paths: string[]) {
  const files = new Set(['scripts/pr/windows-installer-profile-fixture.cs', 'scripts/pr/windows-installer-profile-native.cs', 'scripts/pr/windows-installer-profile-fixture-tests.cs', 'scripts/pr/windows-installer-profile-review.ts', 'scripts/pr/windows-installer-profile-review.test.ts', '.github/workflows/nightly-quality.yml'])
  requireReview(Array.isArray(paths) && paths.length <= 128 && new Set(paths).size === paths.length && paths.every(path => typeof path === 'string' && (files.has(path) || /^scripts\/pr\/windows-installer-functional-upgrade\/[A-Za-z0-9._-]+$/.test(path))), 'Prepared package reuse rejects changes outside the fixed regression-entry whitelist')
  return reviewHash(paths.toSorted().map(path => path + '\0').join(''))
}

function functionalJson(workspace: string, name: string) {
  return JSON.parse(canonicalReviewBytes(ordinaryFile(join(workspace, functionalDirectory, name), 65536)).toString('utf8'))
}

export function decodeFunctionalOncePacket(encoded: string, expectedSha256: string): FunctionalOncePacket {
  // Canonical bytes make duplicate keys, alternate encodings and hidden JSON
  // lexemes fail before any staging or API call. Inputs are data, never a shell.
  requireReview(typeof encoded === 'string' && encoded.length > 0 && encoded.length <= 30000 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded) && shaValue(expectedSha256), 'Bounded exact functional packet required')
  const bytes = Buffer.from(encoded, 'base64')
  requireReview(bytes.length <= 22500 && bytes.toString('base64') === encoded && reviewHash(bytes) === expectedSha256, 'Functional packet bytes changed')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const packet = JSON.parse(text)
  requireReview(packet && typeof packet === 'object' && !Array.isArray(packet) && bytes.equals(jsonBytes(packet)), 'Canonical functional packet JSON required')
  return packet
}

export function validateFunctionalOncePacket(packet: FunctionalOncePacket, workspace: string) {
  requireReview(packet?.version === 1 && packet.kind === 'isolated-functional-upgrade-once' && packet.status === 'root_admitted_once' && packet.scope === 'isolated-v078-first-upgrade', 'New functional once admission required')
  requireReview(packet.repository === profileReview.repository && packet.pullRequest === 1883 && packet.actor === profileReview.actor && packet.workflowId === functionalUpgrade.workflowId && packet.workflowPath === functionalUpgrade.workflowPath && packet.executionRef === functionalUpgrade.executionRef && packet.runAttempt === 1, 'Functional workflow/actor scope changed')
  requireReview(headValue(packet.activationHead) && packet.activationHead === packet.candidateSourceHead && headValue(packet.candidateTree) && headValue(packet.mainHead) && packet.activationHead !== profileReview.admittedHead, 'New exact functional source identity required')
  requireReview(packet.runId === functionalUpgrade.runId && packet.owner === functionalUpgrade.owner && packet.generation === 1 && packet.priorBProfileOrF1AuthorityInherited === false && packet.modeSpecificHumanApproval === false, 'Functional identity or authority provenance changed')
  requireReview(packet.actionsRunId === null && packet.actionsRunNumber === null && packet.claimSha256 === null && packet.claimantSourceSha256 === null && packet.completeFirstInvocation === false, 'A root input cannot manufacture its future Actions claim')
  requireReview(typeof packet.rootGrantReference === 'string' && /^R\/issue-1879-[a-z0-9-]{1,140}\.json$/.test(packet.rootGrantReference) && typeof packet.rootDecisionUtc === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(packet.rootDecisionUtc) && Number.isFinite(Date.parse(packet.rootDecisionUtc)), 'Reviewed root once decision required')
  const proposed = functionalJson(workspace, 'authorization.proposed.json')
  for (const key of ['humanAuthorizationSources', 'engineeringReview', 'budgets']) requireReview(JSON.stringify(packet[key]) === JSON.stringify(proposed[key]), 'Functional standing authorization or finite budget changed')
  requireReview(packet.planSha256 === functionalUpgrade.planSha256 && packet.environmentSha256 === functionalUpgrade.environmentSha256 && sourceHash(workspace, `${functionalDirectory}/plan.json`) === functionalUpgrade.planSha256 && sourceHash(workspace, `${functionalDirectory}/argv-env-plan.json`) === functionalUpgrade.environmentSha256, 'Functional plan/environment changed')
  const manifest = functionalJson(workspace, 'prepared-package.json')
  for (const [prefix, key] of [['preparedPackageReceipt', 'packageReceipt'], ['newMemberProof', 'memberProof'], ['newUninstaller', 'uninstaller'], ['guardedRemoval', 'guardedRemoval'], ['guardedConfig', 'config']]) requireReview(packet[`${prefix}Bytes`] === manifest[key].bytes && packet[`${prefix}Sha256`] === manifest[key].sha256, 'Functional root package receipt/member authority changed')
  requireReview(packet.oldSetupSha256 === profileReview.setupSha256 && packet.oldSetupBytes === profileReview.setupBytes && packet.oldUninstallerSha256 === 'b0242b31b839cc8bf40ba4ac492004629bcf8ed28f8648d8c46b1797f7befb60' && packet.oldUninstallerBytes === 174881, 'Exact historical installer/member required')
  requireReview(packet.newPackageSourceHead === manifest.packageSourceHead && packet.newSetupSha256 === manifest.setup.sha256 && packet.newSetupBytes === manifest.setup.bytes && packet.productSourceInputsMatched === true && JSON.stringify(packet.productSourcePins14) === JSON.stringify(manifest.productSourcePins14), 'Reviewed prepared package reuse binding changed')
  requireReview(packet.packageTrackedDiffVerified === true && shaValue(packet.packageTrackedDiffSha256), 'Full tracked package-source compatibility proof required')
  requireReview(manifest.productSourcePins14.length === 14 && new Set(manifest.productSourcePins14.map((pin: any) => pin.path)).size === 14, 'Exact fourteen package inputs required')
  for (const pin of manifest.productSourcePins14) {
    const bytes = canonicalReviewBytes(ordinaryFile(join(workspace, pin.path), 1048576))
    const checkout = Buffer.from(bytes.toString('utf8').replace(/\n/g, '\r\n'))
    requireReview(reviewHash(bytes) === pin.canonicalSha256 && checkout.length === pin.receiptBytes && reviewHash(checkout) === pin.receiptSha256, 'Prepared package source input differs from current tracked bytes')
  }
  const a = packet.stageA
  requireReview(a && headValue(a.sourceHead) && positiveSafe(a.runId) && positiveSafe(a.jobId) && positiveSafe(a.fixtureBytes) && a.fixtureBytes <= 1048576 && shaValue(a.fixtureSha256) && shaValue(a.sourceSetSha256) && a.fixtureSha256 === packet.fixtureSha256 && a.fixtureBytes === packet.fixtureBytes && a.sourceSetSha256 === packet.sourceSetSha256, 'Actual new Stage A binary/source identity required')
  requireReview(a.artifact && positiveSafe(a.artifact.id) && a.artifact.name === 'windows-installer-evidence' && positiveSafe(a.artifact.size) && a.artifact.size <= 16777216 && /^sha256:[0-9a-f]{64}$/.test(a.artifact.digest), 'Bounded actual Stage A artifact required')
  const exactBlobs = (pins: FunctionalBlob[], names: string[]) => Array.isArray(pins) && pins.length === names.length && new Set(pins.map(pin => pin?.file)).size === names.length && pins.every(pin => pin && names.includes(pin.file) && positiveSafe(pin.bytes) && pin.bytes <= 1048576 && shaValue(pin.sha256))
  requireReview(exactBlobs(a.sources, functionalSourceNames) && a.sources.every(pin => shaValue(pin.canonicalSha256)) && exactBlobs(a.reports, functionalReportNames), 'Exact raw Stage A sources/reports required')
  for (const pin of a.sources) requireReview(sourceHash(workspace, `scripts/pr/${pin.file}`, 1048576) === pin.canonicalSha256, 'Current native source differs from the actual Stage A PE')
  const sourceSet = reviewHash(JSON.stringify(functionalSourceNames.map(file => ({ path: `scripts/pr/${file}`, canonicalSha256: a.sources.find(pin => pin.file === file)!.canonicalSha256 }))))
  requireReview(sourceSet === a.sourceSetSha256, 'Functional exact source-set digest changed')
  requireReview(a.oldMemberProof?.file === 'member-proof/historical/member-proof.json' && positiveSafe(a.oldMemberProof.bytes) && a.oldMemberProof.bytes <= 1048576 && shaValue(a.oldMemberProof.sha256), 'Actual historical member proof required')
  return packet
}

export function validateFunctionalInvocation(event: any, env: Record<string, string | undefined>, packet: FunctionalOncePacket): ReviewInvocation {
  requireReview(env.CI === 'true' && env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REPOSITORY === profileReview.repository && event.repository?.full_name === profileReview.repository && env.GITHUB_ACTOR === profileReview.actor && event.sender?.login === profileReview.actor, 'Explicit root functional dispatch required')
  requireReview(env.GITHUB_REF === functionalUpgrade.executionRef && env.GITHUB_SHA === packet.activationHead && [functionalUpgrade.executionRef, functionalUpgrade.executionRef.replace('refs/heads/', '')].includes(event.ref) && event.inputs?.functional_upgrade === 'true' && event.inputs?.functional_head === packet.activationHead && env.GITHUB_RUN_ATTEMPT === '1', 'Exact functional execution ref/head and first attempt required')
  const runId = Number(env.GITHUB_RUN_ID), runNumber = Number(env.GITHUB_RUN_NUMBER)
  requireReview(positiveSafe(runId) && positiveSafe(runNumber), 'Exact functional Actions run identity required')
  return { head: packet.activationHead, runId, runNumber }
}

export async function claimFunctionalUpgrade(invocation: ReviewInvocation, packet: FunctionalOncePacket, rootPacketSha256: string, claimantSourceSha256: string, get: GitHubRead): Promise<FunctionalClaim> {
  requireReview(shaValue(rootPacketSha256) && shaValue(claimantSourceSha256), 'Exact functional claim sources required')
  const workflow = await get(`/actions/workflows/${functionalUpgrade.workflowId}`) as any
  requireReview(workflow?.id === functionalUpgrade.workflowId && workflow.path === functionalUpgrade.workflowPath && workflow.state === 'active', 'Registered functional manual workflow changed')
  const pr = await get('/pulls/1883') as any
  requireReview(pr?.number === 1883 && pr.state === 'open' && pr.head?.sha === invocation.head && pr.head?.ref === profileReview.branch && pr.head?.repo?.full_name === profileReview.headRepository && pr.base?.ref === 'main' && pr.base.sha === packet.mainHead && pr.base.repo?.full_name === profileReview.repository, 'Original PR/head/main changed before functional admission')
  const main = await get('/git/ref/heads/main') as any
  requireReview(main?.ref === 'refs/heads/main' && main.object?.type === 'commit' && main.object.sha === packet.mainHead, 'Actual main advanced before functional admission')
  const current = await get(`/actions/runs/${invocation.runId}`) as ReviewRun
  const title = functionalUpgrade.runNamePrefix + invocation.head
  requireReview(current?.workflow_id === functionalUpgrade.workflowId && current.id === invocation.runId && current.run_number === invocation.runNumber && current.run_attempt === 1 && current.head_sha === invocation.head && current.event === 'workflow_dispatch' && current.display_title === title && current.actor?.login === profileReview.actor, 'Current functional invocation changed')
  const rows: ReviewRun[] = []
  let total: number | undefined
  for (let page = 1; ; page++) {
    const history = await get(`/actions/workflows/${functionalUpgrade.workflowId}/runs?head_sha=${invocation.head}&event=workflow_dispatch&per_page=100&page=${page}`) as { total_count: number; workflow_runs: ReviewRun[] }
    requireReview(positiveSafe(history?.total_count) && history.total_count <= 1000 && Array.isArray(history.workflow_runs) && (total === undefined || total === history.total_count), 'Incomplete or changing functional invocation history')
    total = history.total_count
    requireReview(history.workflow_runs.length === Math.min(100, total - rows.length), 'Incomplete functional history page')
    rows.push(...history.workflow_runs)
    if (rows.length === total) break
  }
  const ids = new Set<number>(), numbers = new Set<number>()
  for (const run of rows) {
    requireReview(run && positiveSafe(run.id) && positiveSafe(run.run_number) && positiveSafe(run.run_attempt) && run.workflow_id === functionalUpgrade.workflowId && run.head_sha === invocation.head && run.event === 'workflow_dispatch' && typeof run.display_title === 'string' && run.display_title.length > 0 && typeof run.actor?.login === 'string' && run.actor.login.length > 0 && !ids.has(run.id) && !numbers.has(run.run_number), 'Unassociated or duplicate functional history row')
    ids.add(run.id)
    numbers.add(run.run_number)
    if (run.id === current.id) requireReview(JSON.stringify(runIdentity(run)) === JSON.stringify(runIdentity(current)), 'Current functional history row changed')
  }
  const matching = rows.filter(run => run.display_title === title)
  requireReview(matching.some(run => run.id === current.id) && matching.every(run => run.actor.login === profileReview.actor && run.run_number >= current.run_number), 'Functional head already consumed; no retry')
  const verifyArtifact = async (pin: FunctionalArtifact, runId: number, head: string) => {
    const artifact = await get(`/actions/artifacts/${pin.id}`) as any
    requireReview(artifact?.id === pin.id && artifact.name === pin.name && artifact.size_in_bytes === pin.size && artifact.digest === pin.digest && artifact.expired === false && artifact.workflow_run?.id === runId && artifact.workflow_run.head_sha === head, 'Reviewed functional input artifact unavailable or changed')
  }
  const aRun = await get(`/actions/runs/${packet.stageA.runId}`) as any
  requireReview(aRun?.id === packet.stageA.runId && aRun.workflow_id === profileOnlyReview.workflowId && aRun.head_sha === packet.stageA.sourceHead && aRun.event === 'pull_request' && aRun.run_attempt === 1, 'New native Stage A ordinary source run changed')
  const jobs: any[] = []
  let jobTotal: number | undefined
  for (let page = 1; ; page++) {
    const result = await get(`/actions/runs/${packet.stageA.runId}/jobs?per_page=100&page=${page}`) as any
    requireReview(positiveSafe(result?.total_count) && result.total_count <= 1000 && Array.isArray(result.jobs) && (jobTotal === undefined || jobTotal === result.total_count), 'Incomplete or changing Stage A job history')
    jobTotal = result.total_count
    requireReview(result.jobs.length === Math.min(100, jobTotal! - jobs.length), 'Incomplete Stage A jobs page')
    jobs.push(...result.jobs)
    if (jobs.length === jobTotal) break
  }
  requireReview(new Set(jobs.map(job => job?.id)).size === jobs.length && jobs.every(job => positiveSafe(job?.id) && job.run_id === packet.stageA.runId && job.run_attempt === 1 && job.head_sha === packet.stageA.sourceHead), 'Unassociated Stage A qualification job')
  const windows = jobs.filter(job => job.name === 'windows-installer-checks')
  // The reviewed qualification job and artifact must be complete. Unchanged
  // global coverage may still run; merge gates remain the publisher's gate.
  requireReview(windows.length === 1 && windows[0].id === packet.stageA.jobId && windows[0].status === 'completed' && windows[0].conclusion === 'success', 'Actual Stage A Windows qualification job not passed')
  await verifyArtifact(packet.stageA.artifact, packet.stageA.runId, packet.stageA.sourceHead)
  await verifyArtifact(functionalUpgrade.oldFixtureArtifact, functionalUpgrade.oldFixtureRun, packet.newPackageSourceHead)
  // Package metadata is fixed in source, not selected by the dispatch caller.
  const packagePin = functionalPreparedPackage
  await verifyArtifact(packagePin.artifact, packagePin.runId, packagePin.sourceHead)
  return { version: 1, status: 'first_matching_run_claimed', repository: profileReview.repository, ...invocation, runAttempt: 1, workflowId: current.workflow_id, displayTitle: title, minimumMatchingRunNumber: current.run_number, minimumMatchingRunId: current.id, completePagination: true, claimantSourceSha256, rootPacketSha256 }
}

const functionalPreparedPackage = {
  sourceHead: '7bc62ecd68b96e900094b924193f06438be6ba2a', runId: 43581658402,
  artifact: { id: 14109460170, name: 'windows-installer-candidate-package-7bc62ecd68b96e900094b924193f06438be6ba2a-43581658402', size: 219177029, digest: 'sha256:c00ee9dc89a3bf1f38babcbf4aaf38fc74f347b351d439c9379bb6b31837539b' },
}

export function functionalUpgradePaths(head: string) {
  requireReview(headValue(head) && head !== profileReview.admittedHead, 'Exact new functional head required')
  const stageBase = `D:\\a\\_temp\\cc-haha-1879-u-${head}-a2c7e590-g1`
  const bootstrap = stageBase + '-bootstrap'
  return { stageBase, bootstrap, packageDirectory: win32.join(bootstrap, 'packet'), inputDirectory: stageBase + '-input', claimFile: win32.join(bootstrap, 'claim.json') }
}

function assertFunctionalClaim(claim: FunctionalClaim, invocation: ReviewInvocation, rootHash: string, claimantHash: string) {
  requireReview(claim?.version === 1 && claim.status === 'first_matching_run_claimed' && claim.repository === profileReview.repository && claim.head === invocation.head && claim.runId === invocation.runId && claim.runNumber === invocation.runNumber && claim.runAttempt === 1 && claim.workflowId === functionalUpgrade.workflowId && claim.displayTitle === functionalUpgrade.runNamePrefix + invocation.head && claim.minimumMatchingRunNumber === invocation.runNumber && claim.minimumMatchingRunId === invocation.runId && claim.completePagination === true && claim.claimantSourceSha256 === claimantHash && claim.rootPacketSha256 === rootHash, 'Complete independent functional claim missing or changed')
}

// Streams large Setup files; the subsequent protected copy and held launcher
// pin independently verify the same bytes before Native can create any SID.
function functionalFilePin(path: string, pin: { bytes: number; sha256: string }, maximum: number) {
  const stat = lstatSync(path)
  requireReview(stat.isFile() && !stat.isSymbolicLink() && stat.size === pin.bytes && pin.bytes <= maximum && shaValue(pin.sha256), 'Functional input file kind/size changed')
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const item = lstatSync(parent)
    requireReview(item.isDirectory() && !item.isSymbolicLink(), 'Functional input reparse ancestor')
    if (dirname(parent) === parent) break
  }
  const file = openSync(path, 'r')
  try {
    const opened = fstatSync(file)
    requireReview(opened.dev === stat.dev && opened.ino === stat.ino && opened.size === stat.size, 'Functional input changed while opening')
    const hash = createHash('sha256'), block = Buffer.alloc(65536)
    let bytes = 0, count: number
    while ((count = readSync(file, block)) > 0) {
      bytes += count
      requireReview(bytes <= maximum, 'Functional input grew')
      hash.update(block.subarray(0, count))
    }
    requireReview(bytes === pin.bytes && hash.digest('hex') === pin.sha256, 'Functional input bytes changed')
  } finally { closeSync(file) }
}

export function validateFunctionalStageAQualification(a: FunctionalStageA, checks: any, reports: Record<string, any>) {
  requireReview(checks.version === 1 && checks.stage === 'A' && checks.status === 'passed' && checks.platform === 'win32' && checks.sourceSetSha256 === a.sourceSetSha256 && checks.executableSha256 === a.fixtureSha256 && checks.realAccountsCreated === 0 && checks.realProfilesCreated === 0 && checks.releasedPeExecuted === false && checks.releasedPeMayHaveExecuted === false && checks.exitCode === 0, 'Actual new Stage A compile not proven')
  requireReview(Array.isArray(checks.sources) && checks.sources.length === 3 && a.sources.every(pin => checks.sources.filter((source: any) => source.path === `scripts/pr/${pin.file}` && source.bytes === pin.bytes && source.sha256 === pin.sha256 && source.canonicalSha256 === pin.canonicalSha256).length === 1), 'New Stage A report/raw source binding changed')
  for (const name of ['compile', 'self-test', 'abi-harness']) requireReview(Array.isArray(checks.commands) && checks.commands.filter((command: any) => command.name === name && command.exitCode === 0 && command.timedOut === false).length === 1, 'Actual new Stage A command failed')
  for (const [name, mode] of [['self-test.raw.json', 'self-test'], ['abi-harness.raw.json', 'abi-harness'], ['profile-only-preflight.raw.json', 'profile-only-preflight']]) {
    const report = reports[name]
    requireReview(report.version === 1 && report.mode === mode && report.status === 'passed' && report.realAccountsCreated === 0 && report.realProfilesCreated === 0 && report.releasedPeExecuted === false && report.releasedPeMayHaveExecuted === false && report.compatibilityEnabled === false && report.oldExit22Policy === 'fatal' && Array.isArray(report.checks) && report.checks.length > 0 && report.checks.every((check: any) => check.status === 'passed'), 'Actual new Stage A native/preflight report failed')
    if (mode !== 'profile-only-preflight') requireReview(report.binarySha256 === a.fixtureSha256, 'Stage A report binary changed')
    if (mode === 'abi-harness' || mode === 'profile-only-preflight') requireReview(report.cleanup === 'passed', 'Stage A owned cleanup not proven')
    for (const key of f1FactNames) if (mode !== 'profile-only-preflight') requireReview(report[key] === 'not_run', 'Stage A cannot promote F1 facts')
  }
  // Old general F1/ETW advisory resources are not this qualification's ABI or
  // bootstrap resources. Preserve their raw status; never promote it to clean.
  return { version: 1, status: 'passed', qualification: ['compile', 'self-test', 'abi-harness', 'profile-only-preflight'], abiCleanup: 'passed', bootstrapCleanup: 'passed', legacyF1Advisory: 'not_used_for_functional_qualification', generalStageARootCleanupReported: checks.privateRootRemoved === true ? 'removed' : 'retained_or_unknown' }
}

export function validateFunctionalDownloadedInputs(workspace: string, packet: FunctionalOncePacket, stageA: string, historical: string, packageRoot: string) {
  const a = packet.stageA
  for (const pin of [...a.sources, ...a.reports]) functionalFilePin(join(stageA, pin.file), pin, 1048576)
  functionalFilePin(join(stageA, 'profile-fixture.exe'), { bytes: a.fixtureBytes, sha256: a.fixtureSha256 }, 1048576)
  const read = (path: string) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(ordinaryFile(path, 1048576)))
  const qualification = validateFunctionalStageAQualification(a, read(join(stageA, 'checks.json')), Object.fromEntries(functionalReportNames.slice(1).map(name => [name, read(join(stageA, name))])))
  const oldProofPath = join(stageA, '..', a.oldMemberProof.file)
  functionalFilePin(oldProofPath, a.oldMemberProof, 1048576)
  const oldProof = read(oldProofPath)
  const member = (proof: any, setup: any, output: any, literal: string) => requireReview(proof?.version === 1 && proof.status === 'member_proven' && proof.forcedType === 'Nsis' && proof.literalMember === literal && proof.peExecuted === false && proof.setup?.bytes === setup.bytes && proof.setup.sha256 === setup.sha256 && proof.output?.bytes === output.bytes && proof.output.sha256 === output.sha256, 'Functional exact static NSIS member chain changed')
  const oldSetup = { bytes: profileReview.setupBytes, sha256: profileReview.setupSha256 }
  member(oldProof, oldSetup, { bytes: 174881, sha256: packet.oldUninstallerSha256 }, '$R0\\Uninstall Claude Code Haha.exe')
  const oldSetupPath = join(historical, 'Claude-Code-Haha-0.7.8-Windows-x64-Setup.exe')
  functionalFilePin(oldSetupPath, oldSetup, 1073741824)
  const manifest = functionalJson(workspace, 'prepared-package.json')
  requireReview(JSON.stringify(manifest.packageArtifact) === JSON.stringify(functionalPreparedPackage.artifact), 'Fixed prepared package artifact changed')
  const receiptPath = join(packageRoot, manifest.packageReceipt.file)
  functionalFilePin(receiptPath, manifest.packageReceipt, 1048576)
  const receipt = read(receiptPath)
  requireReview(receipt.version === 1 && receipt.status === 'candidate_package_prepared' && receipt.sourceHead === manifest.packageSourceHead && receipt.sourceTree === manifest.packageTree && receipt.runId === String(manifest.packageRunId) && receipt.runAttempt === 1 && receipt.kind === 'full-electron-nsis-package' && receipt.accountsCreated === 0 && receipt.profilesCreated === 0 && receipt.installed === false && receipt.cleanup === 'owned_temporary_directory_removed' && receipt.cleanupRuntime?.runtime === 'node22' && receipt.cleanupRuntime.attempts === 1 && receipt.cleanupRuntime.confirmedAbsent === true && Array.isArray(receipt.commands) && receipt.commands.length === 9 && receipt.commands.every((command: any) => command.exitCode === 0), 'Original prepared package receipt not proven')
  requireReview(receipt.setupSha256 === manifest.setup.sha256 && receipt.setupBytes === manifest.setup.bytes && receipt.uninstallerSha256 === manifest.uninstaller.sha256 && receipt.uninstallerBytes === manifest.uninstaller.bytes && receipt.guardedRemovalSha256 === manifest.guardedRemoval.sha256 && receipt.guardedRemovalBytes === manifest.guardedRemoval.bytes && receipt.compiledConfig?.bytes === manifest.config.bytes && receipt.compiledConfig.sha256 === manifest.config.sha256 && JSON.stringify(receipt.payloads) === JSON.stringify(manifest.payloads), 'Prepared package PE/config/payload pins changed')
  requireReview(Array.isArray(receipt.sourcePins) && receipt.sourcePins.length === 14 && manifest.productSourcePins14.every((pin: any) => receipt.sourcePins.filter((source: any) => source.path === pin.path && source.bytes === pin.receiptBytes && source.sha256 === pin.receiptSha256).length === 1), 'Prepared package fourteen source receipt changed')
  functionalFilePin(join(packageRoot, manifest.setup.file), manifest.setup, 1073741824)
  const newProofPath = join(packageRoot, 'setup-member/member-proof.json')
  const helperProofPath = join(packageRoot, 'uninstaller-member/member-proof.json')
  const configProofPath = join(packageRoot, 'uninstaller-config-member/member-proof.json')
  member(read(newProofPath), manifest.setup, manifest.uninstaller, '$R0\\Uninstall Claude Code Haha.exe')
  member(read(helperProofPath), manifest.uninstaller, manifest.guardedRemoval, '$PLUGINSDIR\\cc-haha-guarded-removal.exe')
  const configProof = read(configProofPath)
  member(configProof, manifest.uninstaller, manifest.config, '$PLUGINSDIR\\cc-haha-guarded-removal.exe.config')
  requireReview(configProof.contentKind === 'helper-runtime-config' && configProof.captured?.bytes === manifest.config.bytes && configProof.captured.sha256 === manifest.config.sha256, 'Prepared config capture/member mismatch')
  // The raw receipt pins the three proofs; no caller-controlled proof is trusted.
  for (const [path, proof] of [[newProofPath, receipt.uninstallerMember?.proof], [helperProofPath, receipt.helperMember?.proof], [configProofPath, receipt.configMember?.proof]] as const) requireReview(JSON.stringify(read(path)) === JSON.stringify(proof), 'Prepared member receipt raw proof changed')
  return { qualification, manifest, receiptPath, oldProofPath, newProofPath, oldSetupPath, newSetupPath: join(packageRoot, manifest.setup.file) }
}

export function prepareFunctionalUpgradePacket(workspace: string, invocation: ReviewInvocation, once: FunctionalOncePacket, claim: FunctionalClaim) {
  validateFunctionalOncePacket(once, workspace)
  const rootPacketBytes = jsonBytes(once), rootHash = reviewHash(rootPacketBytes)
  const claimantHash = sourceHash(workspace, 'scripts/pr/windows-installer-profile-review.ts')
  assertFunctionalClaim(claim, invocation, rootHash, claimantHash)
  requireReview(once.activationHead === invocation.head, 'Functional packet activation head changed')
  const paths = functionalUpgradePaths(invocation.head)
  const manifest = functionalJson(workspace, 'prepared-package.json')
  const claimBytes = jsonBytes(claim)
  const authorization = { ...once, actionsRunId: invocation.runId, actionsRunNumber: invocation.runNumber,
    claimSha256: reviewHash(claimBytes), claimantSourceSha256: claimantHash, completeFirstInvocation: true, rootPacketSha256: rootHash }
  const authorizationBytes = jsonBytes(authorization)
  const a = once.stageA
  const stageAReceipt = { version: 1, status: 'verified-stage-a', sourceHead: a.sourceHead, runId: a.runId,
    artifactId: a.artifact.id, artifactSha256: a.artifact.digest.slice(7), fixtureSha256: a.fixtureSha256,
    fixtureBytes: a.fixtureBytes, sourceSetSha256: a.sourceSetSha256,
    sourcePins: a.sources.map(pin => ({ file: pin.file, sha256: pin.sha256 })),
    rawReports: a.reports.map(pin => ({ file: pin.file, sha256: pin.sha256 })) }
  const stageBytes = jsonBytes(stageAReceipt)
  const blob = (file: string, bytes: number, sha256: string) => ({ file: win32.join(paths.inputDirectory, file), bytes, sha256 })
  const nativePackage = {
    sourceHead: manifest.packageSourceHead, displayVersion: '0.7.8',
    setup: blob('functional-new-full-setup.exe', manifest.setup.bytes, manifest.setup.sha256),
    buildReceipt: blob('functional-build-receipt.json', manifest.packageReceipt.bytes, manifest.packageReceipt.sha256),
    memberReceipt: blob('functional-new-member-proof.json', manifest.memberProof.bytes, manifest.memberProof.sha256),
    uninstallerBytes: manifest.uninstaller.bytes, uninstallerSha256: manifest.uninstaller.sha256,
    archiveLiteral: '$R0\\Uninstall Claude Code Haha.exe', guardedRemovalBytes: manifest.guardedRemoval.bytes,
    guardedRemovalSha256: manifest.guardedRemoval.sha256, payloads: manifest.payloads,
  }
  const spec = {
    version: 1, mode: 'functional-upgrade-controller', executionStage: 'functional-upgrade', realExecutionAdmitted: true,
    runId: functionalUpgrade.runId, owner: functionalUpgrade.owner, generation: 1,
    sourceRoot: paths.inputDirectory, gitRoot: 'D:\\a\\cc-haha\\cc-haha', controllerRoot: win32.join(paths.stageBase, 'controller'),
    output: win32.join(paths.stageBase, 'controller/functional-upgrade-report.json'),
    setupPath: win32.join(paths.inputDirectory, 'old-setup.exe'), expectedBinarySha256: a.fixtureSha256,
    sourcePins: stageAReceipt.sourcePins, frozenPlanManifestSha256: functionalUpgrade.planSha256,
    argvEnvPlanSha256: functionalUpgrade.environmentSha256, f1: null,
    functional: {
      version: 1, status: 'admitted-functional', activationHead: invocation.head, candidateSourceHead: invocation.head,
      candidateTree: once.candidateTree, stageASourceHead: a.sourceHead, stageARunId: a.runId,
      stageAArtifactId: a.artifact.id, stageAArtifactSha256: a.artifact.digest.slice(7), sourceSetSha256: a.sourceSetSha256,
      fixtureBytes: a.fixtureBytes, stageAReceipt: blob('functional-stage-a-receipt.json', stageBytes.length, reviewHash(stageBytes)),
      oldMemberReceipt: blob('functional-old-member-proof.json', a.oldMemberProof.bytes, a.oldMemberProof.sha256),
      newPackage: nativePackage, guardedConfigBytes: manifest.config.bytes, guardedConfigSha256: manifest.config.sha256,
      packageReceipt: blob('functional-package-receipt.json', manifest.packageReceipt.bytes, manifest.packageReceipt.sha256),
      authorizationReceipt: blob('functional-authorization.json', authorizationBytes.length, reviewHash(authorizationBytes)),
    },
  }
  const specBytes = jsonBytes(spec)
  const readSource = (file: string) => canonicalReviewBytes(ordinaryFile(join(workspace, functionalDirectory, file), 131072))
  const files = [
    { name: 'launch.ps1', bytes: readSource('launch.ps1') },
    // Import declarations only; the old launcher's executable body and grants
    // are never evaluated or promoted to this mode.
    { name: 'primitives.ps1', bytes: canonicalReviewBytes(ordinaryFile(join(workspace, 'scripts/pr/windows-installer-profile-only/fixtures/launch-profile-only.proposed.ps1'), 131072)) },
    { name: 'plan.json', bytes: readSource('plan.json') }, { name: 'argv-env-plan.json', bytes: readSource('argv-env-plan.json') },
    { name: 'root-once-packet.json', bytes: rootPacketBytes }, { name: 'controller-spec.json', bytes: specBytes },
    { name: 'functional-authorization.json', bytes: authorizationBytes }, { name: 'functional-stage-a-receipt.json', bytes: stageBytes },
  ]
  const pins = {
    version: 1, kind: 'functional-upgrade', status: 'new_root_once_claimed', ...paths,
    activationHead: invocation.head, candidateTree: once.candidateTree, rootPacketSha256: rootHash,
    specSha256: reviewHash(specBytes), authorizationSha256: reviewHash(authorizationBytes), claimSha256: reviewHash(claimBytes),
    binarySha256: a.fixtureSha256, binaryBytes: a.fixtureBytes, launcherWaitMilliseconds: 1200000,
    claimantSourceSha256: claimantHash, workflowId: functionalUpgrade.workflowId,
    launcherSha256: reviewHash(files[0].bytes), primitivesSha256: reviewHash(files[1].bytes),
    planSha256: functionalUpgrade.planSha256, environmentSha256: functionalUpgrade.environmentSha256,
    inputs: [
      { name: 'profile-fixture.exe', bytes: a.fixtureBytes, sha256: a.fixtureSha256 },
      ...a.sources.map(pin => ({ name: pin.file, bytes: pin.bytes, sha256: pin.sha256 })),
      { name: 'old-setup.exe', bytes: profileReview.setupBytes, sha256: profileReview.setupSha256 },
      { name: 'functional-new-full-setup.exe', bytes: manifest.setup.bytes, sha256: manifest.setup.sha256 },
      { name: 'functional-old-member-proof.json', bytes: a.oldMemberProof.bytes, sha256: a.oldMemberProof.sha256 },
      { name: 'functional-build-receipt.json', bytes: manifest.packageReceipt.bytes, sha256: manifest.packageReceipt.sha256 },
      { name: 'functional-package-receipt.json', bytes: manifest.packageReceipt.bytes, sha256: manifest.packageReceipt.sha256 },
      { name: 'functional-new-member-proof.json', bytes: manifest.memberProof.bytes, sha256: manifest.memberProof.sha256 },
      { name: 'functional-authorization.json', bytes: authorizationBytes.length, sha256: reviewHash(authorizationBytes) },
      { name: 'functional-stage-a-receipt.json', bytes: stageBytes.length, sha256: reviewHash(stageBytes) },
    ],
  }
  const pinsBytes = jsonBytes(pins)
  files.push({ name: 'pins.json', bytes: pinsBytes })
  return { invocation, claim, once, paths, pins, spec, authorization, files,
    hashes: { pins: reviewHash(pinsBytes), spec: pins.specSha256, authorization: pins.authorizationSha256 } }
}

export function validateFunctionalTerminal(packet: ReturnType<typeof prepareFunctionalUpgradePacket>, launch: any, native: any, ledger: any) {
  const bound = (value: any) => value?.runId === functionalUpgrade.runId && value.owner === functionalUpgrade.owner && value.generation === 1 && value.specSha256 === packet.hashes.spec
  requireReview(bound(launch) && bound(ledger) && launch.activationHead === packet.invocation.head && String(launch.actionsRunId) === String(packet.invocation.runId) && launch.pinsSha256 === packet.hashes.pins && launch.authorizationSha256 === packet.hashes.authorization && launch.claimSha256 === reviewHash(jsonBytes(packet.claim)), 'Functional native ownership/once binding changed')
  requireReview(launch.status === 'functional_passed_and_cleaned_no_exhaustive_F1' && launch.stageBase === packet.paths.stageBase && launch.controllerStartAttempted === true && launch.controllerStarted === true && launch.controllerIdentityVerified === true && positiveSafe(launch.controllerPid) && launch.controllerPid > 4 && functionalFileTime(launch.controllerBirthFileTime) && typeof launch.controllerImage === 'string' && launch.controllerImage.toLowerCase() === win32.join(packet.paths.inputDirectory, 'profile-fixture.exe').toLowerCase() && typeof launch.runnerSid === 'string' && /^S-1-5-(?:[0-9]+-)*[0-9]+$/.test(launch.runnerSid) && launch.nativeExitCode === 0 && launch.nativeCleanup === 'cleaned' && launch.stdoutComplete === true && launch.stderrComplete === true && launch.rawLogOverflow === false && launch.binarySha256 === packet.pins.binarySha256 && launch.binaryBytes === packet.pins.binaryBytes, 'Functional launcher did not prove natural bound success')
  requireReview(native?.version === 1 && native.mode === 'functional-upgrade' && native.status === 'passed' && native.cleanup === 'cleaned' && native.specSha256 === packet.hashes.spec && native.binarySha256 === packet.pins.binarySha256 && native.realAccountsCreated === 1 && native.realProfilesCreated === 1 && native.releasedPeExecuted === true && native.releasedPeMayHaveExecuted === true && Array.isArray(native.checks) && native.checks.length > 0 && native.checks.every((check: any) => check.status === 'passed'), 'Functional native terminal not passed/cleaned')
  const facts = native.functionalFacts
  requireReview(facts?.scope === 'isolated-v078-first-upgrade' && facts.status === 'passed' && facts.exhaustiveAudit === 'not_run' && facts.wholeBefore === 'not_run' && facts.freshInstallExit === 0 && facts.oldStandaloneExit === 22 && facts.normalRemovalExit === 0 && facts.rebuildExit === 0 && facts.upgradeExit === 0 && functionalBooleanFacts.every(name => facts[name] === true), 'Finite functional facts incomplete')
  const chain = facts.wholeSetupChain
  requireReview(chain?.status === 'observed' && chain.observation === 'readonly-owned-process-lifecycle' && chain.oldChildExit22Observed === true && chain.guardedHelperStarted === true && chain.guardedHelperExit0Observed === true && chain.unverifiedCount === 0 && Array.isArray(chain.processes) && chain.processes.length > 0 && chain.processes.length <= 128, 'Whole Setup old-child/helper lifecycle not observed')
  const roleHashes: Record<string, string> = { 'old-uninstaller': packet.once.oldUninstallerSha256, 'current-uninstaller': packet.spec.functional.newPackage.uninstallerSha256, 'guarded-helper': packet.spec.functional.newPackage.guardedRemovalSha256 }
  const processKeys = new Set<string>()
  for (const row of chain.processes) {
    requireReview(Object.hasOwn(roleHashes, row?.role) && positiveSafe(row.pid) && positiveSafe(row.parentPid) && functionalFileTime(row.creationTime) && functionalFileTime(row.exitTime) && BigInt(row.exitTime) >= BigInt(row.creationTime) && Number.isInteger(row.exitCode) && row.exitCode >= 0 && row.exitCode <= 0xffffffff && row.imageSha256 === roleHashes[row.role] && shaValue(row.imageCanonicalSha256) && typeof row.fileId === 'string' && /^[0-9a-f]{8}:[0-9a-f]{16}$/.test(row.fileId) && typeof row.volumePath === 'string' && /^\\\\\?\\Volume\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}\\$/.test(row.volumePath), 'Unbound functional lifecycle row')
    const key = `${row.pid}:${row.creationTime}`
    requireReview(!processKeys.has(key), 'Duplicate functional process identity')
    processKeys.add(key)
  }
  requireReview(chain.processes.some((row: any) => row.role === 'old-uninstaller' && row.exitCode === 22) && chain.processes.some((row: any) => row.role === 'current-uninstaller' && row.exitCode === 0) && chain.processes.some((row: any) => row.role === 'guarded-helper' && row.exitCode === 0), 'Whole Setup child exits cannot be replaced by standalone facts')
  requireReview(ledger.version === 1 && ledger.accountBound === true && ledger.accountCreated === true && ledger.account?.sid !== launch.runnerSid && /^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+$/.test(ledger.account?.sid ?? ''), 'Functional fresh owned ledger SID missing')
  const marker = new RegExp(`^CcHaha1879:${functionalUpgrade.runId}:([0-9a-f]{32})$`).exec(ledger.marker)
  requireReview(marker && ledger.account.marker === ledger.marker && ledger.intentSam === `c1879_${marker[1].slice(0, 12)}` && ledger.account.sam === ledger.intentSam, 'Functional fresh account ownership changed')
  for (const value of [launch, native]) for (const name of f1FactNames) requireReview(value[name] === 'not_run', 'Functional result must not promote old F1 facts')
  requireReview(native.compatibilityEnabled === false && native.oldExit22Policy === 'fatal', 'Original fatal/F1 policy changed')
  return facts
}

export function collectFunctionalUpgradeEvidence(packet: ReturnType<typeof prepareFunctionalUpgradePacket>, destination: string, launcherOutcome: string) {
  mkdirSync(destination, { recursive: true })
  const names = ['bootstrap-receipt.json', 'launch-receipt.json', 'controller.stdout.raw.log', 'controller.stderr.raw.log', 'controller/functional-upgrade-report.json', 'controller/ledger.json', ...functionalSnapshots.map(name => `controller/evidence/${name}`)]
  const files: FunctionalBlob[] = [], errors: string[] = []
  for (const name of names) {
    const path = join(name === 'bootstrap-receipt.json' ? packet.paths.bootstrap : packet.paths.stageBase, name)
    if (!existsSync(path)) continue
    try {
      const bytes = ordinaryFile(path, name.startsWith('controller/evidence/') ? 16777216 : 1048576), target = join(destination, name)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes, { flag: 'wx' })
      files.push({ file: name, bytes: bytes.length, sha256: reviewHash(bytes) })
    } catch { errors.push(`Functional evidence missing or unsafe: ${name}`) }
  }
  if (launcherOutcome === 'success') {
    for (const name of names) if (!files.some(pin => pin.file === name)) errors.push(`Successful functional evidence missing: ${name}`)
    if (errors.length === 0) {
      try {
        const read = (file: string) => JSON.parse(ordinaryFile(join(destination, file), 1048576).toString('utf8'))
        const launch = read('launch-receipt.json'), bootstrap = read('bootstrap-receipt.json')
        requireReview(bootstrap.version === 1 && bootstrap.status === 'prepared_no_native_execution' && bootstrap.activationHead === packet.invocation.head && String(bootstrap.actionsRunId) === String(packet.invocation.runId) && bootstrap.runnerSid === launch.runnerSid && bootstrap.claimSha256 === packet.pins.claimSha256 && bootstrap.accountApi === 'not_run' && bootstrap.nativeExecution === 'not_run' && Array.isArray(bootstrap.roots) && bootstrap.roots.length === 3 && [packet.paths.bootstrap, packet.paths.packageDirectory, packet.paths.inputDirectory].every(path => bootstrap.roots.filter((root: any) => root.path === path && /^[0-9a-f]{8}:[0-9a-f]{16}$/.test(root.fileIdentity)).length === 1), 'Functional bootstrap binding changed')
        requireReview(files.find(pin => pin.file === 'controller/functional-upgrade-report.json')!.sha256 === launch.terminalReportSha256, 'Functional report bytes changed')
        const native = read('controller/functional-upgrade-report.json')
        requireReview(native.evidenceFiles && Object.keys(native.evidenceFiles).toSorted().join('|') === functionalSnapshots.toSorted().join('|') && functionalSnapshots.every(name => native.evidenceFiles[name] === files.find(pin => pin.file === `controller/evidence/${name}`)?.sha256), 'Functional exact seven snapshot byte bindings changed')
        validateFunctionalTerminal(packet, launch, native, read('controller/ledger.json'))
      } catch { errors.push('Functional terminal binding failed; retain originals and unknown cleanup') }
    }
  }
  const report = { version: 1, kind: 'isolated-functional-upgrade-evidence', activationHead: packet.invocation.head, launcherOutcome, files, errors, fullF1: 'not_proven', exhaustiveAudit: 'not_run', retryAllowed: false, cleanup: launcherOutcome === 'success' && errors.length === 0 ? 'native_bound_cleaned' : 'unknown' }
  writeFileSync(join(destination, 'collection.json'), jsonBytes(report), { flag: 'wx' })
  requireReview(errors.length === 0, 'Functional evidence collection failed')
  return report
}

async function functionalUpgradeMain() {
  const mode = process.argv[2]
  requireReview(process.argv.length === 3 && ['--functional-upgrade-claim', '--functional-upgrade-prepare', '--functional-upgrade-collect'].includes(mode), 'Explicit functional claim/prepare/collect required')
  const paths = runnerPaths()
  requireReview(process.env.GITHUB_EVENT_PATH, 'Functional Actions event required')
  const event = JSON.parse(ordinaryFile(process.env.GITHUB_EVENT_PATH, 1048576).toString('utf8'))
  const once = decodeFunctionalOncePacket(process.env.FUNCTIONAL_PACKET_BASE64 ?? '', process.env.FUNCTIONAL_PACKET_SHA256 ?? '')
  validateFunctionalOncePacket(once, paths.workspace)
  requireReview(event.inputs?.functional_packet_base64 === process.env.FUNCTIONAL_PACKET_BASE64 && event.inputs?.functional_packet_sha256 === process.env.FUNCTIONAL_PACKET_SHA256, 'Functional environment differs from actual dispatch data')
  const invocation = validateFunctionalInvocation(event, process.env, once)
  requireReview(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: paths.workspace, encoding: 'utf8' }).trim() === invocation.head && execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: paths.workspace, encoding: 'utf8' }).trim() === once.candidateTree, 'Functional actual checkout commit/tree changed')
  const changed = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', functionalPreparedPackage.sourceHead, 'HEAD', '--'], { cwd: paths.workspace, maxBuffer: 1048576 }).toString('utf8').split('\0').filter(Boolean)
  requireReview(functionalPackageTrackedDiffSha256(changed) === once.packageTrackedDiffSha256, 'Actual tracked package compatibility diff changed')
  const claimantHash = sourceHash(paths.workspace, 'scripts/pr/windows-installer-profile-review.ts')
  const receipt = join(paths.temporary, `cc-haha-1879-u-claim-transfer-${invocation.runId}.json`)
  const evidence = join(paths.workspace, 'artifacts/windows-installer-functional-upgrade')
  mkdirSync(evidence, { recursive: true })
  if (mode === '--functional-upgrade-claim') {
    requireReview(process.env.PROFILE_REVIEW_TOKEN, 'Read-only functional Actions token missing')
    const get: GitHubRead = async path => {
      const response = await fetch(`https://api.github.com/repos/${profileReview.repository}${path}`, { headers: { Authorization: `Bearer ${process.env.PROFILE_REVIEW_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } })
      requireReview(response.ok, `Functional GitHub read failed (${response.status})`)
      return response.json()
    }
    const claim = await claimFunctionalUpgrade(invocation, once, process.env.FUNCTIONAL_PACKET_SHA256!, claimantHash, get)
    writeFileSync(receipt, jsonBytes(claim), { flag: 'wx' })
    writeFileSync(join(evidence, 'root-once-packet.json'), jsonBytes(once), { flag: 'wx' })
    writeFileSync(join(evidence, 'claim-transfer.json'), jsonBytes(claim), { flag: 'wx' })
    output('stage_a_artifact', String(once.stageA.artifact.id))
    output('stage_a_run', String(once.stageA.runId))
    return
  }
  const claim = JSON.parse(ordinaryFile(receipt, 65536).toString('utf8')) as FunctionalClaim
  const packet = prepareFunctionalUpgradePacket(paths.workspace, invocation, once, claim)
  if (mode === '--functional-upgrade-collect') {
    collectFunctionalUpgradeEvidence(packet, evidence, process.env.FUNCTIONAL_LAUNCHER_OUTCOME ?? 'unknown')
    return
  }
  mkdirSync(join(evidence, 'packet'))
  for (const file of packet.files) writeFileSync(join(evidence, 'packet', file.name), file.bytes, { flag: 'wx' })
  const download = join(paths.temporary, 'cc-haha-1879-functional-download')
  const stageA = join(download, 'A/profile-stage-a'), historical = join(download, 'old'), packageRoot = join(download, 'new')
  const verified = validateFunctionalDownloadedInputs(paths.workspace, once, stageA, historical, packageRoot)
  writeFileSync(join(evidence, 'qualification.json'), jsonBytes({ ...verified.qualification, sourceHead: once.stageA.sourceHead, runId: once.stageA.runId, jobId: once.stageA.jobId, reports: once.stageA.reports }), { flag: 'wx' })
  const from = (name: string) => win32.join(packet.paths.packageDirectory, name)
  const inputs = packet.pins.inputs.map(pin => ({ ...pin, from:
    pin.name === 'profile-fixture.exe' || functionalSourceNames.includes(pin.name as any) ? join(stageA, pin.name)
    : pin.name === 'old-setup.exe' ? verified.oldSetupPath
    : pin.name === 'functional-new-full-setup.exe' ? verified.newSetupPath
    : pin.name === 'functional-old-member-proof.json' ? verified.oldProofPath
    : pin.name === 'functional-build-receipt.json' || pin.name === 'functional-package-receipt.json' ? verified.receiptPath
    : pin.name === 'functional-new-member-proof.json' ? verified.newProofPath
    : from(pin.name) }))
  const plan = { version: 1, kind: 'functional-bootstrap', invocation, paths: packet.paths, hashes: packet.hashes,
    claimBase64: jsonBytes(claim).toString('base64'), inputs,
    files: packet.files.map(file => ({ name: file.name, base64: file.bytes.toString('base64'), sha256: reviewHash(file.bytes) })) }
  const planBytes = jsonBytes(plan), planPath = join(paths.temporary, `cc-haha-1879-u-prepare-${invocation.runId}.json`)
  requireReview(planBytes.length <= 1048576, 'Bounded functional preparation plan required')
  writeFileSync(planPath, planBytes, { flag: 'wx' })
  const result = spawnSync(profileOnlyPowerShell51, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(paths.workspace, functionalDirectory, 'bootstrap.ps1'), '-PrepareFunctionalUpgrade', '-PlanPath', planPath, '-ApprovedPlanSha256', reviewHash(planBytes)], { env: profileOnlyBootstrapEnvironment(process.env), timeout: 120000, maxBuffer: 1048576 })
  writeFileSync(join(evidence, 'bootstrap.stdout.raw.log'), result.stdout ?? Buffer.alloc(0), { flag: 'wx' })
  writeFileSync(join(evidence, 'bootstrap.stderr.raw.log'), result.stderr ?? Buffer.alloc(0), { flag: 'wx' })
  requireReview(!result.error && result.status === 0 && result.signal === null, 'Functional bootstrap failed before native execution')
  output('package_dir', packet.paths.packageDirectory)
  output('claim_file', packet.paths.claimFile)
  output('pins_sha256', packet.hashes.pins)
  output('spec_sha256', packet.hashes.spec)
  output('authorization_sha256', packet.hashes.authorization)
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Profile review preparation failed')
    process.exitCode = 1
  })
}
