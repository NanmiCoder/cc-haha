import { useEffect, useState } from 'react'
import type { NetworkManagerApi, SakuraDiscovery } from './networkTypes'

/** An old port/profile request must never overwrite a newer editing session. */
export function useSakuraDiscovery(api: NetworkManagerApi, proxyPort: number | undefined) {
  const [discovery, setDiscovery] = useState<SakuraDiscovery | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState(false)
  const [refreshId, setRefreshId] = useState(0)
  useEffect(() => {
    let active = true
    setDiscovery(null)
    setError(false)
    if (!proxyPort || !Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
      setDetecting(false)
      return () => { active = false }
    }
    setDetecting(true)
    void api.discoverProxy(proxyPort).then(result => {
      if (!active) return
      if (result.ok && result.data.proxyPort === proxyPort) setDiscovery(result.data)
      else setError(true)
    }).catch(() => { if (active) setError(true) }).finally(() => { if (active) setDetecting(false) })
    return () => { active = false }
  }, [api, proxyPort, refreshId])
  return { discovery: discovery?.proxyPort === proxyPort ? discovery : null, detecting, error,
    refresh: () => { setDetecting(true); setRefreshId(value => value + 1) } }
}
