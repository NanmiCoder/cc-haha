import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../../src/theme/globals.css'
import { PublicAccessSettings } from '../../../src/pages/settings/PublicAccessSettings'
import { browserHost } from '../../../src/lib/desktopHost/browserHost'
import { publicAccessApi } from '../../../src/api/publicAccess'
import { useSettingsStore } from '../../../src/stores/settingsStore'
import { PUBLIC_ACCESS_CONSENT_VERSION, type DesktopPublicAccessStatus } from '../../../src/lib/desktopHost/types'

// This fixture never starts a sidecar, opens a tunnel, or calls an OS login API.
// The real panel, components, translations, QR encoder and browser renderer run unchanged.
const status: DesktopPublicAccessStatus = {
  mode: 'quick', customUrl: '', localPort: 17463, directoryState: 'unconfigured',
  state: 'disabled', tokenSet: false, tunnelId: null, phase: null, migrationRequired: false,
  publicUrl: null, error: null, autoStart: false, consentVersion: 0,
}
const login = { supported: true, enabled: false, requiresApproval: false }
let approved = false
window.fetch = async () => { throw new Error('Unexpected network request in settings smoke') }
window.desktopHost = {
  ...browserHost, kind: 'electron', isDesktop: true,
  app: {
    ...browserHost.app,
    getLoginStartup: async () => ({ ...login }),
    setLoginStartup: async enabled => { login.enabled = enabled; return { ...login } },
  },
  publicAccess: {
    ...browserHost.publicAccess,
    getStatus: async () => ({ ...status }),
    configure: async ({ tunnelToken, ...configuration }) => {
      Object.assign(status, configuration)
      if (tunnelToken) {
        status.tokenSet = true
        status.tunnelId = (JSON.parse(atob(tunnelToken)) as { t: string }).t
      }
      return { ...status }
    },
    start: async consentVersion => {
      if (consentVersion !== PUBLIC_ACCESS_CONSENT_VERSION) throw new Error('Consent required')
      const publicUrl = status.mode === 'named' ? 'https://named.fixture.example' : 'https://quick.fixture.example'
      Object.assign(status, { state: 'online', publicUrl, consentVersion })
      return { ...status }
    },
    stop: async () => { Object.assign(status, { state: 'disabled', publicUrl: null }); return { ...status } },
    setAutoStart: async enabled => { status.autoStart = enabled; return { ...status } },
  },
}
publicAccessApi.get = async () => ({ enabled: status.state === 'online', port: status.localPort, publicUrl: status.publicUrl,
  pending: approved || status.state !== 'online' ? [] : [{ id: 'fixture-phone', name: 'Fixture Android' }],
  devices: approved ? [{ id: 'fixture-phone', name: 'Fixture Android', createdAt: 1, expiresAt: 0 }] : [],
})
publicAccessApi.pairing = async () => ({ secret: 'fixture-pair-secret', expiresAt: Date.now() + 300_000,
  ...(status.directoryState === 'ready' ? { nativeBinding: { version: 2 as const, hostId: 'fixture-host', publicKey: 'fixture-public-key', directoryUrl: 'https://directory.example' } } : {}),
})
publicAccessApi.approve = async () => { approved = true; return {} }
publicAccessApi.revoke = async () => { approved = false; return {} }
useSettingsStore.setState({ locale: 'en' })
function Fixture() {
  return <main className="mx-auto max-w-3xl p-6">
    <div className="mb-4 flex gap-3" aria-label="Test fixture controls">
      <button id="fixture-discovery-ready" type="button" onClick={() => { status.directoryState = 'ready' }}>Fixture: discovery ready</button>
      <button id="fixture-directory-outage" type="button" onClick={() => { status.directoryState = 'retrying' }}>Fixture: directory outage</button>
    </div>
    <PublicAccessSettings />
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
