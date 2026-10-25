import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TEAM_SMOKE_MODEL, TEAM_SMOKE_PROVIDER } from './team-plan'

type BrowserStep = (args: string[], options?: { timeoutMs?: number; allowFailure?: boolean }) => Promise<{ stdout: string; stderr: string }>

export const AGENT_PROVIDER_SMOKE_OVERRIDE_SELECTOR = 'button[aria-label="Adjust the model and effort for Explore"]'
export const AGENT_PROVIDER_SMOKE_PROVIDER_SELECTOR = 'select[aria-label="Provider"]'

/** Exercise the real settings form; every write stays in the lane's disposable config. */
export async function runDesktopUiAgentProviderSmoke(options: {
  baseUrl: string; projectDir: string; artifactDir: string; browserStep: BrowserStep
}) {
  const { baseUrl, projectDir, artifactDir, browserStep } = options
  const readAgent = async () => {
    const response = await fetch(`${baseUrl}/api/agents?cwd=${encodeURIComponent(projectDir)}`)
    if (!response.ok) throw new Error(`Agent list failed with HTTP ${response.status}`)
    const { allAgents } = await response.json() as { allAgents: Array<{ agentType: string; source: string; model?: string; override?: { providerId?: string; model?: string } }> }
    const agent = allAgents.find(item => item.agentType === 'Explore' && item.source === 'built-in')
    if (!agent) throw new Error('The Explore built-in is missing from the smoke fixture')
    return agent
  }
  const activeProvider = async () => {
    const response = await fetch(`${baseUrl}/api/providers`)
    if (!response.ok) throw new Error(`Provider list failed with HTTP ${response.status}`)
    return (await response.json() as { activeId: string | null }).activeId
  }
  const before = await readAgent()
  const originalActiveProvider = await activeProvider()
  const waitForAgent = async (predicate: (agent: Awaited<ReturnType<typeof readAgent>>) => boolean, label: string) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const agent = await readAgent()
      if (predicate(agent)) return agent
      await Bun.sleep(250)
    }
    throw new Error(`Timed out waiting for agent provider smoke: ${label}`)
  }
  const save = async () => {
    await browserStep(['find', 'role', 'button', 'click', '--name', 'Save', '--exact'])
    await browserStep(['wait', '--fn', '!document.querySelector("[role=dialog]")'])
  }
  const openOverride = async () => {
    const detail = await browserStep(['eval', `Array.from(document.querySelectorAll('button')).some(button => button.textContent?.trim() === 'Back to list')`])
    if (detail.stdout.trim() === 'true') {
      await browserStep(['scroll', 'up', '3000', '--selector', 'div:has(> [data-testid="settings-page-frame"])'])
      await browserStep(['find', 'role', 'button', 'click', '--name', 'Back to list', '--exact'])
    }
    await browserStep(['wait', AGENT_PROVIDER_SMOKE_OVERRIDE_SELECTOR])
    await browserStep(['scrollintoview', AGENT_PROVIDER_SMOKE_OVERRIDE_SELECTOR])
    await browserStep(['click', AGENT_PROVIDER_SMOKE_OVERRIDE_SELECTOR])
    await browserStep(['wait', '--fn', `document.querySelector(${JSON.stringify(AGENT_PROVIDER_SMOKE_PROVIDER_SELECTOR)})?.disabled === false`])
  }

  // The browser fallback intentionally shows the H5 settings surface, which
  // does not contain Agents. Supply only the native-host presentation seam;
  // provider configuration and every request still use the real local server.
  await browserStep(['eval', `(async () => {
    const { browserHost } = await import('/src/lib/desktopHost/browserHost.ts')
    window.desktopHost = {
      ...browserHost, kind: 'electron', isDesktop: true,
      runtime: { getServerUrl: async () => ${JSON.stringify(baseUrl)}, getLocalAccessToken: async () => null },
    }
  })()`])
  await browserStep(['click', '[data-testid="sidebar-settings-dock"] button[aria-label="Settings"]'])
  await browserStep(['wait', '[data-testid="settings-page-frame"]'])
  await browserStep(['find', 'role', 'button', 'click', '--name', 'Agents', '--exact'])
  await openOverride()
  await browserStep(['select', AGENT_PROVIDER_SMOKE_PROVIDER_SELECTOR, TEAM_SMOKE_PROVIDER])
  await browserStep(['click', 'button[aria-label="Model"]'])
  await browserStep(['wait', '[data-testid="model-selector-dropdown"]'])
  const filtered = await browserStep(['get', 'text', '[data-testid="model-selector-dropdown"]'])
  if (!filtered.stdout.includes(TEAM_SMOKE_MODEL) || filtered.stdout.includes('desktop-ui-smoke-model')) {
    throw new Error('The built-in agent model picker did not filter to the selected provider')
  }
  await browserStep(['find', 'text', TEAM_SMOKE_MODEL, 'click', '--exact'])
  await browserStep(['screenshot', join(artifactDir, 'agent-provider-selected.png')])
  await save()
  const explicit = await waitForAgent(agent => agent.override?.providerId === TEAM_SMOKE_PROVIDER && agent.override.model === TEAM_SMOKE_MODEL, 'explicit provider/model save')

  await openOverride()
  await browserStep(['click', 'button[aria-label="Model"]'])
  await browserStep(['find', 'text', 'Provider default model', 'click', '--exact'])
  await save()
  const providerOnly = await waitForAgent(agent => agent.override?.providerId === TEAM_SMOKE_PROVIDER && agent.override.model === undefined, 'provider-only default model save')
  const listText = await browserStep(['get', 'text', '[data-testid="settings-page-frame"]'])
  if (!listText.stdout.includes('Provider default model')) throw new Error('The agent list did not display the provider default model label')
  await browserStep(['screenshot', join(artifactDir, 'agent-provider-default.png')])

  await openOverride()
  await browserStep(['find', 'role', 'button', 'click', '--name', 'Reset to built-in default', '--exact'])
  await browserStep(['wait', '--fn', '!document.querySelector("[role=dialog]")'])
  const reset = await waitForAgent(agent => agent.override === undefined && agent.model === before.model, 'built-in reset')
  if (await activeProvider() !== originalActiveProvider) throw new Error('Editing an agent changed the global provider')
  writeFileSync(join(artifactDir, 'agent-provider-result.json'), JSON.stringify({ before, explicit, providerOnly, reset, globalProviderUnchanged: true }, null, 2))
  await browserStep(['screenshot', join(artifactDir, 'agent-provider-reset.png')])
  await browserStep(['eval', 'delete window.desktopHost'])
}
