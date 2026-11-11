import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from './client'
import {
  loadComposerComputerUse,
  needsComputerPermission,
  openComputerPermissionCard,
  setComposerComputerUse,
  type ComposerComputerUse,
} from './computerUse'
import { errorText } from '../ui/theme'

/**
 * 「操作电脑」开关的状态与动作。它控制的是连着的这台电脑（所有会话共用），不是下一条消息。
 * 输入框的本条选择另存为 computer-use 技能引用；全局授权不会因发送或移除引用而关闭。
 */
export function useComputerUse(client: ApiClient | null) {
  const [status, setStatus] = useState<ComposerComputerUse | null>(null)
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [permission, setPermission] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const permissionRequest = useRef<AbortController | null>(null)
  const readRequest = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const mutating = useRef(false)
  const mounted = useRef(true)
  const pendingSelection = useRef<(() => void) | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      pendingSelection.current = null
    }
  }, [])
  useEffect(() => () => {
    permissionRequest.current?.abort()
    pendingSelection.current = null
  }, [client])
  useEffect(() => {
    if (!client) return
    const controller = new AbortController()
    readRequest.current = controller
    const version = ++generation.current
    loadComposerComputerUse(client, controller.signal)
      .then((value) => {
        if (controller.signal.aborted || version !== generation.current || mutating.current) return
        setStatus(value)
        setPermission(value.enabled && needsComputerPermission(value))
        setError('')
      })
      .catch((e) => {
        if (!controller.signal.aborted && version === generation.current && !mutating.current)
          setError(errorText(e))
      })
    return () => controller.abort()
  }, [client, epoch])

  /** 重新读取电脑上的状态（打开运行方式底单时调用）。 */
  const refresh = useCallback(() => setEpoch((value) => value + 1), [])

  async function apply(enabled: boolean) {
    if (!client || !status || busy || mutating.current) return
    readRequest.current?.abort()
    generation.current++
    mutating.current = true
    setBusy(true)
    setError('')
    try {
      await setComposerComputerUse(client, enabled)
      generation.current++
      if (!mounted.current) return
      setStatus({ ...status, enabled })
      setConsent(false)
      setPermission(enabled && needsComputerPermission(status))
      const selected = pendingSelection.current
      pendingSelection.current = null
      if (enabled) selected?.()
    } catch (e) {
      if (mounted.current) setError(errorText(e))
    } finally {
      mutating.current = false
      if (mounted.current) setBusy(false)
    }
  }

  function openPermissionCard() {
    if (!client) return
    const controller = new AbortController()
    permissionRequest.current?.abort()
    permissionRequest.current = controller
    setBusy(true)
    void openComputerPermissionCard(client, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return
        setStatus(value)
        setPermission(value.enabled && needsComputerPermission(value))
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e))
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
  }

  return {
    /** 全局授权状态，与本条消息的技能选择独立。 */
    enabled: status?.enabled ?? false,
    /** 这台电脑是否支持；还没读到时是 null。 */
    supported: status ? status.supported : (null as boolean | null),
    busy,
    error,
    /** 已开启，但还要在电脑上完成系统授权。 */
    needsPermission: permission,
    /** 开启前的确认单是否打开。 */
    consentOpen: consent,
    refresh,
    /** Already-consented computers can be selected without another prompt. */
    selectForMessage(onSelected: () => void) {
      if (!client || !status?.supported || busy) return
      if (status.enabled) onSelected()
      else {
        pendingSelection.current = onSelected
        setConsent(true)
      }
    },
    /** 打开开关要先经过确认；关闭立即生效。 */
    toggle(next: boolean) {
      if (next) setConsent(true)
      else void apply(false)
    },
    confirmConsent: () => void apply(true),
    cancelConsent() {
      if (!busy) {
        pendingSelection.current = null
        setConsent(false)
      }
    },
    openPermissionCard,
  }
}
export type ComputerUse = ReturnType<typeof useComputerUse>
