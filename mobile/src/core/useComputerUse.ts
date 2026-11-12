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
 * State and actions of the "Computer use" toggle. It controls the connected computer (shared by all sessions), not the next message.
 * The input's choice for this message is saved separately as a computer-use skill reference; global authorization is not turned off by sending or removing the reference.
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

  /** Reread the state on the computer (called when opening the run mode sheet). */
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
    /** Global authorization state, independent of the skill selection of this message. */
    enabled: status?.enabled ?? false,
    /** Whether this computer supports it; null when not read yet. */
    supported: status ? status.supported : (null as boolean | null),
    busy,
    error,
    /** Enabled, but system authorization must still be completed on the computer. */
    needsPermission: permission,
    /** Whether the confirmation sheet before enabling is open. */
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
    /** Turning the toggle on requires confirmation first; turning it off takes effect immediately. */
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
