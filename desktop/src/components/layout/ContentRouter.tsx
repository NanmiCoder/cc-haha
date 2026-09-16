import { useEffect, type ReactNode } from 'react'
import { useTabStore } from '../../stores/tabStore'
import { EmptySession } from '../../pages/EmptySession'
import { ActiveSession } from '../../pages/ActiveSession'
import { ScheduledTasks } from '../../pages/ScheduledTasks'
import { ExtensionMarket } from '@/pages/ExtensionMarket'
import { Settings } from '../../pages/Settings'
import { TerminalSettings } from '../../pages/TerminalSettings'
import { TraceList } from '../../pages/TraceList'
import { TraceSession } from '../../pages/TraceSession'
import { SubagentRunPage, TeamMemberRunPage } from '../../pages/SubagentRunPage'
import { AgentTeamsWorkbenchTab } from '../agentTeams/AgentTeamsWorkbenchTab'
import { returnToTraceList } from '../../lib/traceNavigation'

export function ContentRouter() {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const tabs = useTabStore((s) => s.tabs)
  const activeTabType = tabs.find((t) => t.sessionId === activeTabId)?.type
  const terminalTabs = tabs.filter((tab) => tab.type === 'terminal')

  useEffect(() => {
    if (activeTabType !== 'workbench') return
    const legacy = tabs.find(tab => tab.sessionId === activeTabId)
    const source = legacy?.workbenchSessionId ?? legacy?.sourceSessionId
    if (!source || !legacy) return
    const store = useTabStore.getState()
    if (tabs.some(tab => tab.sessionId === source)) store.setActiveTab(source)
    else store.openTab(source, legacy.title)
    store.closeTab(legacy.sessionId)
  }, [activeTabId, activeTabType, tabs])

  let page: ReactNode = null
  if (!activeTabId || !activeTabType) {
    page = <EmptySession />
  } else if (activeTabType === 'settings') {
    page = <Settings />
  } else if (activeTabType === 'scheduled') {
    page = <ScheduledTasks />
  } else if (activeTabType === 'connectors' || activeTabType === 'market') {
    page = <ExtensionMarket />
  } else if (activeTabType === 'trace') {
    const traceTabId = activeTabId
    const traceSessionId = tabs.find((t) => t.sessionId === traceTabId)?.traceSessionId
    page = traceSessionId
      ? <TraceSession sessionId={traceSessionId} onBack={() => returnToTraceList(traceTabId)} />
      : <EmptySession />
  } else if (activeTabType === 'traces') {
    page = <TraceList />
  } else if (activeTabType === 'subagent') {
    const subagentTab = tabs.find((t) => t.sessionId === activeTabId)
    page = subagentTab?.sourceSessionId && subagentTab.subagentToolUseId
      ? (
        <SubagentRunPage
          sourceSessionId={subagentTab.sourceSessionId}
          toolUseId={subagentTab.subagentToolUseId}
          taskId={subagentTab.subagentTaskId}
          title={subagentTab.title}
        />
      )
      : <EmptySession />
  } else if (activeTabType === 'team-member') {
    const memberTab = tabs.find((tab) => tab.sessionId === activeTabId)
    page = memberTab?.teamLeadSessionId && memberTab.teamMemberAgentId
      ? (
        <TeamMemberRunPage
          tabId={activeTabId}
          leadSessionId={memberTab.teamLeadSessionId}
          agentId={memberTab.teamMemberAgentId}
          title={memberTab.title}
        />
      )
      : <EmptySession />
  } else if (activeTabType === 'workbench') {
    // An in-memory legacy tab returns to its task; restored storage is migrated
    // before reaching this router. Never mount a second workspace controller.
    page = <EmptySession />
  } else if (activeTabType === 'team') {
    const teamTab = tabs.find((t) => t.sessionId === activeTabId)
    page = teamTab?.teamLeadSessionId
      ? <AgentTeamsWorkbenchTab tabId={activeTabId} leadSessionId={teamTab.teamLeadSessionId} />
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
