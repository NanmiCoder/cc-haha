import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from './client'
import {
  enableComposerBrowserUse,
  loadComposerBrowserUse,
  setComposerBrowserUseTarget,
  type BrowserPreferredTarget,
  type ComposerBrowserUseConfig,
} from './browserUse'
import { errorText } from '../ui/theme'

function isUnsupportedError(error: unknown): boolean {
  const status =
    error && typeof error === 'object' && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined
  return status === 403 || status === 404
}

/**
 * 「操作浏览器」开关的状态与动作。
 * 全局启用与目标浏览器存在电脑端，本条消息是否携带浏览器指令由输入框独立管理；
 * 取消或发送本条消息不会关闭电脑端的全局开关。
 */
export function useBrowserUse(client: ApiClient | null) {
  const [config, setConfig] = useState<ComposerBrowserUseConfig | null>(null)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [epoch, setEpoch] = useState(0)
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
    pendingSelection.current = null
    setConsent(false)
    setError('')
  }, [client])

  useEffect(() => {
    if (!client) return
    const controller = new AbortController()
    readRequest.current = controller
    const version = ++generation.current
    loadComposerBrowserUse(client, controller.signal)
      .then((value) => {
        if (controller.signal.aborted || version !== generation.current || mutating.current) return
        setConfig(value)
        setAvailable(true)
        setError('')
      })
      .catch((e) => {
        if (controller.signal.aborted || version !== generation.current || mutating.current) return
        if (isUnsupportedError(e)) {
          setAvailable(false)
          setError('')
          return
        }
        setError(errorText(e))
      })
    return () => controller.abort()
  }, [client, epoch])

  const refresh = useCallback(() => setEpoch((value) => value + 1), [])

  async function enableGlobally() {
    if (!client || busy || mutating.current) return
    readRequest.current?.abort()
    generation.current++
    mutating.current = true
    setBusy(true)
    setError('')
    try {
      const saved = await enableComposerBrowserUse(client)
      generation.current++
      if (!mounted.current) return
      setConfig(saved)
      setAvailable(true)
      setConsent(false)
      const selected = pendingSelection.current
      pendingSelection.current = null
      selected?.()
    } catch (e) {
      if (mounted.current) setError(errorText(e))
    } finally {
      mutating.current = false
      if (mounted.current) setBusy(false)
    }
  }

  async function setTarget(preferredTarget: BrowserPreferredTarget) {
    if (!client || !config || busy || mutating.current || config.preferredTarget === preferredTarget) return
    const previous = config
    readRequest.current?.abort()
    generation.current++
    mutating.current = true
    setConfig({ ...config, preferredTarget })
    setBusy(true)
    setError('')
    try {
      const saved = await setComposerBrowserUseTarget(client, preferredTarget)
      generation.current++
      if (!mounted.current) return
      setConfig(saved)
    } catch (e) {
      if (mounted.current) {
        setConfig(previous)
        setError(errorText(e))
      }
    } finally {
      mutating.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return {
    /** 电脑端 Browser Use 全局开关状态。 */
    enabled: config?.enabled ?? false,
    /** 电脑端首选浏览器目标。 */
    preferredTarget: config?.preferredTarget ?? ('auto' as BrowserPreferredTarget),
    /** 电脑端是否支持远程配置 Browser Use；尚未读取完成时为 null。 */
    available,
    busy,
    error,
    consentOpen: consent,
    refresh,
    /** 全局已开启时直接选中本条；未开启时先弹一次确认单。 */
    selectForMessage(onSelected: () => void) {
      if (!client || available !== true || busy) return
      if (config?.enabled) onSelected()
      else {
        pendingSelection.current = onSelected
        setConsent(true)
      }
    },
    confirmConsent: () => void enableGlobally(),
    cancelConsent() {
      if (!busy) {
        pendingSelection.current = null
        setConsent(false)
        setError('')
      }
    },
    setTarget: (target: BrowserPreferredTarget) => void setTarget(target),
  }
}

export type BrowserUse = ReturnType<typeof useBrowserUse>
