import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getDesktopHost } from '@/lib/desktopHost'
import { emptyHostToolsPreferences, type HostToolsPatch, type HostToolsScope } from '../../api/hostToolsApi'

export function useHostToolsPreferences(scope: HostToolsScope) {
  const scopeKey = JSON.stringify(scope)
  const stableScope = useMemo(() => JSON.parse(scopeKey) as HostToolsScope, [scopeKey])
  const [preferences, setPreferences] = useState(emptyHostToolsPreferences)
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = useRef(false)
  const sequence = useRef(0)
  useEffect(() => {
    active.current = true
    const version = ++sequence.current
    setReady(false); setPreferences(emptyHostToolsPreferences()); setError(null)
    void Promise.resolve().then(() => getDesktopHost().hostManagement.hostTools({ action: 'getPreferences', scope: stableScope })).then(result => {
      if (!active.current || version !== sequence.current) return
      if (!result.ok) { setError(result.error.code); return }
      if (result.data.kind !== 'preferences') { setError('INVALID_RESPONSE'); return }
      setPreferences(result.data.preferences); setReady(true)
    }).catch(() => { if (active.current && version === sequence.current) setError('HOST_TOOLS_FAILED') })
    return () => { active.current = false; sequence.current++ }
  }, [stableScope])
  const save = useCallback(async (patch: HostToolsPatch): Promise<boolean> => {
    if (!ready) return false
    const version = ++sequence.current
    setSaving(true); setError(null)
    if (patch.collapsed) setPreferences(value => ({ ...value, collapsed: { ...value.collapsed, ...patch.collapsed } }))
    try {
      const result = await getDesktopHost().hostManagement.hostTools({ action: 'savePreferences', scope: stableScope, patch })
      if (!result.ok) throw new Error(result.error.code)
      if (result.data.kind !== 'preferences') throw new Error('INVALID_RESPONSE')
      if (active.current && sequence.current === version) setPreferences(result.data.preferences)
      return true
    } catch (failure) {
      if (active.current && sequence.current === version) setError(failure instanceof Error ? failure.message : 'HOST_TOOLS_FAILED')
      return false
    } finally { if (active.current && sequence.current === version) setSaving(false) }
  }, [ready, stableScope])
  return { preferences, ready, saving, error, save }
}
