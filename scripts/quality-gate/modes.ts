import { baselineCases } from './baseline/cases'
import type { BaselineTarget, LaneDefinition, QualityGateMode } from './types'

export function lanesForMode(mode: QualityGateMode, baselineTargets: BaselineTarget[] = []): LaneDefinition[] {
  const lanes: LaneDefinition[] = [
    {
      id: 'impact-report',
      title: 'Impact report',
      description: 'Summarize changed areas, required local checks, and risk notes.',
      kind: 'command',
      command: ['bun', 'run', 'check:impact'],
      requiredForModes: ['pr', 'baseline', 'release'],
      category: 'scope',
    },
    {
      id: 'policy-checks',
      title: 'Policy checks',
      description: 'Run policy, workflow, hook, quarantine, and gate unit tests when any PR quality policy applies.',
      kind: 'command',
      command: ['bun', 'run', 'check:policy'],
      impactRequiredCheck: 'bun run check:policy',
      requiredForModes: ['pr', 'release'],
      category: 'governance',
    },
    {
      id: 'desktop-checks',
      title: 'Desktop checks',
      description: 'Run desktop lint, Vitest, and production build when desktop paths changed.',
      kind: 'command',
      command: ['bun', 'run', 'check:desktop'],
      impactRequiredCheck: 'bun run check:desktop',
      requiredForModes: ['pr'],
      category: 'unit',
    },
    {
      id: 'server-checks',
      title: 'Server checks',
      description: 'Run server, provider, runtime, MCP, OAuth, WebSocket, and API tests when server paths changed.',
      kind: 'command',
      command: ['bun', 'run', 'check:server'],
      impactRequiredCheck: 'bun run check:server',
      requiredForModes: ['pr'],
      category: 'unit',
    },
    {
      id: 'adapter-checks',
      title: 'Adapter checks',
      description: 'Run adapter tests when IM adapter paths changed.',
      kind: 'command',
      command: ['bun', 'run', 'check:adapters'],
      impactRequiredCheck: 'bun run check:adapters',
      requiredForModes: ['pr'],
      category: 'unit',
    },
    {
      id: 'native-checks',
      title: 'Native desktop checks',
      description: 'Build sidecars and run the Tauri native compile check when native or packaging paths changed.',
      kind: 'command',
      command: ['bun', 'run', 'check:native'],
      impactRequiredCheck: 'bun run check:native',
      requiredForModes: ['pr', 'release'],
      category: 'native',
    },
    {
      id: 'docs-checks',
      title: 'Docs checks',
      description: 'Run docs install and VitePress build when docs paths changed.',
      kind: 'command',
      command: ['bun', 'run', 'check:docs'],
      impactRequiredCheck: 'bun run check:docs',
      requiredForModes: ['pr'],
      category: 'docs',
    },
    {
      id: 'persistence-upgrade',
      title: 'Persistence upgrade checks',
      description: 'Validate local JSON and desktop localStorage migrations against old-version fixtures.',
      kind: 'command',
      command: ['bun', 'run', 'check:persistence-upgrade'],
      requiredForModes: ['pr', 'release'],
      category: 'governance',
    },
    {
      id: 'quarantine',
      title: 'Quarantine governance',
      description: 'Validate quarantined tests still have owners, exit criteria, and active review windows.',
      kind: 'command',
      command: ['bun', 'run', 'check:quarantine'],
      requiredForModes: ['pr', 'baseline', 'release'],
      category: 'governance',
    },
    {
      id: 'coverage',
      title: 'Coverage gate',
      description: 'Run unit/component coverage suites and enforce the ratcheted coverage baseline.',
      kind: 'command',
      command: ['bun', 'run', 'check:coverage'],
      requiredForModes: ['pr', 'baseline', 'release'],
      category: 'coverage',
    },
    {
      id: 'baseline-catalog',
      title: 'Baseline case catalog validation',
      description: 'Validate real Coding Agent baseline case definitions and fixture metadata.',
      kind: 'command',
      command: ['bun', 'test', 'scripts/quality-gate/baseline/cases.test.ts'],
      requiredForModes: ['baseline', 'release'],
      category: 'unit',
    },
  ]

  const targets = baselineTargets.length > 0
    ? baselineTargets
    : [{ providerId: null, modelId: 'current', label: 'current-runtime' }]

  for (const testCase of baselineCases) {
    for (const target of targets) {
      const targetSlug = target.label.replace(/[^a-zA-Z0-9._-]+/g, '-')
      lanes.push({
        id: `baseline:${testCase.id}:${targetSlug}`,
        title: `${testCase.title} (${target.label})`,
        description: testCase.description,
        kind: 'baseline-case',
        baselineCaseId: testCase.id,
        baselineTarget: target,
        requiredForModes: ['baseline', 'release'],
        category: 'integration',
        live: true,
      })
    }
  }

  for (const target of targets) {
    const targetSlug = target.label.replace(/[^a-zA-Z0-9._-]+/g, '-')
    lanes.push({
      id: `provider-smoke:${targetSlug}`,
      title: `Provider live/proxy smoke (${target.label})`,
      description: 'Validate live provider connectivity. Saved or active OpenAI-compatible providers also exercise the local non-stream and streaming proxy endpoints; env-only targets validate upstream connectivity and transform pipeline.',
      kind: 'provider-smoke',
      baselineTarget: target,
      requiredForModes: ['baseline', 'release'],
      category: 'smoke',
      live: true,
    })
  }

  for (const target of targets) {
    const targetSlug = target.label.replace(/[^a-zA-Z0-9._-]+/g, '-')
    lanes.push({
      id: `desktop-smoke:agent-browser-chat:${targetSlug}`,
      title: `Desktop agent-browser chat smoke (${target.label})`,
      description: 'Open the desktop web app with agent-browser, send a real chat task, and verify the model edits a fixture project through the UI.',
      kind: 'desktop-smoke',
      baselineTarget: target,
      requiredForModes: ['baseline', 'release'],
      category: 'smoke',
      live: true,
    })
  }

  return lanes.filter((lane) => lane.requiredForModes.includes(mode))
}
