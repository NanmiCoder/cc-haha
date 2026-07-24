import { baselineCases } from './baseline/cases'
import type { BaselineTarget, LaneDefinition, QualityGateMode } from './types'

export function currentPackageSmokePlatform(platform: NodeJS.Platform = process.platform) {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  if (platform === 'linux') return 'linux'
  return null
}

export function currentPackageSmokeArch(arch: NodeJS.Architecture = process.arch) {
  return arch === 'arm64' || arch === 'x64' ? arch : null
}

export function currentReleaseArtifactsDir(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
) {
  if (platform === 'darwin') return arch === 'x64' ? 'desktop/build-artifacts/macos-x64' : 'desktop/build-artifacts/macos-arm64'
  if (platform === 'win32') return arch === 'arm64' ? 'desktop/build-artifacts/windows-arm64' : 'desktop/build-artifacts/windows-x64'
  if (platform === 'linux') return arch === 'arm64' ? 'desktop/build-artifacts/linux-arm64' : 'desktop/build-artifacts/linux-x64'
  return null
}

export function lanesForMode(mode: QualityGateMode, baselineTargets: BaselineTarget[] = []): LaneDefinition[] {
  const packageSmokePlatform = currentPackageSmokePlatform()
  const packageSmokeArch = currentPackageSmokeArch()
  const releaseArtifactsDir = currentReleaseArtifactsDir()
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
      requiredForModes: ['pr', 'release'],
      category: 'unit',
    },
    {
      id: 'server-checks',
      title: 'Server checks',
      description: 'Run server, provider, runtime, MCP, OAuth, WebSocket, and API tests when server paths changed.',
      kind: 'command',
      command: ['bun', 'run', 'check:server'],
      impactRequiredCheck: 'bun run check:server',
      requiredForModes: ['pr', 'release'],
      category: 'unit',
    },
    {
      id: 'provider-contract-checks',
      title: 'Provider contract checks',
      description: 'Validate provider persistence, runtime env, proxy request/response transforms, streaming, and network failure semantics without live credentials.',
      kind: 'command',
      command: ['bun', 'run', 'check:provider-contract'],
      impactRequiredCheck: 'bun run check:provider-contract',
      requiredForModes: ['pr', 'release'],
      category: 'integration',
    },
    {
      id: 'chat-contract-checks',
      title: 'Desktop/server chat contract checks',
      description: 'Exercise WebSocket, first-turn runtime selection, reconnect, and mock CLI integration without a real model.',
      kind: 'command',
      command: ['bun', 'run', 'check:chat-contract'],
      impactRequiredCheck: 'bun run check:chat-contract',
      requiredForModes: ['pr', 'release'],
      category: 'integration',
    },
    {
      id: 'adapter-checks',
      title: 'Adapter checks',
      description: 'Run adapter tests when IM adapter paths changed.',
      kind: 'command',
      command: ['bun', 'run', 'check:adapters'],
      impactRequiredCheck: 'bun run check:adapters',
      requiredForModes: ['pr', 'release'],
      category: 'unit',
    },
    {
      id: 'native-checks',
      title: 'Native desktop checks',
      description: 'Build sidecars and run Electron main/preload checks when native or packaging paths changed.',
      kind: 'command',
      command: ['bun', 'run', 'check:native'],
      impactRequiredCheck: 'bun run check:native',
      requiredForModes: ['pr', 'release'],
      category: 'native',
    },
    {
      id: 'docs-checks',
      title: 'Docs checks',
      description: 'Install, build, and validate the React site when docs or site paths change.',
      kind: 'command',
      command: ['bun', 'run', 'check:docs'],
      impactRequiredCheck: 'bun run check:docs',
      requiredForModes: ['pr', 'release'],
      category: 'docs',
    },
    {
      id: 'persistence-upgrade',
      title: 'Persistence upgrade checks',
      description: 'Validate local JSON and desktop localStorage migrations against old-version fixtures.',
      kind: 'command',
      command: ['bun', 'run', 'check:persistence-upgrade'],
      impactRequiredCheck: 'bun run check:persistence-upgrade',
      requiredForModes: ['pr', 'release'],
      category: 'governance',
    },
    {
      id: 'quarantine',
      title: 'Quarantine governance',
      description: 'Validate quarantined tests still have owners, exit criteria, and active review windows.',
      kind: 'command',
      command: ['bun', 'run', 'check:quarantine'],
      requiredForModes: ['baseline', 'release'],
      category: 'governance',
    },
    {
      id: 'coverage',
      title: 'Coverage gate',
      description: 'Run unit/component coverage suites and enforce the ratcheted coverage baseline.',
      kind: 'command',
      command: ['bun', 'run', 'check:coverage'],
      impactRequiredCheck: 'bun run check:coverage',
      requiredForModes: ['pr', 'baseline', 'release'],
      category: 'coverage',
    },
    {
      id: 'baseline-catalog',
      title: 'Baseline case catalog validation',
      description: 'Validate real Coding Agent baseline case definitions and fixture metadata.',
      kind: 'command',
      command: ['bun', 'test', './scripts/quality-gate/baseline/cases.test.ts'],
      requiredForModes: ['baseline', 'release'],
      category: 'unit',
    },
  ]

  if (packageSmokePlatform && releaseArtifactsDir) {
    const packageSmokeCommand = ['bun', 'run', 'test:package-smoke', '--platform', packageSmokePlatform, '--package-kind', 'release', '--artifacts-dir', releaseArtifactsDir]
    if (packageSmokeArch) {
      packageSmokeCommand.push('--arch', packageSmokeArch)
    }
    if (packageSmokePlatform === 'macos') {
      packageSmokeCommand.push('--require-macos-gatekeeper')
    }

    lanes.push({
      id: `desktop-package-smoke:${packageSmokePlatform}`,
      title: `Desktop packaged artifact smoke (${packageSmokePlatform})`,
      description: 'Inspect the current-platform canonical Electron release artifact for app metadata, app.asar, sidecar binaries, update metadata, and unpacked native runtime resources. GUI behavior is verified separately with Computer Use against the real packaged app.',
      kind: 'command',
      command: packageSmokeCommand,
      requiredForModes: ['release'],
      category: 'smoke',
    })
  }

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
      description: 'Open the desktop web app with agent-browser, send a real chat task, and verify the model edits a fixture project through the UI. This remains a browser/web-app confidence lane; Electron packaged-app acceptance is covered by package-smoke plus manual Computer Use evidence.',
      kind: 'desktop-smoke',
      baselineTarget: target,
      requiredForModes: ['baseline'],
      category: 'smoke',
      live: true,
    })
  }

  return lanes.filter((lane) => lane.requiredForModes.includes(mode))
}
