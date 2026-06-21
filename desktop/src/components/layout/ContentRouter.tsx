import { useEffect, type ReactNode } from 'react'
import { useTabStore } from '../../stores/tabStore'
import { EmptySession } from '../../pages/EmptySession'
import { ActiveSession } from '../../pages/ActiveSession'
import { ScheduledTasks } from '../../pages/ScheduledTasks'
import { Settings } from '../../pages/Settings'
import { TerminalSettings } from '../../pages/TerminalSettings'
import { TraceList } from '../../pages/TraceList'
import { TraceSession } from '../../pages/TraceSession'
import { WorkbenchTab } from '../workbench/WorkbenchTab'
import { previewBridge } from '../../lib/previewBridge'

export function ContentRouter() {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const tabs = useTabStore((s) => s.tabs)
  const activeTabType = tabs.find((t) => t.sessionId === activeTabId)?.type
  const terminalTabs = tabs.filter((tab) => tab.type === 'terminal')

  useEffect(() => {
    if (activeTabType === 'session' || activeTabType === 'workbench') return
    void previewBridge.close()
  }, [activeTabType])

  let page: ReactNode = null
  if (!activeTabId || !activeTabType) {
    page = <EmptySession />
  } else if (activeTabType === 'settings') {
    page = <Settings />
  } else if (activeTabType === 'scheduled') {
    page = <ScheduledTasks />
  } else if (activeTabType === 'trace') {
    const traceSessionId = tabs.find((t) => t.sessionId === activeTabId)?.traceSessionId
    page = traceSessionId ? <TraceSession sessionId={traceSessionId} /> : <EmptySession />
  } else if (activeTabType === 'traces') {
    page = <TraceList />
  } else if (activeTabType === 'workbench') {
    const workbenchTab = tabs.find((t) => t.sessionId === activeTabId)
    page = workbenchTab?.workbenchSessionId
      ? <WorkbenchTab tabId={activeTabId} sessionId={workbenchTab.workbenchSessionId} />
      : <EmptySession />
  } else if (activeTabType !== 'terminal') {
    page = <ActiveSession />
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {page && (
        <div className="absolute inset-0 z-10 flex min-h-0 flex-col overflow-hidden">
          {page}
        </div>
      )}
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
