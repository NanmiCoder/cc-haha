import React, { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './fixture.css'
import { createElectronHost, type ElectronHostBridge } from '../../../src/lib/desktopHost/electronHost'
import { HostsTabButton } from '../../../src/features/managed-resources/ui/tabIntegration'
import { ManagedResourcesRouterBranch } from '../../../src/features/managed-resources/ui/routerIntegration'
import { useHostManagementStore } from '../../../src/features/managed-resources/stores/hostManagementStore'
import { useTabStore, HOSTS_TAB_ID } from '../../../src/stores/tabStore'
import { useSettingsStore } from '../../../src/stores/settingsStore'
import { runDesktopPersistenceMigrations } from '../../../src/lib/persistenceMigrations'
import { t } from '../../../src/i18n'

declare global {
  interface Window {
    m2FixtureBridge: ElectronHostBridge
    m2Smoke: {
      snapshot: () => { tabs: string[]; hosts: unknown[]; tags: unknown[]; selectedHostId: string | null }
      label: typeof t
    }
  }
}
window.desktopHost = createElectronHost(window.m2FixtureBridge)
useSettingsStore.setState({ locale: 'en' })
runDesktopPersistenceMigrations()
window.m2Smoke = {
  label: t,
  snapshot: () => ({
    tabs: useTabStore.getState().tabs.map(tab => tab.sessionId),
    hosts: useHostManagementStore.getState().hosts,
    tags: useHostManagementStore.getState().tags,
    selectedHostId: useHostManagementStore.getState().selectedHostId,
  }),
}

function FixtureShell() {
  const active = useTabStore(state => state.activeTabId)
  useEffect(() => { void useTabStore.getState().restoreTabs() }, [])
  return <main className="flex h-screen flex-col bg-[var(--color-surface)] text-[var(--color-text-primary)]">
    <header className="flex items-center gap-3 border-b border-[var(--color-border)] p-2">
      <span>M2 isolated fixture</span><HostsTabButton />
    </header>
    <section className="min-h-0 flex-1">{active === HOSTS_TAB_ID ? <ManagedResourcesRouterBranch /> : null}</section>
  </main>
}
createRoot(document.getElementById('root')!).render(<FixtureShell />)
