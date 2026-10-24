import { useCallback, useRef, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native'
import { Text } from '../ui/Text'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { getStringAsync } from 'expo-clipboard'
import { randomUUID } from 'expo-crypto'
import { LinearGradient } from 'expo-linear-gradient'
import { StatusBar } from 'expo-status-bar'
import { router, useFocusEffect } from 'expo-router'
import { createApiClient } from '../state/api'
import { parseConnectionInput } from '../core/connection'
import { connectHost, pairingMessage } from '../core/connectHost'
import { useApp } from '../state/AppContext'
import {
  Button,
  Field,
  Icon,
  Notice,
  PrimaryButton,
  errorText,
  useTheme,
} from '../ui/theme'
import { Porthole } from '../ui/Porthole'

export default function Connect() {
  const { add } = useApp()
  const { colors, styles } = useTheme()
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()
  const size = Math.min(310, width - 64, Math.max(220, height * 0.37))
  const [name, setName] = useState('我的电脑')
  const [address, setAddress] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [cameraError, setCameraError] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState(false)
  const [torch, setTorch] = useState(false)
  const [focused, setFocused] = useState(false)
  const [permission, requestPermission] = useCameraPermissions()
  const attempt = useRef<AbortController | null>(null)
  const scanned = useRef(false)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => {
        attempt.current?.abort()
        setFocused(false)
        setTorch(false)
        scanned.current = false
      }
    }, [])
  )
  function cancel() {
    attempt.current?.abort()
    attempt.current = null
    setBusy(false)
    setStatus('')
  }
  function closeForm() {
    cancel()
    setManual(false)
    setError('')
    scanned.current = false
  }
  function close() {
    cancel()
    if (router.canGoBack()) router.back()
    else router.replace('/')
  }
  function receive(value: string) {
    try {
      const parsed = parseConnectionInput(value)
      setAddress(value)
      setToken('')
      setName(new URL(parsed.url).hostname)
      setError('')
      setManual(true)
      setTorch(false)
    } catch (e) {
      setCameraError(errorText(e))
      scanned.current = false
    }
  }
  async function paste() {
    try {
      const value = await getStringAsync()
      if (!value.trim())
        throw new Error('剪贴板里没有连接链接，请先从电脑复制。')
      receive(value)
    } catch (e) {
      setCameraError(errorText(e))
    }
  }
  async function connect() {
    if (attempt.current || busy) return
    const controller = new AbortController()
    attempt.current = controller
    setError('')
    setBusy(true)
    try {
      const result = await connectHost(
        {
          value: address,
          token,
          name,
          id: randomUUID(),
          platform: Platform.OS,
          signal: controller.signal,
          onStatus: (value) => {
            if (!controller.signal.aborted) setStatus(value)
          },
        },
        { client: createApiClient }
      )
      if (controller.signal.aborted) return
      setStatus('连接成功，正在安全保存…')
      await add(result.host, result.credential, controller.signal)
      if (!controller.signal.aborted && attempt.current === controller) {
        setAddress('')
        setToken('')
        router.replace('/')
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(pairingMessage(e))
    } finally {
      if (attempt.current === controller) {
        attempt.current = null
        setBusy(false)
        setStatus('')
      }
    }
  }
  let remote = false
  let embeddedCredential = false
  try {
    const parsed = parseConnectionInput(address)
    remote = parsed.auth === 'remote'
    embeddedCredential = Boolean(parsed.credential)
  } catch {
    /* The manual field can be incomplete while typing. */
  }
  const cameraOn = focused && permission?.granted && !manual && !cameraError

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: '#171614' }}
      edges={['top', 'left', 'right']}
    >
      <StatusBar style="light" />
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 7,
          flexDirection: 'row',
          justifyContent: 'space-between',
        }}
      >
        <ScannerCircle label="关闭扫码" icon="x" onPress={close} />
        <ScannerCircle
          label={torch ? '关闭闪光灯' : '打开闪光灯'}
          icon={torch ? 'zap-off' : 'zap'}
          onPress={() => {
            if (cameraOn) setTorch((value) => !value)
            else setCameraError('开启相机后才可以使用闪光灯。')
          }}
        />
      </View>
      <ScrollView
        contentContainerStyle={{
          alignItems: 'center',
          paddingTop: 40,
          paddingBottom: 28,
          flexGrow: 1,
        }}
      >
        <Porthole size={size} online={Boolean(cameraOn)}>
          {cameraOn && (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              enableTorch={torch}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onMountError={(event) =>
                setCameraError(
                  `${event.message}。可以粘贴配对链接或手动输入地址。`
                )
              }
              onBarcodeScanned={({ data }) => {
                if (!scanned.current) {
                  scanned.current = true
                  receive(data)
                }
              }}
            />
          )}
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <View
              style={{ width: (size * 110) / 310, height: (size * 110) / 310 }}
            >
              {(['tl', 'tr', 'bl', 'br'] as const).map((position) => (
                <View
                  key={position}
                  style={{
                    position: 'absolute',
                    width: 26,
                    height: 26,
                    borderColor: '#F6F5F1',
                    ...(position.startsWith('t')
                      ? { top: 0, borderTopWidth: 3 }
                      : { bottom: 0, borderBottomWidth: 3 }),
                    ...(position.endsWith('l')
                      ? { left: 0, borderLeftWidth: 3 }
                      : { right: 0, borderRightWidth: 3 }),
                    borderTopLeftRadius: position === 'tl' ? 8 : 0,
                    borderTopRightRadius: position === 'tr' ? 8 : 0,
                    borderBottomLeftRadius: position === 'bl' ? 8 : 0,
                    borderBottomRightRadius: position === 'br' ? 8 : 0,
                  }}
                />
              ))}
              <View
                style={{
                  position: 'absolute',
                  left: 10,
                  right: 10,
                  top: '49%',
                  height: 2,
                  borderRadius: 1,
                  backgroundColor: '#A9C27A',
                  boxShadow: '0 0 8px rgba(169,194,122,.6)',
                }}
              />
            </View>
          </View>
        </Porthole>
        <View
          style={{
            marginTop: 34,
            paddingHorizontal: 32,
            gap: 8,
            alignItems: 'center',
          }}
        >
          <Text
            style={{
              color: '#ECE8E0',
              fontSize: 19,
              lineHeight: 26,
              fontWeight: '600',
              textAlign: 'center',
            }}
          >
            对准电脑上的连接二维码
          </Text>
          <Text
            style={{
              color: '#B3ADA3',
              fontSize: 13,
              lineHeight: 20,
              textAlign: 'center',
            }}
          >
            在电脑的 cc-haha 里打开「设置 → H5 访问」或「公网访问」
          </Text>
          {!permission?.granted && (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setCameraError('')
                if (permission?.canAskAgain === false)
                  void Linking.openSettings()
                else
                  void requestPermission().catch((e) =>
                    setCameraError(errorText(e))
                  )
              }}
              style={{
                paddingVertical: 12,
                paddingHorizontal: 18,
                marginTop: 6,
                borderRadius: 12,
                backgroundColor: '#34322E',
              }}
            >
              <Text style={{ color: '#ECE8E0', fontSize: 13 }}>
                {permission?.canAskAgain === false
                  ? '在系统设置中开启相机'
                  : '允许使用相机'}
              </Text>
            </Pressable>
          )}
          {!!cameraError && (
            <Text
              accessibilityRole="alert"
              style={{
                color: '#D5B7A6',
                fontSize: 12,
                lineHeight: 18,
                textAlign: 'center',
              }}
            >
              {cameraError}
            </Text>
          )}
          {!!cameraError && permission?.granted && (
            <Pressable
              onPress={() => {
                setCameraError('')
                scanned.current = false
              }}
              style={{ padding: 8 }}
            >
              <Text style={{ color: '#ECE8E0', fontSize: 12 }}>重试相机</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
      <View
        style={{
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: Math.max(insets.bottom, 18),
          gap: 12,
        }}
      >
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <ScannerAction
            title="粘贴配对链接"
            onPress={() => {
              void paste()
            }}
          />
          <ScannerAction
            title="手动输入地址"
            onPress={() => {
              setManual(true)
              setTorch(false)
              setError('')
            }}
          />
        </View>
        <Text
          style={{
            color: '#9A948A',
            fontSize: 12,
            lineHeight: 18,
            textAlign: 'center',
          }}
        >
          只连接你自己电脑上的 cc-haha，不需要填写模型的 API Key
        </Text>
      </View>
      <Modal
        visible={manual}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={closeForm}
      >
        <SafeAreaView
          style={styles.page}
          edges={['top', 'left', 'right', 'bottom']}
        >
          <StatusBar style={colors.paper === '#E8E7E3' ? 'dark' : 'light'} />
          <View
            style={{
              padding: 18,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Text style={[styles.text, { fontSize: 18, fontWeight: '600' }]}>
              {remote ? '连接公网电脑' : '连接你的电脑'}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭输入面板"
              onPress={closeForm}
              style={{ padding: 8 }}
            >
              <Icon name="x" />
            </Pressable>
          </View>
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ padding: 20, gap: 20 }}
            >
              <Field
                label="给这台电脑起个名字"
                value={name}
                onChangeText={setName}
                editable={!busy}
              />
              <Field
                label="连接地址或完整配对链接"
                value={address}
                onChangeText={(value) => {
                  setAddress(value)
                  setError('')
                }}
                placeholder="http://192.168.1.10:3456"
                editable={!busy}
                autoCapitalize="none"
                secureTextEntry={
                  address.includes('#pair=') || address.includes('h5Token=')
                }
              />
              {!remote && !embeddedCredential && (
                <Field
                  label="局域网访问令牌"
                  value={token}
                  onChangeText={setToken}
                  placeholder="在电脑的 H5 访问设置里查看"
                  autoComplete="off"
                  textContentType="none"
                  secureTextEntry
                  editable={!busy}
                />
              )}
              <Text style={styles.small}>
                {remote
                  ? '配对链接会请求电脑授权。请在电脑上核对这台手机并批准，链接过期后需要重新生成。'
                  : embeddedCredential
                    ? '二维码已包含局域网凭据。手机和电脑需要能通过这个地址互相访问。'
                    : '局域网连接需要完整地址和访问令牌。公网连接请粘贴带配对码的 HTTPS 链接。'}
              </Text>
              <Notice text={error} error />
              {!!status && (
                <View
                  style={{
                    flexDirection: 'row',
                    gap: 10,
                    alignItems: 'center',
                  }}
                >
                  <ActivityIndicator color={colors.accent} />
                  <Text
                    accessibilityLiveRegion="polite"
                    style={[styles.small, { flex: 1 }]}
                  >
                    {status}
                  </Text>
                </View>
              )}
              <PrimaryButton
                title={remote ? '请求电脑授权' : '验证并连接'}
                busy={busy}
                disabled={!address.trim()}
                onPress={() => {
                  void connect()
                }}
              />
              {busy && <Button title="取消连接" secondary onPress={cancel} />}
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  )
}

function ScannerCircle({
  label,
  icon,
  onPress,
}: {
  label: string
  icon: 'x' | 'zap' | 'zap-off'
  onPress(): void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: '#2A2825',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.65 : 1,
        boxShadow:
          'inset 0 1px 0 rgba(255,255,255,.08), 0 2px 6px rgba(0,0,0,.4)',
      })}
    >
      <Icon name={icon} color="#ECE8E0" size={18} />
    </Pressable>
  )
}
function ScannerAction({ title, onPress }: { title: string; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        opacity: pressed ? 0.65 : 1,
        borderRadius: 16,
        boxShadow: '0 3px 0 #0E0D0C',
      })}
    >
      <LinearGradient
        colors={['#34322E', '#282623']}
        style={{
          height: 52,
          borderRadius: 16,
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,.1)',
        }}
      >
        <Text style={{ color: '#ECE8E0', fontSize: 14, fontWeight: '600' }}>
          {title}
        </Text>
      </LinearGradient>
    </Pressable>
  )
}
