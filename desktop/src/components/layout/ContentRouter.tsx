import { useEffect, useRef, type ReactNode } from 'react'
import { useTabStore, type Tab } from '../../stores/tabStore'
import { EmptySession } from '../../pages/EmptySession'
import { ActiveSession } from '../../pages/ActiveSession'
import { ScheduledTasks } from '../../pages/ScheduledTasks'
import { Settings } from '../../pages/Settings'
import { TerminalSettings } from '../../pages/TerminalSettings'
import { TraceList } from '../../pages/TraceList'
import { TraceSession } from '../../pages/TraceSession'
import { WorkbenchTab } from '../workbench/WorkbenchTab'
import { previewBridge } from '../../lib/previewBridge'

function renderTabContent(tab: Tab): ReactNode {
  switch (tab.type) {
    case 'settings':
      return <Settings />
    case 'scheduled':
      return <ScheduledTasks />
    case 'trace':
      return tab.traceSessionId
        ? <TraceSession sessionId={tab.traceSessionId} />
        : <EmptySession />
    case 'traces':
      return <TraceList />
    case 'workbench':
      return tab.workbenchSessionId
        ? <WorkbenchTab tabId={tab.sessionId} sessionId={tab.workbenchSessionId} />
        : <EmptySession />
    case 'session':
      return <ActiveSession />
    default:
      return <EmptySession />
  }
}

export function ContentRouter() {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const tabs = useTabStore((s) => s.tabs)
  const activeTabType = tabs.find((t) => t.sessionId === activeTabId)?.type
  const terminalTabs = tabs.filter((tab) => tab.type === 'terminal')

  // Track visited non-terminal tab IDs — once mounted, they stay mounted (keep-alive)
  const visitedRef = useRef<Set<string>>(new Set())
  const tabIds = new Set(tabs.map((t) => t.sessionId))

  // Add current active tab to visited set
  if (activeTabId) visitedRef.current.add(activeTabId)

  // Prune closed tabs from visited set
  const nextVisited = new Set<string>()
  for (const id of visitedRef.current) {
    if (tabIds.has(id)) nextVisited.add(id)
  }
  visitedRef.current = nextVisited

  useEffect(() => {
    if (activeTabType === 'session' || activeTabType === 'workbench') return
    void previewBridge.close()
  }, [activeTabType])

  // Non-terminal tabs that have been visited — kept alive with CSS hiding
  const keepAliveTabs = tabs.filter(
    (tab) => tab.type !== 'terminal' && visitedRef.current.has(tab.sessionId),
  )

  const showEmptyState = !activeTabId || !activeTabType

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {showEmptyState && (
        <div className="absolute inset-0 z-10 flex min-h-0 flex-col overflow-hidden">
          <EmptySession />
        </div>
      )}
      {keepAliveTabs.map((tab) => {
        const visible = tab.sessionId === activeTabId && activeTabType === tab.type
        return (
          <div
            key={tab.sessionId}
            aria-hidden={!visible}
            className={`absolute inset-0 flex min-h-0 flex-col overflow-hidden ${
              visible ? 'z-20 opacity-100' : 'pointer-events-none z-0 opacity-0'
            }`}
          >
            {renderTabContent(tab)}
          </div>
        )
      })}
      {terminalTabs.map((tab) => {
        const active = tab.sessionId === activeTabId
        const visible = activeTabType === 'terminal' && active
        return (
          <div
            key={tab.sessionId}
            aria-hidden={!visible}
            data-testid={`terminal-tab-panel-${tab.sessionId}`}
            className={`absolute inset-0 flex min-h-0 flex-col overflow-hidden ${
              visible ? 'z-20 opacity-100' : 'pointer-events-none z-0 opacity-0'
            }`}
          >
            <TerminalSettings
              active={active}
              cwd={tab.terminalCwd}
              runtimeId={tab.terminalRuntimeId ?? tab.sessionId}
              workspace
              testId={`terminal-host-${tab.sessionId}`}
              onNewTerminal={() => useTabStore.getState().openTerminalTab(tab.terminalCwd)}
            />
          </div>
        )
      })}
    </div>
  )
}
