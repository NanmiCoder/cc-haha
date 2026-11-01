import { useCallback, useEffect, useRef, useState } from 'react'
import { mcpApi } from '@/api/mcp'
import { sessionsApi } from '@/api/sessions'
import { dedupeMcpProjectPaths, mcpProjectPathKey } from '@/lib/mcpIdentity'
import type { McpEditableConfig, McpProjectSharingResult, McpProjectSnapshot } from '@/types/mcp'

type ProjectChoice = McpProjectSnapshot & { checked: boolean; saveError?: string }

export function useMcpProjectSharing({
  enabled, name, sourceCwd, currentWorkDir, onSourceConfig,
}: {
  enabled: boolean
  name: string
  sourceCwd?: string
  currentWorkDir?: string
  onSourceConfig: (config: McpEditableConfig) => void
}) {
  const [projects, setProjects] = useState<ProjectChoice[]>([])
  const [loading, setLoading] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string>()
  const requestId = useRef(0)
  const currentProjects = useRef(projects)
  currentProjects.current = projects
  const context = useRef({ currentWorkDir, onSourceConfig })
  context.current = { currentWorkDir, onSourceConfig }

  const load = useCallback(async (initializeConfig = false) => {
    const id = ++requestId.current
    setLoading(true)
    setReady(false)
    setError(undefined)
    try {
      const recent = await sessionsApi.getRecentProjects(50).catch(() => ({ projects: [] }))
      const paths = dedupeMcpProjectPaths([sourceCwd, context.current.currentWorkDir, ...currentProjects.current.map(project => project.projectPath), ...recent.projects.map(project => project.realPath)])
      const survivingSource = currentProjects.current.find(project => project.selected)?.projectPath
      const snapshot = await mcpApi.projectSharing(name, paths, initializeConfig ? sourceCwd : survivingSource ?? sourceCwd)
      if (id !== requestId.current) return
      setProjects(snapshot.projects.map(project => ({ ...project, checked: project.selected })))
      if (initializeConfig && snapshot.config) context.current.onSourceConfig(snapshot.config)
      setReady(true)
    } catch (failure) {
      if (id === requestId.current) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [name, sourceCwd])

  useEffect(() => {
    setProjects([])
    setReady(false)
    if (enabled) void load(true)
    return () => { requestId.current++ }
  }, [enabled, load])

  const addProject = async (path: string) => {
    const key = mcpProjectPathKey(path)
    if (!key) return
    const existing = projects.find(project => mcpProjectPathKey(project.projectPath) === key)
    if (existing) {
      if (!existing.error && !existing.conflict) {
        setProjects(current => current.map(project => project === existing ? { ...project, checked: true } : project))
      }
      return
    }
    const id = ++requestId.current
    setLoading(true)
    setError(undefined)
    try {
      const snapshot = await mcpApi.projectSharing(name, [path], sourceCwd)
      if (id !== requestId.current) return
      setProjects(current => {
        const known = new Set(current.map(project => mcpProjectPathKey(project.projectPath)))
        const requested = snapshot.projects.find(project => mcpProjectPathKey(project.projectPath) === key || mcpProjectPathKey(project.requestedPath) === key)
        const updated = current.map(project => requested && mcpProjectPathKey(project.projectPath) === mcpProjectPathKey(requested.projectPath)
          ? { ...project, checked: !requested.error && !requested.conflict, conflict: requested.conflict, error: requested.error }
          : project)
        return [...updated, ...snapshot.projects.filter(project => !known.has(mcpProjectPathKey(project.projectPath))).map(project => ({
          ...project,
          checked: project.selected || ((mcpProjectPathKey(project.projectPath) === key || mcpProjectPathKey(project.requestedPath) === key) && !project.error && !project.conflict),
        }))]
      })
    } catch (failure) {
      if (id === requestId.current) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }

  const applyResults = (result: McpProjectSharingResult) => {
    const results = new Map(result.results.map(item => [mcpProjectPathKey(item.projectPath), item]))
    setProjects(current => current.map(project => {
      const saved = results.get(mcpProjectPathKey(project.projectPath))
      if (!saved) return project
      return {
        ...project,
        ...(saved.revision !== undefined ? { selected: saved.selected, revision: saved.revision } : {}),
        saveError: saved.success ? undefined : saved.error,
      }
    }))
  }

  const targets = projects.filter(project => project.selected || project.checked).map(project => ({
    projectPath: project.projectPath,
    selected: project.checked,
    expectedRevision: project.revision,
  }))

  return {
    projects, loading, ready, error, targets,
    canSave: ready && !loading && targets.length > 0,
    addProject,
    reload: () => load(),
    toggle: (path: string) => setProjects(current => current.map(project => (
      mcpProjectPathKey(project.projectPath) === mcpProjectPathKey(path)
        ? { ...project, checked: !project.checked }
        : project
    ))),
    applyResults,
  }
}
