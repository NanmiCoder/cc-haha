import { useEffect } from 'react'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import { useTabStore } from '../../stores/tabStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { WorkbenchPanel } from './WorkbenchPanel'

type WorkbenchTabProps = {
  tabId: string
  sessionId: string
}

export function WorkbenchTab({ tabId, sessionId }: WorkbenchTabProps) {
  const mode = useWorkspacePanelStore((state) => state.getMode(sessionId))

  useEffect(() => {
    if (mode === 'browser') {
      useBrowserPanelStore.getState().ensureBlank(sessionId)
    }
  }, [mode, sessionId])

  return (
    <div data-testid="workbench-tab" className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)]">
      <WorkbenchPanel
        sessionId={sessionId}
        variant="tab"
        onClose={() => useTabStore.getState().closeTab(tabId)}
      />
    </div>
  )
}
