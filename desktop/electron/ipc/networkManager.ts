import { NetworkRequestSchema } from '../../src/features/network-manager/networkSchemas'
import type { NetworkManagerApi } from '../../src/features/network-manager/networkTypes'

type Sender = { mainFrame: unknown }
type NetworkIpcEvent = { sender: Sender; senderFrame: unknown }

/** A website, child frame or auxiliary window cannot operate the local network. */
export function createNetworkManagerHandler(options: {
  getMainWebContents(): Sender | null
  getService(): NetworkManagerApi
}) {
  return async (event: NetworkIpcEvent, raw: unknown) => {
    if (!options.getMainWebContents() || event.sender !== options.getMainWebContents()
      || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Network management requires the main desktop window')
    }
    const parsed = NetworkRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: { code: 'INVALID_INPUT', message: 'Invalid network configuration request' } }
    const service = options.getService()
    const input = parsed.data
    switch (input.action) {
      case 'discoverProxy': return service.discoverProxy(input.proxyPort)
      case 'executionCatalog': return service.executionCatalog()
      case 'openNetworkConnections': return service.openNetworkConnections()
      case 'list': return service.list()
      case 'save': return service.save(input.profile, input.expectedRevision)
      case 'inspect': return service.inspect(input.profile)
      case 'plan': return service.plan(input.profile)
      case 'apply': return service.apply(input.planId)
      case 'recover': return service.recover()
      case 'verify': return service.verify(input.profile)
      case 'probeHost': return service.probeHost(input.hostId)
      case 'login': return service.login(input.target, input.profile)
      case 'vpnRouteOptions': return service.vpnRouteOptions()
      case 'vpnRoutePreview': return service.vpnRoutePreview(input.target)
      case 'vpnRouteApply': return service.vpnRouteApply(input.planId)
      case 'vpnRouteVerify': return service.vpnRouteVerify(input.target)
      case 'vpnRouteBatchPreview': return service.vpnRouteBatchPreview(input.input)
      case 'vpnRouteBatchApply': return service.vpnRouteBatchApply(input.planId)
      case 'vpnRouteBatchVerify': return service.vpnRouteBatchVerify(input.input)
      case 'vpnRouteProbe': return service.vpnRouteProbe(input.input)
    }
  }
}
