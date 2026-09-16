import { useEffect, useState } from 'react'
import { useOpenTargetStore, type OpenTarget } from '@/stores/openTargetStore'
import { isEditorOpenableFile } from '@/lib/fileCapabilities'
import { reportOpenFailure } from '@/lib/systemFileOpen'

export function fileApplicationTargets(path: string, targets: OpenTarget[]): OpenTarget[] {
  const seen = new Set<string>()
  return targets.filter((target) => {
    if (target.kind === 'file_manager' || (target.kind === 'ide' && !isEditorOpenableFile(path))) return false
    const identity = target.kind === 'system_default' ? target.id : target.bundleId || target.appPath || target.id
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

/** The split button and its menu use one path-qualified target discovery. */
export function useWorkspaceFileOpenTargets(path: string | null) {
  const getTargetsForPath = useOpenTargetStore((state) => state.getTargetsForPath)
  const globalTargets = useOpenTargetStore((state) => state.targets)
  const editorTargetId = useOpenTargetStore((state) => state.editorTargetId)
  const lastSuccessfulTargetId = useOpenTargetStore((state) => state.lastSuccessfulTargetId)
  const [result, setResult] = useState<{ path: string; targets: OpenTarget[]; error: string | null } | null>(null)
  const validPath = path && /^(?:[\\/]|[a-zA-Z]:[\\/])/.test(path) ? path : null

  useEffect(() => {
    if (!validPath) return
    let active = true
    void getTargetsForPath(validPath).then((targets) => {
      if (active) setResult({ path: validPath, targets, error: null })
    }).catch((error: unknown) => {
      if (active) setResult({ path: validPath, targets: [], error: error instanceof Error ? error.message : String(error) })
    })
    return () => { active = false }
  }, [getTargetsForPath, validPath])

  const current = result?.path === validPath ? result : null
  const targets = validPath ? current?.targets ?? globalTargets : []
  const applications = fileApplicationTargets(validPath ?? '', targets)
  const primaryTarget = applications.find((target) => target.id === lastSuccessfulTargetId)
    ?? applications.find((target) => target.id === editorTargetId)
    ?? applications.find((target) => target.kind === 'ide')
    ?? applications.find((target) => target.isDefault)
    ?? applications.find((target) => target.kind === 'system_default')
    ?? applications[0] ?? null
  const openTarget = (target: OpenTarget) => {
    if (!validPath) return
    void useOpenTargetStore.getState().openTarget(target.id, validPath).catch(() => reportOpenFailure(validPath))
  }
  return { targets, primaryTarget, openTarget, loading: !!validPath && !current, error: current?.error ?? null }
}
