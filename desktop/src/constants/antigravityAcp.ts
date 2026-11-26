import type { PermissionMode, ReasoningEffortLevel } from '../types/settings'

export const ANTIGRAVITY_ACP_PROVIDER_ID = 'antigravity-acp'
export const ANTIGRAVITY_ACP_DEFAULT_MODEL_ID = 'agent-default'
export const ANTIGRAVITY_ACP_LOGIN_COMMAND = 'agy acp --login'

export const ANTIGRAVITY_ACP_DEFAULT_EFFORTS: readonly ReasoningEffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
]

export const ANTIGRAVITY_ACP_PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'auto',
  'plan',
]

/** Host UI commands that remain handled by cc-haha inside Antigravity sessions. */
export const ANTIGRAVITY_HOST_UI_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  'model',
  'config',
  'settings',
  'clear',
])

/** Default Antigravity native slash commands offered in the draft composer before session/new reports its authoritative list. */
export const ANTIGRAVITY_DRAFT_SLASH_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'swarm', description: 'Coordinate multiple Antigravity agents on a shared board' },
  { name: 'plan', description: 'Plan a complex task before editing' },
  { name: 'boost', description: 'Apply extra reasoning depth to the task' },
  { name: 'teamwork', description: 'Collaborate across specialized agent roles' },
  { name: 'goal', description: 'Run a long-running task until the goal is achieved' },
  { name: 'grill-me', description: 'Align on design decisions through an interactive interview' },
  { name: 'compact', description: 'Compact conversation context' },
  { name: 'browser', description: 'Use browser automation tools' },
  { name: 'schedule', description: 'Schedule a one-shot timer or recurring task' },
  { name: 'learn', description: 'Persist a correction or setup for future tasks' },
  { name: 'model', description: 'Switch Antigravity model and thinking level' },
  { name: 'config', description: 'Open configuration' },
  { name: 'clear', description: 'Clear conversation history' },
]

export function isAntigravityProviderId(providerId: string | null | undefined): boolean {
  return providerId === ANTIGRAVITY_ACP_PROVIDER_ID
}
