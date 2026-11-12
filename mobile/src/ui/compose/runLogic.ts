import { effortName } from '../modes'

/* ───────────── Run capsule ───────────── */

export type RunRisk = 'normal' | 'attention' | 'danger'
export type RunCapsule = {
  label: string
  risk: RunRisk
  disabled?: boolean
  locked?: boolean
}

/** Warning level for permission tiers: full access is most dangerous, auto and don't-ask need attention, others normal. */
export function modeRisk(mode?: string): RunRisk {
  if (mode === 'bypassPermissions') return 'danger'
  if (mode === 'auto' || mode === 'dontAsk') return 'attention'
  return 'normal'
}

/**
 * What happens after tapping a permission tier: tapping the current one does nothing; switching to full access or auto confirms first (like desktop, asking every time), 
 * everything else takes effect directly.
 */
export function modeChange(next: string, current?: string): 'none' | 'confirm' | 'apply' {
  if (next === (current ?? 'default')) return 'none'
  return next === 'bypassPermissions' || next === 'auto' ? 'confirm' : 'apply'
}

/**
 * Confirmation text before switching, matching desktop "Enable skip permissions?" and "Enable auto mode?".
 * Explicitly switching to auto itself counts as consent; the CLI does not rely on skipAutoPermissionPrompt recorded separately by desktop.
 */
export function modeConfirmation(mode: 'bypassPermissions' | 'auto', workDir?: string) {
  if (mode === 'auto')
    return {
      title: 'Enable auto mode?',
      message:
        'Auto mode reduces permission prompts but cannot guarantee complete safety.\n\n' +
        'It checks tool calls for risky operations and prompt injection, runs operations it considers safe, and blocks ones it considers risky. Use only in isolated environments.',
      confirm: 'Enable auto mode',
      destructive: false,
    }
  return {
    title: 'Enable full access?',
    message:
      'This grants full access to the computer with no further per-item confirmation: \n' +
      '· Read, write and delete any file\n' +
      '· Run any shell command\n' +
      '· Install or remove packages' +
      (workDir ? `\n\nDirectory: ${workDir}` : ''),
    confirm: 'Enable full access',
    destructive: true,
  }
}

/** Text on the run capsule: model name, followed by " · High" when there is a thinking effort. */
export function runLabel(model?: string, effort?: string | null): string {
  const name = model?.trim() || 'Computer default model'
  return effort ? `${name} · ${effortName(effort)}` : name
}

export function runCapsule(input: {
  mode?: string
  model?: string
  effort?: string | null
  disabled?: boolean
  locked?: boolean
}): RunCapsule {
  return {
    label: runLabel(input.model, input.effort),
    risk: modeRisk(input.mode),
    ...(input.disabled ? { disabled: true } : {}),
    ...(input.locked ? { locked: true } : {}),
  }
}

const riskNote: Record<RunRisk, string> = { normal: '', attention: ', needs attention', danger: ', risky' }

export function runCapsuleA11y(run: Pick<RunCapsule, 'label' | 'risk' | 'locked'>): string {
  return `Run mode: ${run.label}${riskNote[run.risk]}${run.locked ? ', cannot change while running' : ''}`
}

/* ───────────── Send slot ───────────── */

export type SendSlot = {
  kind: 'send' | 'queue' | 'stop' | 'idle' | 'blocked'
  enabled: boolean
  label: string
}

/**
 * The key at the bottom right of the input: 
 * no content, running (or the lead idle while team members still run), and the page provides stop → solid stop square; 
 * with content → up arrow ("Queue to send" while running when queueing is allowed); otherwise a greyed arrow.
 */
export function sendSlot(input: {
  hasContent: boolean
  busy: boolean
  /** This turn ended but there is still stoppable background work (approved team members); with content send directly as usual. */
  background?: boolean
  queueing: boolean
  disabled: boolean
  picking: boolean
  canStop: boolean
  /** No session id: this is the new task page, so the key says "Start task". */
  starting?: boolean
}): SendSlot {
  const idle = input.starting ? 'Start task' : 'Send'
  if (!input.hasContent) {
    if ((input.busy || input.background) && input.canStop) return { kind: 'stop', enabled: true, label: 'Stop' }
    return { kind: 'idle', enabled: false, label: idle }
  }
  if (input.disabled || input.picking) return { kind: 'blocked', enabled: false, label: idle }
  if (input.busy) {
    return input.queueing
      ? { kind: 'queue', enabled: true, label: 'Queue to send' }
      : { kind: 'blocked', enabled: false, label: idle }
  }
  return { kind: 'send', enabled: true, label: idle }
}

/** Input placeholder text. */
export function composerPlaceholder(input: { queueing: boolean; empty: boolean }): string {
  return input.queueing ? 'Add requirements; sends automatically after this turn ends' : input.empty ? 'Describe what you want to do…' : 'Continue…'
}

/** When the draft is exactly /model or /permissions (with no other materials), open "Run mode" instead. */
export function runShortcut(draft: string, hasMaterial: boolean): 'run' | null {
  if (hasMaterial) return null
  const text = draft.trim()
  return text === '/model' || text === '/permissions' ? 'run' : null
}

/* ───────────── Run mode sheet ───────────── */

export type TeamsSetting = 'on' | 'off' | 'unknown' | 'error'

export type RunSheetReasons = {
  /** Reason the permission choice is unavailable as a whole. */
  mode?: string
  /** Reason the "Plan" tier is unavailable (light tier). */
  plan?: string
  /** Reason model and thinking effort are unavailable. */
  runtime?: string
  /** Reason the team toggle is unavailable. */
  team?: string
}

/** Reasons items are greyed out: those from the page first, then light tier and computer settings limits. */
export function runSheetReasons(input: {
  lean: boolean
  teams: TeamsSetting
  disabled?: { mode?: string; runtime?: string; team?: string }
}): RunSheetReasons {
  const given = input.disabled ?? {}
  return {
    ...(given.mode ? { mode: given.mode } : {}),
    ...(input.lean ? { plan: 'The light tier does not support plan mode' } : {}),
    ...(given.runtime ? { runtime: given.runtime } : {}),
    ...(given.team
      ? { team: given.team }
      : input.lean
        ? { team: 'The light tier does not support teams' }
        : input.teams === 'off'
          ? { team: 'Enable teams in the computer settings first' }
          : input.teams === 'error'
            ? { team: 'Cannot read team settings from the computer right now' }
            : {}),
  }
}

/** Current description of the toggle: the reason when unavailable, otherwise a fixed description. */
export const teamNote = (reason?: string) => reason ?? 'Applies only to the next message'
export function computerNote(input: { supported: boolean | null; reason?: string }) {
  if (input.reason) return input.reason
  return input.supported === false ? 'Not supported on this computer yet' : 'Allow the agent to operate this computer’s screen and apps'
}

/** Model row: `provider · model`, showing only the other when one is missing. */
export function modelRowLabel(input: { source?: string; model?: string }): string {
  const parts = [input.source?.trim(), input.model?.trim()].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Computer default model'
}

/** Three thinking effort tiers (or the ones the model actually supports): given only when settable and the source is available. */
export function effortSegments(input: {
  canSetEffort: boolean
  authReady: boolean
  efforts?: string[]
}): { value: string; label: string }[] {
  if (!input.canSetEffort || !input.authReady) return []
  return (input.efforts ?? []).map((value) => ({ value, label: effortName(value) }))
}

/* ───────────── Thinking effort slider ───────────── */

/**
 * Configuration to commit when closing the run mode sheet: dragging only changes the draft in the sheet, and it is sent once on exit only if changed, 
 * so each slide does not change the computer configuration. When effort can no longer be changed in the sheet (turn started etc) the draft is discarded.
 */
export function effortToCommit<T extends { effortLevel?: string }>(input: {
  runtime?: T
  draft?: string
  blocked?: string
}): T | null {
  const { runtime, draft, blocked } = input
  if (!runtime || !draft || blocked || draft === runtime.effortLevel) return null
  return { ...runtime, effortLevel: draft }
}

/** X coordinate of the dot for tier index: half a thumb width is reserved at each end, so the thumb center sits exactly on the dot when resting on a tier. */
export function effortStopX(index: number, input: { width: number; count: number; thumb: number }): number {
  const span = Math.max(0, input.width - input.thumb)
  return input.thumb / 2 + (input.count > 1 ? (span * index) / (input.count - 1) : span / 2)
}

/** Nearest tier for a finger at x; beyond the ends counts as the ends. */
export function effortStopAt(x: number, input: { width: number; count: number; thumb: number }): number {
  if (input.count <= 1) return 0
  const span = Math.max(1, input.width - input.thumb)
  const ratio = Math.min(1, Math.max(0, (x - input.thumb / 2) / span))
  return Math.round(ratio * (input.count - 1))
}

/** The new-task-only "Run tier" group in the sheet. */
export type RunProfile = {
  value: 'standard' | 'lean'
  onChange(value: 'standard' | 'lean'): void
  disabled?: string
}

/**
 * After applying a run configuration, what the page should remember as the "selected model" (with display name and context window): 
 * use the new one if a new model was chosen; keep it if only thinking effort changed (no model passed) and the model is unchanged; clear it if the model changed without passing model.
 */
export function nextChosenModel<T extends { id: string }>(input: {
  picked?: T | null
  appliedModelId: string
  currentModelId?: string
  chosen: T | null
}): T | null {
  if (input.picked) return input.picked
  return input.appliedModelId === input.currentModelId ? input.chosen : null
}
