import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk/core'
import type { ComputerUseHostAdapter, ComputerUseSessionContext } from '../../vendor/computer-use-mcp/types.js'
import { bindSessionContext, buildPlatformComputerUseTools } from '../../vendor/computer-use-mcp/mcpServer.js'
import { loadStoredComputerUseConfig } from '../../utils/computerUse/preauthorizedConfig.js'

type Settings = Awaited<ReturnType<typeof loadStoredComputerUseConfig>>
type Dependencies = {
  adapter?: ComputerUseHostAdapter
  loadSettings?: () => Promise<Settings>
  checkLock?: () => Promise<{ holder: string | undefined; isSelf: boolean }>
  acquireLock?: () => Promise<void>
  release?: () => Promise<void>
}

/** The same native dispatcher, Settings consent and OS grants as the desktop CLI. */
export async function createOfficialAgentSdkComputer(deps: Dependencies = {}): Promise<{
  server: McpSdkServerConfigWithInstance
  onTurnEnd(): Promise<void>
  close(): Promise<void>
}> {
  const loadSettings = deps.loadSettings ?? loadStoredComputerUseConfig
  let settings = await loadSettings()
  const base = deps.adapter ?? (await import('../../utils/computerUse/hostAdapter.js')).getComputerUseHostAdapter()
  let closed = false
  const adapter: ComputerUseHostAdapter = {
    ...base,
    // Re-read before each call; the retained getter also stops an executing
    // JavaScript cell as soon as a Settings change is observed by the poller.
    isDisabled: () => closed || !settings.enabled || base.isDisabled(),
  }
  const locks = deps.checkLock && deps.acquireLock ? undefined : await import('../../utils/computerUse/computerUseLock.js')
  const context: ComputerUseSessionContext = {
    getAllowedApps: () => [],
    getGrantFlags: () => settings.grantFlags,
    getUserDeniedBundleIds: () => [],
    getSelectedDisplayId: () => undefined,
    checkCuLock: deps.checkLock ?? (async () => {
      const lock = await locks!.checkComputerUseLock()
      return { holder: lock.kind === 'blocked' ? lock.by : lock.kind === 'held_by_self' ? 'self' : undefined, isSelf: lock.kind === 'held_by_self' }
    }),
    acquireCuLock: deps.acquireLock ?? (async () => {
      const lock = await locks!.tryAcquireComputerUseLock()
      if (lock.kind === 'blocked') throw new Error(`Computer Use is held by session ${lock.by}`)
    }),
    isAborted: () => closed,
  }
  const dispatch = bindSessionContext(adapter, 'pixels', context)
  const instance = new McpServer({ name: 'cc_haha_computer', version: '1.0.0' }, { capabilities: { tools: {} } })
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => {
    settings = await loadSettings()
    return { tools: adapter.isDisabled() ? [] : buildPlatformComputerUseTools(adapter.executor.capabilities, 'pixels') }
  })
  instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    settings = await loadSettings()
    if (adapter.isDisabled()) return { isError: true, content: [{ type: 'text', text: 'Computer Use is disabled. Enable it and confirm consent in cc-hh Settings first.' }] }
    const poll = setInterval(() => {
      void loadSettings().then(value => { settings = value }, () => { settings = { ...settings, enabled: false } })
    }, 250)
    poll.unref?.()
    try {
      const { screenshot: _screenshot, telemetry: _telemetry, ...result } = await dispatch(request.params.name, request.params.arguments ?? {}, extra.signal)
      return result
    } finally { clearInterval(poll) }
  })
  const onTurnEnd = deps.release ?? (async () => {
    const [{ overlayHide }, { hideCursorBadge }] = await Promise.all([
      import('../../utils/computerUse/cuHelperDaemon.js'), import('../../utils/computerUse/winCursorBadge.js'),
    ])
    hideCursorBadge()
    await overlayHide().catch(() => {})
    await locks!.releaseComputerUseLock()
  })
  return {
    server: { type: 'sdk', name: 'cc_haha_computer', instance },
    onTurnEnd,
    async close() {
      if (closed) return
      closed = true
      await dispatch('js_reset', {}).catch(() => {})
      await onTurnEnd()
      await instance.close()
    },
  }
}
