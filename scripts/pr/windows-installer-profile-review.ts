import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
function sourceHash(workspace: string, path: string) {
  return reviewHash(canonicalReviewBytes(ordinaryFile(join(workspace, path), 262144)))
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
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Profile review preparation failed')
    process.exitCode = 1
  })
}
