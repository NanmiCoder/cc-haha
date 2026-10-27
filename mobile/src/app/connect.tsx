import { useCallback, useRef, useState } from 'react'
import { Platform, View } from 'react-native'
import { getStringAsync } from 'expo-clipboard'
import { randomUUID } from 'expo-crypto'
import { StatusBar } from 'expo-status-bar'
import { router, useFocusEffect } from 'expo-router'
import { createApiClient } from '../state/api'
import { connectHost, pairingMessage } from '../core/connectHost'
import { useApp } from '../state/AppContext'
import { goBack } from '../ui/kit'
import { errorText, useTheme } from '../ui/theme'
import { Scanner } from '../ui/connect/Scanner'
import { ManualSheet } from '../ui/connect/ManualSheet'
import { PairingView, type PairingState } from '../ui/connect/PairingView'
import {
  connectionBlocker,
  defaultHostName,
  modeForAddress,
  needsToken,
  receivedConnection,
  remoteBadge,
  type ConnectMode,
} from '../ui/connect/connectForm'

/**
 * 连接电脑：扫码页 → 手动连接面板 →（公网）等电脑批准页。
 * 凭据只有在真实验证 / 批准之后才写入 SecureStore。
 */
export default function Connect() {
  const { add, registry } = useApp()
  const { dark } = useTheme()
  const [stage, setStage] = useState<'scan' | 'form'>('scan')
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
    setStage('scan')
  }
  function rescan() {
    cancel()
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
      setStage('form')
    } catch (e) {
      setNotice(errorText(e))
    }
  }
  async function paste() {
    try {
      const value = await getStringAsync()
      if (!value.trim()) throw new Error('剪贴板里没有连接链接，请先从电脑复制。')
      receive(value.trim())
    } catch (e) {
      setNotice(errorText(e))
    }
  }
  async function pasteToken() {
    try {
      const value = (await getStringAsync()).trim()
      if (!value) throw new Error('剪贴板是空的，请先在电脑上复制访问令牌。')
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
      setStatus('连接成功，正在安全保存…')
      if (waiting) setPairing({ badge, phase: 'saving' })
      await add(result.host, result.credential, controller.signal)
      if (!controller.signal.aborted && attempt.current === controller) {
        setAddress('')
        setToken('')
        router.replace('/')
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
          // 全屏呈现不能下滑关闭：只要有页面可回，就给关闭按钮；直接打开（无处可回）才显示品牌。
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
        onClose={closeForm}
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
