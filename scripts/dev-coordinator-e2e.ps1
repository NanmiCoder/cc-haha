# -----------------------------------------------------------------------------
# dev-coordinator-e2e.ps1 — local end-to-end smoke for the coordinator
# behavior changes (B1 + B2).
#
# What it covers (idempotent — safe to re-run):
#   1. Lazy delegation lint (lazyDelegationCheck)
#      "based on the findings, fix the bug" → rejected with a re-write hint.
#   2. Specialist router redirect (specialistRouter)
#      Coordinator picks `worker` for "code review the auth module" → router
#      redirects to `code-reviewer`.
#   3. Invocation limiter near-limit warning (invocationLimiter)
#      Last allowed call returns nearLimit=true with a system-reminder
#      formatted by formatNearLimitWarning.
#   4. Stall detector transitions (agentStallDetector)
#      stalled fires once after threshold; resumed fires once after notify.
#   5. Mode advice (modeAdvice)
#      "Migrate the auth subsystem..." → coordinator; "Fix the typo..." →
#      normal.
#   6. Task-spec quality (taskSpecQuality, B2)
#      Full brief → well-specified; "fix it" → underspecified with a
#      missing-dimensions report; reasonable one-liner is NOT flagged.
#   7. Worker-continue advisor (workerContinueAdvisor, B3)
#      Same-type worker that already touched the prompt's file(s) is
#      surfaced as a continuation candidate; type mismatch and
#      file-free prompts are not flagged; error message contract
#      preserved (agentId, SendMessage, env flag named).
#
# This script does NOT spin up the API server or a real LLM call. The five
# B1 behaviors are all enforced inside the AgentTool boundary and are best
# proven via the unit-test suite plus an inline Bun script that exercises
# the real exported modules end-to-end (no mocks). That mirrors the
# "verifier runs the actual command" guidance in AGENTS.md.
#
# Optional flags:
#   -SkipUnitTests   skip step (a); only run the inline e2e script
#   -SkipE2EScript   skip step (b); only run the unit-test suite
#   -Quiet           less ceremony; failures still print
# -----------------------------------------------------------------------------

[CmdletBinding()]
param(
  [switch]$SkipUnitTests,
  [switch]$SkipE2EScript,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) {
  if (-not $Quiet) { Write-Host "==> $msg" -ForegroundColor Cyan }
}
function Write-Ok($msg) {
  if (-not $Quiet) { Write-Host "    OK $msg" -ForegroundColor Green }
}
function Write-Note($msg) {
  if (-not $Quiet) { Write-Host "    .. $msg" -ForegroundColor DarkGray }
}
function Fail($msg) {
  Write-Host "FAIL: $msg" -ForegroundColor Red
  exit 1
}

# Resolve repo root (this script lives in scripts/).
$RepoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $RepoRoot
try {
  # Sanity: bun on PATH.
  Write-Step "Checking bun is available"
  $bunVersion = & bun --version 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $bunVersion) {
    Fail "bun is not on PATH. Install from https://bun.sh/ and re-run."
  }
  Write-Ok "bun $bunVersion"

  # (a) Unit-test suite — covers each module's contract independently.
  if (-not $SkipUnitTests) {
    Write-Step "Running B1 unit tests"
    $tests = @(
      'src/tools/AgentTool/lazyDelegationCheck.test.ts',
      'src/tools/AgentTool/invocationLimiter.test.ts',
      'src/tools/AgentTool/specialistRouter.test.ts',
      'src/tools/AgentTool/agentStallDetector.test.ts',
      'src/tools/AgentTool/taskSpecQuality.test.ts',
      'src/tools/AgentTool/workerContinueAdvisor.test.ts',
      'src/utils/modeAdvice.test.ts'
    )
    & bun test @tests
    if ($LASTEXITCODE -ne 0) { Fail "B1 unit tests failed (see output above)" }
    Write-Ok "B1 unit tests passed"
  } else {
    Write-Note "skipping unit tests (--SkipUnitTests)"
  }

  # (b) Inline e2e script — exercises the real exported modules in one run,
  # no mocks. Each behavior is asserted; any failure exits non-zero with a
  # descriptive message. Written to a temp file because Bun's -e flag
  # doesn't support multi-statement TS.
  if (-not $SkipE2EScript) {
    Write-Step "Running inline B1 end-to-end smoke"
    # Place the temp script INSIDE the repo so `import './src/...'` resolves.
    $e2eDir = Join-Path $RepoRoot 'scripts'
    $e2ePath = Join-Path $e2eDir ".coordinator-e2e-$([Guid]::NewGuid()).ts"
    $e2eSource = @'
import {
  detectLazyDelegation,
  formatLazyDelegationError,
} from '../src/tools/AgentTool/lazyDelegationCheck.js'
import {
  suggestSpecialist,
  formatSpecialistRedirectMessage,
} from '../src/tools/AgentTool/specialistRouter.js'
import {
  _resetLimiterState,
  formatNearLimitWarning,
  noteInvocation,
} from '../src/tools/AgentTool/invocationLimiter.js'
import { createStallDetector } from '../src/tools/AgentTool/agentStallDetector.js'
import {
  analyzeFirstMessageForMode,
  formatModeAdviceBanner,
} from '../src/utils/modeAdvice.js'
import {
  assessTaskSpec,
  formatThinSpecError,
} from '../src/tools/AgentTool/taskSpecQuality.js'
import {
  findContinueCandidate,
  formatContinueHintError,
  type ContinueCandidateTask,
} from '../src/tools/AgentTool/workerContinueAdvisor.js'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`ASSERT FAIL: ${msg}`)
    process.exit(1)
  }
}

// 1. Lazy delegation lint.
{
  const lazy = detectLazyDelegation('Based on the findings, fix the auth bug.')
  assert(lazy !== null, 'lazy delegation should be detected')
  assert(/based on the findings/i.test(lazy!.phrase), 'phrase echoed')
  const err = formatLazyDelegationError(lazy!, 'Agent')
  assert(err.includes('Based on the findings'), 'error echoes phrase')
  assert(err.includes('CLAUDE_CODE_LAZY_DELEGATION_CHECK'), 'error names env flag')
  // negative case
  const ok = detectLazyDelegation('Fix the null pointer in src/auth/validate.ts:42.')
  assert(ok === null, 'specific prompts should not trip the lint')
  console.log('1. lazy delegation: OK')
}

// 2. Specialist router redirect.
{
  const types = new Set(['worker', 'code-reviewer', 'security-reviewer', 'debugger'])
  const suggested = suggestSpecialist('please code review the auth module', types)
  assert(suggested === 'code-reviewer', `expected code-reviewer, got ${suggested}`)
  const msg = formatSpecialistRedirectMessage('code-reviewer', 'Agent')
  assert(msg.includes('code-reviewer'), 'redirect names the specialist')
  // negative case
  const vague = suggestSpecialist('look at this code', types)
  assert(vague === undefined, 'vague prompts should not redirect')
  console.log('2. specialist router: OK')
}

// 3. Invocation limiter near-limit warning.
{
  _resetLimiterState()
  // verification cap = 5 by default. Drive 5 calls; the 5th must report
  // nearLimit=true. The 6th must be capped.
  const nearFlags: boolean[] = []
  for (let i = 1; i <= 5; i++) {
    const r = noteInvocation('verification')
    nearFlags.push(r.nearLimit)
    assert(r.capped === false, `call ${i} should not be capped`)
  }
  assert(
    JSON.stringify(nearFlags) === '[false,false,false,false,true]',
    `nearLimit should fire only on the 5th call, got ${JSON.stringify(nearFlags)}`,
  )
  const r6 = noteInvocation('verification')
  assert(r6.capped === true, 'call 6 should be capped')
  // formatter shape
  const warning = formatNearLimitWarning('verification', {
    count: 5,
    limit: 5,
    capped: false,
    nearLimit: true,
  })
  assert(warning.includes('<system-reminder>'), 'warning is a system-reminder block')
  assert(warning.includes('5 of 5'), 'warning shows current/cap')
  _resetLimiterState()
  console.log('3. invocation limiter near-limit: OK')
}

// 4. Stall detector transitions.
{
  const T0 = 1_000_000
  const d = createStallDetector({ thresholdMs: 90_000, startedAt: T0 })

  let s = d.check(T0 + 1_000)
  assert(s.kind === 'idle' && s.transitioned === false, 'idle before threshold')

  s = d.check(T0 + 90_000)
  assert(s.kind === 'stalled' && s.transitioned === true, 'first stalled check transitions')

  s = d.check(T0 + 100_000)
  assert(s.kind === 'stalled' && s.transitioned === false, 'subsequent stalled checks do not transition')

  d.notify(T0 + 105_000)
  s = d.check(T0 + 105_001)
  assert(s.kind === 'resumed' && s.transitioned === true, 'resumed transition once after notify')

  s = d.check(T0 + 110_000)
  assert(s.kind === 'idle', 'returns to idle after resume')
  console.log('4. stall detector: OK')
}

// 5. Mode advice.
{
  const adv1 = analyzeFirstMessageForMode(
    'Migrate the auth subsystem from express-session to JWT across the API server.',
  )
  assert(adv1?.suggestedMode === 'coordinator', `migration → coordinator, got ${adv1?.suggestedMode}`)
  const adv2 = analyzeFirstMessageForMode('Fix the typo in README.md')
  assert(adv2?.suggestedMode === 'normal', `typo → normal, got ${adv2?.suggestedMode}`)
  // banner: should produce an actionable message when active mode mismatches advice
  const banner = formatModeAdviceBanner('normal', adv1)
  assert(banner !== null, 'banner should be returned on mismatch')
  assert(/coordinator/i.test(banner!), 'banner mentions coordinator')
  assert(
    banner!.includes('CLAUDE_CODE_COORDINATOR_MODE'),
    'banner references the real launch mechanism, not a fake slash command',
  )
  assert(!/\/coordinator\b/.test(banner!), 'banner must not reference a nonexistent /coordinator command')
  // banner: null when active mode matches
  assert(formatModeAdviceBanner('coordinator', adv1) === null, 'banner null on match')
  console.log('5. mode advice: OK')
}

// 6. Task-spec quality (B2).
{
  const good = assessTaskSpec(
    'Fix the null pointer in src/auth/validate.ts:42. Add a guard before user.id, run the auth tests, and report the result.',
  )
  assert(good.quality === 'well-specified', `full brief should be well-specified, got ${good.quality}`)

  const thin = assessTaskSpec('fix it')
  assert(thin.quality === 'underspecified', `"fix it" should be underspecified, got ${thin.quality}`)
  const err = formatThinSpecError(thin, 'Agent')
  assert(err.includes('Agent'), 'thin-spec error names the tool')
  assert(
    err.includes('CLAUDE_CODE_COORDINATOR_TASK_SPEC_STRICT'),
    'thin-spec error names the opt-in flag',
  )

  // A reasonable one-liner must NOT be flagged (false-positive guard).
  const ok = assessTaskSpec('Run the test suite and report which tests fail.')
  assert(ok.quality !== 'underspecified', `reasonable one-liner should not be underspecified, got ${ok.quality}`)
  console.log('6. task-spec quality: OK')
}

// 7. Worker-continue advisor (B3).
{
  const T0 = 1_700_000_000_000
  const candidates: ContinueCandidateTask[] = [
    {
      agentId: 'agent-old',
      agentType: 'worker',
      description: 'auth investigation',
      startTime: T0,
      touchedFiles: ['src/auth/validate.ts', 'src/auth/session.ts'],
      isCompleted: true,
    },
    {
      agentId: 'agent-mismatch-type',
      agentType: 'code-reviewer',
      description: 'reviewed auth',
      startTime: T0 + 1000,
      touchedFiles: ['src/auth/validate.ts'],
      isCompleted: true,
    },
  ]

  // Overlap on the right type → continue
  const c = findContinueCandidate({
    prompt: 'Fix the null pointer in src/auth/validate.ts:42',
    subagentType: 'worker',
    candidates,
    options: { now: T0 + 5000 },
  })
  assert(c !== null, 'should recommend continuation when same-type worker overlaps')
  assert(c?.agentId === 'agent-old', `expected agent-old, got ${c?.agentId}`)
  assert(c?.sharedFiles.includes('src/auth/validate.ts'), 'shared file echoed')

  // Type mismatch → no recommendation
  const c2 = findContinueCandidate({
    prompt: 'Fix src/auth/validate.ts',
    subagentType: 'docs-writer',
    candidates,
    options: { now: T0 + 5000 },
  })
  assert(c2 === null, 'type mismatch should not recommend continuation')

  // Prompt with no file refs → no recommendation
  const c3 = findContinueCandidate({
    prompt: 'fix the bug',
    subagentType: 'worker',
    candidates,
    options: { now: T0 + 5000 },
  })
  assert(c3 === null, 'prompt without file refs should not recommend continuation')

  // Error message contract
  const err = formatContinueHintError(c!, 'Agent', 'SendMessage')
  assert(err.includes('agent-old'), 'error contains agent id')
  assert(err.includes('SendMessage'), 'error names SendMessage tool')
  assert(err.includes('CLAUDE_CODE_COORDINATOR_CONTINUE_HINT'), 'error names env flag')
  console.log('7. worker-continue advisor: OK')
}

console.log('\nB1 end-to-end smoke: ALL PASS')
'@
    Set-Content -LiteralPath $e2ePath -Value $e2eSource -Encoding UTF8
    try {
      & bun run $e2ePath
      if ($LASTEXITCODE -ne 0) { Fail "B1 e2e smoke failed (see output above)" }
      Write-Ok "B1 e2e smoke passed"
    } finally {
      Remove-Item -LiteralPath $e2ePath -Force -ErrorAction SilentlyContinue
    }
  } else {
    Write-Note "skipping inline e2e script (--SkipE2EScript)"
  }

  if (-not $Quiet) {
    Write-Host ""
    Write-Host "B1 coordinator behavior: GREEN" -ForegroundColor Green
  }
} finally {
  Pop-Location
}
