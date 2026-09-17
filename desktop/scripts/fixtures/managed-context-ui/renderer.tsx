import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../src/theme/globals.css'
import { createElectronHost, type ElectronHostBridge } from '../../../src/lib/desktopHost/electronHost'
import { setAuthToken, setBaseUrl } from '../../../src/api/client'
import { useSessionStore } from '../../../src/stores/sessionStore'
import { useTabStore } from '../../../src/stores/tabStore'
import { useChatStore } from '../../../src/stores/chatStore'
import { useSettingsStore } from '../../../src/stores/settingsStore'
import { useContextSelectionStore } from '../../../src/features/managed-resources/stores/contextSelectionStore'
import { ChatInput } from '../../../src/components/chat/ChatInput'
import { HostsWorkspace } from '../../../src/features/managed-resources/ui/HostsWorkspace'
import { t } from '../../../src/i18n'

declare global {
  interface Window {
    contextFixtureBridge: ElectronHostBridge & { getWorkDir: () => Promise<string> }
    contextSmoke: { label: typeof t; snapshot: () => unknown }
  }
}

async function boot() {
  const host = createElectronHost(window.contextFixtureBridge)
  window.desktopHost = host
  setBaseUrl(await host.runtime.getServerUrl())
  setAuthToken(await host.runtime.getLocalAccessToken())
  useSettingsStore.setState({ locale: 'en' })
  window.contextSmoke = {
    label: t,
    snapshot: () => ({
      sessionId: useSessionStore.getState().activeSessionId,
      sessions: useSessionStore.getState().sessions,
      chat: useChatStore.getState().sessions,
      selection: useContextSelectionStore.getState().snapshot(),
      storage: { ...localStorage },
    }),
  }
  createRoot(document.getElementById('root')!).render(<FixtureShell />)
}

function FixtureShell() {
  const [chat, setChat] = useState(false)
  const [error, setError] = useState('')
  const active = useSessionStore(state => state.activeSessionId)
  const state = useChatStore(store => active ? store.sessions[active] : null)
  const create = async () => {
    try {
      // The fixture controls only navigation; session creation and connection are real actions.
      const workDir = await window.contextFixtureBridge.getWorkDir()
      const id = await useSessionStore.getState().createSession(workDir)
      useTabStore.getState().openTab(id, 'Native context fixture')
      useChatStore.getState().connectToSession(id)
      setChat(true)
    } catch (error) { setError(error instanceof Error ? error.message : 'fixture error') }
  }
  return <main className="flex h-screen flex-col bg-[var(--color-surface)] text-[var(--color-text-primary)]">
    <header className="flex gap-4 border-b border-[var(--color-border)] p-3">
      <button data-testid="fixture-create-chat" onClick={() => void create()}>Start fixture conversation</button>
      <span data-testid="fixture-state">{state?.connectionState ?? 'no session'} / {state?.chatState ?? 'idle'}</span>
      {error && <span role="alert">{error}</span>}
    </header>
    {chat ? <><div className="flex-1 overflow-auto" data-testid="fixture-history">{state?.messages.map(message => <div key={message.id}>{message.role}: {JSON.stringify(message)}</div>)}</div><ChatInput /></> : <HostsWorkspace />}
  </main>
}
void boot()
