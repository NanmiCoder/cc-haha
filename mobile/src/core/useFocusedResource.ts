import { useCallback, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { FocusedRequests } from './focusedRequests'

/** Focus-scoped polling and explicit mutations. Navigation invalidates both, even if the route stays mounted. */
export function useFocusedResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  intervalMs = 0
) {
  const [value, setValue] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const reads = useRef(new FocusedRequests()).current
  const writes = useRef(new FocusedRequests()).current
  const locked = useRef(false)
  const refresh = useCallback(async () => {
    const request = reads.begin()
    if (!request) return
    try {
      const next = await load(request.signal)
      if (request.isCurrent()) {
        setValue(next)
        setError('')
      }
    } catch (e) {
      if (request.isCurrent())
        setError(e instanceof Error ? e.message : '读取失败，请重试')
    } finally {
      if (request.isCurrent()) setLoading(false)
    }
  }, [load, reads])
  useFocusEffect(
    useCallback(() => {
      reads.focus()
      writes.focus()
      locked.current = false
      setBusy(false)
      void refresh()
      const timer = intervalMs
        ? setInterval(() => {
            if (!locked.current) void refresh()
          }, intervalMs)
        : undefined
      return () => {
        reads.blur()
        writes.blur()
        if (timer) clearInterval(timer)
        locked.current = false
      }
    }, [intervalMs, reads, refresh, writes])
  )
  const run = useCallback(
    async <R>(
      operation: (signal: AbortSignal) => Promise<R>,
      done?: (result: R) => void
    ) => {
      if (locked.current) return
      const request = writes.begin()
      if (!request) return
      locked.current = true
      setBusy(true)
      setError('')
      try {
        const result = await operation(request.signal)
        if (request.isCurrent()) {
          done?.(result)
          void refresh()
        }
      } catch (e) {
        if (request.isCurrent())
          setError(
            e instanceof Error ? e.message : '操作未确认，请刷新后检查结果'
          )
      } finally {
        if (request.isCurrent()) {
          locked.current = false
          setBusy(false)
        }
      }
    },
    [refresh, writes]
  )
  return { value, setValue, error, setError, loading, busy, refresh, run }
}
