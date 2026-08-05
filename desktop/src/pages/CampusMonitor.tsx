import { useEffect } from 'react'
import { BrowserSurface } from '@/components/browser/BrowserSurface'
import { CAMPUS_MONITOR_TAB_ID } from '../stores/tabStore'
import { useBrowserPanelStore } from '../stores/browserPanelStore'

export const CAMPUS_MONITOR_URL = 'http://127.0.0.1:3000/'

/**
 * Hosts the existing campus-monitor React application in cc-haha's native
 * browser. The monitor owns its event-list UI and data connection; this page
 * intentionally adds no second dashboard.
 */
export function CampusMonitor() {
  useEffect(() => {
    useBrowserPanelStore.getState().open(CAMPUS_MONITOR_TAB_ID, CAMPUS_MONITOR_URL)
  }, [])

  return <BrowserSurface sessionId={CAMPUS_MONITOR_TAB_ID} />
}
