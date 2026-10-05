import type { ActivityStatus } from './sessionActivityModel'
import mascotBuild from '../../assets/agent-mascots/agent-mascot-build.png'
import mascotCheck from '../../assets/agent-mascots/agent-mascot-check.png'
import mascotCode from '../../assets/agent-mascots/agent-mascot-code.png'
import mascotData from '../../assets/agent-mascots/agent-mascot-data.png'
import mascotDesign from '../../assets/agent-mascots/agent-mascot-design.png'
import mascotDocs from '../../assets/agent-mascots/agent-mascot-docs.png'
import mascotFix from '../../assets/agent-mascots/agent-mascot-fix.png'
import mascotPlan from '../../assets/agent-mascots/agent-mascot-plan.png'
import mascotRelease from '../../assets/agent-mascots/agent-mascot-release.png'
import mascotSearch from '../../assets/agent-mascots/agent-mascot-search.png'
import mascotShield from '../../assets/agent-mascots/agent-mascot-shield.png'
import mascotTerminal from '../../assets/agent-mascots/agent-mascot-terminal.png'

export const AGENT_MASCOT_VARIANTS = [
  'code',
  'check',
  'plan',
  'shield',
  'docs',
  'terminal',
  'search',
  'release',
  'build',
  'fix',
  'design',
  'data',
] as const

export type AgentMascotVariant = typeof AGENT_MASCOT_VARIANTS[number]

export type AgentMascotSpec = {
  seed: string
  variant: AgentMascotVariant
  state: ActivityStatus
  motion: 'active' | 'still'
  tone: 'accent' | 'success' | 'danger' | 'muted'
}

const MASCOT_IMAGE_BY_VARIANT: Record<AgentMascotVariant, string> = {
  build: mascotBuild,
  check: mascotCheck,
  code: mascotCode,
  data: mascotData,
  design: mascotDesign,
  docs: mascotDocs,
  fix: mascotFix,
  plan: mascotPlan,
  release: mascotRelease,
  search: mascotSearch,
  shield: mascotShield,
  terminal: mascotTerminal,
}

export function stableAgentMascotHash(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash)
}

export function resolveAgentMascotSpec({
  seed,
  status,
}: {
  seed: string
  status: ActivityStatus
}): AgentMascotSpec {
  const normalizedSeed = seed.trim() || 'agent'
  const isRunning = status === 'running' || status === 'in_progress'
  const isComplete = status === 'completed' || status === 'idle'
  const isFailed = status === 'failed' || status === 'error' || status === 'stopped'

  return {
    seed: normalizedSeed,
    variant: AGENT_MASCOT_VARIANTS[stableAgentMascotHash(normalizedSeed) % AGENT_MASCOT_VARIANTS.length] ?? 'code',
    state: status,
    motion: isRunning ? 'active' : 'still',
    tone: isFailed ? 'danger' : isComplete ? 'success' : isRunning ? 'accent' : 'muted',
  }
}

function ringClassName(tone: AgentMascotSpec['tone']): string {
  if (tone === 'danger') return 'border-[color-mix(in_srgb,var(--color-error)_42%,transparent)]'
  if (tone === 'success') return 'border-[color-mix(in_srgb,var(--color-success)_34%,transparent)]'
  if (tone === 'muted') return 'border-[color-mix(in_srgb,var(--color-text-tertiary)_24%,transparent)]'
  // Running is information, not brand: the app reads blue as "in progress".
  return 'border-[color-mix(in_srgb,var(--color-info)_42%,transparent)]'
}

export function AgentMascot({ seed, status }: { seed: string; status: ActivityStatus }) {
  const spec = resolveAgentMascotSpec({ seed, status })
  const isActive = spec.motion === 'active'
  const imageSrc = MASCOT_IMAGE_BY_VARIANT[spec.variant]

  return (
    <span
      data-testid="agent-mascot"
      data-agent-mascot-seed={spec.seed}
      data-agent-mascot-variant={spec.variant}
      data-agent-mascot-state={spec.state}
      data-agent-mascot-motion={spec.motion}
      data-agent-mascot-tone={spec.tone}
      data-agent-mascot-src={imageSrc}
      className={`relative inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[var(--radius-md)] border bg-[var(--color-surface-container)] ${ringClassName(spec.tone)}`}
      aria-hidden="true"
    >
      {isActive ? (
        <span
          data-testid="agent-mascot-motion-ring"
          className="absolute -inset-0.5 rounded-[var(--radius-lg)] border border-transparent border-t-[var(--color-info)] opacity-80 motion-safe:animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : null}
      <img
        src={imageSrc}
        alt=""
        draggable={false}
        className="relative h-[34px] w-[34px] max-w-none select-none object-contain"
      />
    </span>
  )
}
