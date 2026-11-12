import { useCallback, useRef, useState } from 'react'
import { Platform, View } from 'react-native'
import { getStringAsync } from 'expo-clipboard'
import { randomUUID } from 'expo-crypto'
import { StatusBar } from 'expo-status-bar'
import { Redirect, router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { createApiClient } from '../state/api'
import { connectHost, pairingMessage } from '../core/connectHost'
import { useApp } from '../state/AppContext'
import { goBack } from '../ui/kit'
import { goHome } from '../ui/navigation'
import { errorText, useTheme } from '../ui/theme'
import { Scanner } from '../ui/connect/Scanner'
import { ManualSheet } from '../ui/connect/ManualSheet'
import { PairingView, type PairingState } from '../ui/connect/PairingView'
import {
  connectionBlocker,
  defaultHostName,
  initialStage,
  modeForAddress,
  needsToken,
  receivedConnection,
  remoteBadge,
  type ConnectMode,
  type ConnectStage,
} from '../ui/connect/connectForm'
import { isH5 } from '../state/h5'

/** Connecting other computers is native app only; the web version connects only to the computer that opened it, so go straight home. */
export default function ConnectRoute() {
  return isH5 ? <Redirect href="/" /> : <Connect />
}

/**
 * Connect a computer: scan page → manual connect panel → (public) wait-for-computer-approval page.
 * Credentials are written to SecureStore only after real verification / approval.
 */
function Connect() {
  const { add, registry } = useApp()
  const { dark } = useTheme()
  const params = useLocalSearchParams<{ mode?: string }>()
  const [stage, setStage] = useState<ConnectStage>(() => initialStage(params.mode))
  // Welcome page "Enter address manually" goes straight to the form: closing the form leaves this page instead of detouring to the scan page (camera not opened yet).
  const [direct, setDirect] = useState(() => initialStage(params.mode) === 'form')
  const [mode, setMode] = useState<ConnectMode>('lan')
  const [name, setName] = useState(defaultHostName)
  const [address, setAddress] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [pairing, setPairing] = useState<PairingState | null>(null)
  const [notice, setNotice] = useState('')
  const [focused, setFocused] = useState(false)
  const attempt = useRef<AbortController | null>(null)

  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => {
        attempt.current?.abort()
        attempt.current = null
        setFocused(false)
      }
    }, [])
  )

  function cancel() {
    attempt.current?.abort()
    attempt.current = null
    setBusy(false)
    setStatus('')
    setPairing(null)
  }
  function close() {
    cancel()
    goBack()
  }
  function closeForm() {
    cancel()
    setError('')
    setDirect(false)
    setStage('scan')
  }
  /** The form panel own dismissal (swipe down / tap backdrop). */
  function dismissForm() {
    if (!direct) return closeForm()
    setStage('scan')
    close()
  }
  function rescan() {
    cancel()
    setDirect(false)
    setAddress('')
    setToken('')
    setName(defaultHostName)
    setMode('lan')
    setError('')
    setNotice('')
    setStage('scan')
  }
  function receive(value: string) {
    try {
      const next = receivedConnection(value)
      setAddress(next.address)
      setName(next.name)
      setMode(next.mode)
      setToken('')
      setError('')
      setNotice('')
      setDirect(false)
      setStage('form')
    } catch (e) {
      setNotice(errorText(e))
    }
  }
  async function paste() {
    try {
      const value = await getStringAsync()
      if (!value.trim()) throw new Error('No connection link in the clipboard; copy it from the computer first.')
      receive(value.trim())
    } catch (e) {
      setNotice(errorText(e))
    }
  }
  async function pasteToken() {
    try {
      const value = (await getStringAsync()).trim()
      if (!value) throw new Error('The clipboard is empty; copy the access token on the computer first.')
      setToken(value)
      setError('')
    } catch (e) {
      setError(errorText(e))
    }
  }
  async function connect() {
    if (attempt.current || busy || !address.trim()) return
    const blocker = connectionBlocker(mode, address)
    if (blocker) {
      setError(blocker)
      return
    }
    const controller = new AbortController()
    attempt.current = controller
    const badge = remoteBadge(address)
    let waiting = false
    setError('')
    setBusy(true)
    try {
      const result = await connectHost(
        {
          value: address,
          token: needsToken(mode, address) ? token : '',
          name,
          id: randomUUID(),
          platform: Platform.OS,
          signal: controller.signal,
          onStatus: (value, phase) => {
            if (controller.signal.aborted) return
            setStatus(value)
            if (phase === 'approval') {
              waiting = true
              setPairing({ badge, phase: 'waiting' })
            }
          },
        },
        { client: createApiClient }
      )
      if (controller.signal.aborted) return
      setStatus('Connected, saving securely…')
      if (waiting) setPairing({ badge, phase: 'saving' })
      await add(result.host, result.credential, controller.signal)
      if (!controller.signal.aborted && attempt.current === controller) {
        setAddress('')
        setToken('')
        goHome()
      }
    } catch (e) {
      if (controller.signal.aborted) return
      const message = pairingMessage(e)
      // After the approval page is up, the failure belongs there; before it, inline in the form.
      if (waiting) setPairing({ badge, phase: 'failed', error: message })
      else setError(message)
    } finally {
      if (attempt.current === controller) {
        attempt.current = null
        setBusy(false)
        setStatus('')
      }
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#121110' }}>
      <StatusBar style={pairing && !dark ? 'dark' : 'light'} />
      {pairing ? (
        <PairingView state={pairing} onCancel={closeForm} onRescan={rescan} />
      ) : (
        <Scanner
          active={focused && stage === 'scan'}
          // Full-screen presentation cannot be swiped down: show a close button whenever there is a page to go back to; show the brand only when opened directly (nowhere to go back).
          firstRun={registry.hosts.length === 0 && !router.canGoBack()}
          notice={notice}
          onNotice={setNotice}
          onClose={close}
          onScanned={receive}
          onPaste={() => void paste()}
          onManual={() => {
            setNotice('')
            setError('')
            setStage('form')
          }}
        />
      )}
      <ManualSheet
        visible={stage === 'form' && !pairing}
        onClose={dismissForm}
        mode={mode}
        onModeChange={(value) => {
          setMode(value)
          setError('')
        }}
        name={name}
        onNameChange={setName}
        address={address}
        onAddressChange={(value) => {
          setAddress(value)
          setError('')
          setMode((current) => modeForAddress(value, current))
        }}
        token={token}
        onTokenChange={setToken}
        onPasteToken={() => void pasteToken()}
        busy={busy}
        status={status}
        error={error}
        onConnect={() => void connect()}
        onCancel={cancel}
        onRescan={rescan}
      />
    </View>
  )
}
