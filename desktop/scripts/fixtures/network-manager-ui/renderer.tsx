import React from 'react'
import { createRoot } from 'react-dom/client'
import './fixture.css'
import { createElectronHost, type ElectronHostBridge } from '../../../src/lib/desktopHost/electronHost'
import { useSettingsStore } from '../../../src/stores/settingsStore'
import { HostsTabButton } from '../../../src/features/managed-resources/ui/tabIntegration'
import { NetworkManagerButton } from '../../../src/features/network-manager/ui/NetworkManagerButton'

declare global { interface Window { networkFixtureBridge: ElectronHostBridge; setNetworkFixtureLocale(locale: 'en' | 'zh'): void } }
window.desktopHost = createElectronHost(window.networkFixtureBridge)
useSettingsStore.setState({ locale: 'en' })
window.setNetworkFixtureLocale = locale => useSettingsStore.setState({ locale })
createRoot(document.getElementById('root')!).render(<main className="flex h-screen flex-col bg-[var(--color-surface)] text-[var(--color-text-primary)]">
  <header className="flex h-14 items-center justify-end gap-1 border-b border-[var(--color-border)] px-4"><HostsTabButton /><NetworkManagerButton /></header>
</main>)
