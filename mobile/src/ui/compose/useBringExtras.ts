import { useEffect, useState } from 'react'
import type { ApiClient } from '../../core/client'
import { normalizeConnectors } from '../../core/connectors'
import { normalizeAgents, normalizeWorkflows, type BringExtrasData } from './bringModel'

/** null 表示这一类拿不到（接口没放行、电脑不支持、网络错误）：对应的入口行直接不显示。 */
export type BringExtras = BringExtrasData
const none: BringExtras = { agents: null, connectors: null, workflows: null }

type Getter = Pick<ApiClient, 'get'>

/**
 * 三类目录各自读一次，互不影响：一个失败只让它自己变成 null。
 * 每读完一类就通知一次，先到的先显示。
 */
export function loadBringExtras(
  client: Getter,
  workDir: string | undefined,
  signal: AbortSignal,
  onPart: <K extends keyof BringExtras>(key: K, value: BringExtras[K]) => void
): Promise<unknown> {
  const options = { signal }
  const cwd = workDir ? `?cwd=${encodeURIComponent(workDir)}` : ''
  const settle = <K extends keyof BringExtras>(key: K, path: string, normalize: (value: unknown) => BringExtras[K]) =>
    client
      .get<unknown>(path, options)
      .then(normalize, () => null as BringExtras[K])
      .then((value) => {
        if (!signal.aborted) onPart(key, value)
      })
  return Promise.all([
    settle('agents', `/api/agents${cwd}`, normalizeAgents),
    settle('connectors', '/api/connectors', normalizeConnectors),
    settle('workflows', `/api/workflows${cwd}`, normalizeWorkflows),
  ])
}

/**
 * 连接器、Agent、工作流这三类的目录。服务端对远程手机只放行只读的列表，
 * 旧版电脑可能没有这些接口，所以每次打开底单都各自读一次，成功才显示，失败就当没有。
 */
export function useBringExtras(client: ApiClient | null, workDir: string | undefined, active: boolean) {
  const [extras, setExtras] = useState<BringExtras>(none)
  useEffect(() => {
    if (!client || !active) return
    const controller = new AbortController()
    void loadBringExtras(client, workDir, controller.signal, (key, value) =>
      setExtras((previous) => ({ ...previous, [key]: value }))
    )
    return () => controller.abort()
  }, [client, workDir, active])
  return client ? extras : none
}
