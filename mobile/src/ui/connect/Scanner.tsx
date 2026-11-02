import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import { AppState, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CameraView, scanFromURLAsync, useCameraPermissions } from 'expo-camera'
import { getPendingResultAsync, launchImageLibraryAsync, type ImagePickerResult } from 'expo-image-picker'
import { BrandMark, Icon, useColors, type IconName } from '../kit'
import { Text } from '../Text'
import { dark } from '../palette'
import { errorText } from '../theme'
import { ScanLine } from './motion'
import { simulatedPhoneChrome } from '../webChrome'

/** 扫码页固定用暗色取景：相机画面之上只有白色线条与文字。 */
const scannerBackground = '#121110'
const frameSize = 240

/**
 * 「首次打开 · 扫码」：全屏相机取景、扫描框、说明和底部白卡（相册 / 粘贴 / 手动）。
 * 只识别二维码；扫到的内容交给 onScanned，同一内容被拒后不会反复触发。
 */
export function Scanner({
  active,
  firstRun,
  notice,
  onNotice,
  onClose,
  onScanned,
  onPaste,
  onManual,
}: {
  /** 页面在前台且没有打开手动面板 / 批准页时才开相机。 */
  active: boolean
  /** 还没有任何电脑：左上角显示品牌，而不是关闭按钮。 */
  firstRun: boolean
  /** 粘贴、二维码内容或闪光灯的提示，只在这一处显示。 */
  notice: string
  onNotice(text: string): void
  onClose(): void
  onScanned(data: string): void
  onPaste(): void
  onManual(): void
}) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  // iOS card-style modals report no top inset; keep the header off the card edge.
  const top = simulatedPhoneChrome ? 47 : Math.max(insets.top, 12)
  const [permission, requestPermission] = useCameraPermissions()
  const [cameraError, setCameraError] = useState('')
  const [torch, setTorch] = useState(false)
  const [selectingPhoto, setSelectingPhoto] = useState(false)
  const scanSession = useRef({ active, disposed: false, revision: 0, pending: 0 })
  const handled = useRef<string | null>(null)
  const cameraOn = active && !selectingPhoto && Boolean(permission?.granted) && !cameraError

  useEffect(() => {
    const session = scanSession.current
    session.disposed = false
    return () => {
      session.disposed = true
    }
  }, [])

  useEffect(() => {
    const session = scanSession.current
    session.active = active
    if (active) void recoverPhoto()
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && session.active) void recoverPhoto()
    })
    return () => {
      subscription.remove()
      session.active = false
      session.revision++
    }
  }, [active])

  async function selectPhoto() {
    const session = scanSession.current
    if (!session.active || session.disposed || session.pending) return
    const request = ++session.revision
    const current = () => session.active && !session.disposed && request === session.revision
    session.pending = request
    setSelectingPhoto(true)
    setTorch(false)
    onNotice('')
    try {
      // The system photo picker grants access to the selected image only. It
      // works even when camera permission was denied; keep the QR uncompressed.
      const result = await launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: false,
        quality: 1,
      })
      if (current()) await readPhoto(result, current)
    } catch {
      if (current()) onNotice('无法识别这张图片，请重选二维码截图或粘贴配对链接。')
    } finally {
      if (!session.disposed && session.pending === request) {
        session.pending = 0
        setSelectingPhoto(false)
      }
    }
  }

  async function readPhoto(result: ImagePickerResult, current: () => boolean) {
    if (result.canceled || !result.assets[0]) return
    const codes = await scanFromURLAsync(result.assets[0].uri, ['qr'])
    if (!current()) return
    const values = [...new Set(codes.map((code) => code.data).filter(Boolean))]
    if (values.length === 0) {
      onNotice('图片中没有识别到二维码，请选择清晰的二维码截图。')
    } else if (values.length > 1) {
      onNotice('图片中有多个二维码，请裁剪后只保留电脑的连接二维码。')
    } else {
      // Reuse the camera/paste parser and confirmation form. Importing a QR
      // never makes a network request or saves credentials by itself.
      onScanned(values[0])
    }
  }

  // Android may recreate the Activity while its system picker is open. In
  // that case Expo stores the result here instead of resolving the old promise.
  const recoverPhoto = useEffectEvent(async () => {
    const session = scanSession.current
    const revision = session.revision
    const current = () => session.active && !session.disposed && session.revision === revision
    let result: Awaited<ReturnType<typeof getPendingResultAsync>>
    try {
      result = await getPendingResultAsync()
    } catch {
      if (current()) {
        session.revision++
        session.pending = 0
        setSelectingPhoto(false)
        onNotice('无法识别这张图片，请重选二维码截图或粘贴配对链接。')
      }
      return
    }
    if (!result || !current()) return
    const request = ++session.revision
    session.pending = request
    const recoveredCurrent = () => session.active && !session.disposed && session.revision === request
    setSelectingPhoto(true)
    setTorch(false)
    onNotice('')
    try {
      if ('code' in result) throw new Error('Image picker failed')
      await readPhoto(result, recoveredCurrent)
    } catch {
      if (recoveredCurrent()) onNotice('无法识别这张图片，请重选二维码截图或粘贴配对链接。')
    } finally {
      if (!session.disposed && session.pending === request) {
        session.pending = 0
        setSelectingPhoto(false)
      }
    }
  })

  const leave = (next: () => void) => () => {
    scanSession.current.revision++
    scanSession.current.pending = 0
    setSelectingPhoto(false)
    setTorch(false)
    next()
  }

  let frame: ReactNode
  if (cameraError)
    frame = (
      <View style={{ alignItems: 'center', gap: 16, paddingHorizontal: 8 }}>
        <Text
          accessibilityRole="alert"
          style={{
            fontSize: 14,
            lineHeight: 21,
            color: 'rgba(255,255,255,0.85)',
            textAlign: 'center',
          }}
        >
          {cameraError}
        </Text>
        <PillButton
          title="重试相机"
          onPress={() => {
            handled.current = null
            setCameraError('')
          }}
        />
      </View>
    )
  else if (permission && !permission.granted)
    frame = (
      <PillButton
        title={permission.canAskAgain === false ? '在系统设置中开启相机' : '允许使用相机'}
        onPress={() => {
          if (permission.canAskAgain === false) void Linking.openSettings()
          else
            void requestPermission().catch((e) => setCameraError(errorText(e)))
        }}
      />
    )

  return (
    <View style={{ flex: 1, backgroundColor: scannerBackground }}>
      {cameraOn && (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={torch}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onCameraReady={() => {
            handled.current = null
          }}
          onMountError={(event) => {
            setTorch(false)
            setCameraError(`${event.message}。可以粘贴配对链接或手动输入地址。`)
          }}
          onBarcodeScanned={({ data }) => {
            const session = scanSession.current
            if (!session.active || session.disposed || session.pending || data === handled.current) return
            handled.current = data
            setTorch(false)
            onScanned(data)
          }}
        />
      )}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, paddingTop: top }}>
        <View
          style={{
            height: 44,
            marginHorizontal: 16,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          {firstRun ? (
            <View
              accessibilityRole="header"
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
            >
              <BrandMark size={22} />
              <Text style={{ fontSize: 16, fontWeight: '600', color: '#FFFFFF' }}>
                cc-haha
              </Text>
            </View>
          ) : (
            <GlassButton icon="x" label="关闭扫码" onPress={leave(onClose)} />
          )}
          <GlassButton
            icon="flashlight"
            label={torch ? '关闭闪光灯' : '打开闪光灯'}
            selected={torch && cameraOn}
            onPress={() => {
              if (cameraOn) setTorch((value) => !value)
              else onNotice('开启相机后才可以使用闪光灯。')
            }}
          />
        </View>
        <View style={{ flex: 74, minHeight: 12 }} />
        <View
          style={{
            width: frameSize,
            height: frameSize,
            alignSelf: 'center',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {frame ?? (
            <>
              {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => (
                <Corner key={corner} corner={corner} />
              ))}
              {cameraOn && <ScanLine />}
            </>
          )}
        </View>
        <View
          style={{ marginTop: 28, paddingHorizontal: 24, alignItems: 'center', gap: 8 }}
        >
          <Text
            accessibilityRole="header"
            style={{
              fontSize: 22,
              lineHeight: 28,
              fontWeight: '600',
              color: '#FFFFFF',
              textAlign: 'center',
            }}
          >
            扫一下电脑上的二维码
          </Text>
          <Text
            style={{
              fontSize: 14,
              lineHeight: 21,
              color: 'rgba(255,255,255,0.7)',
              textAlign: 'center',
            }}
          >
            {'在电脑的 cc-haha 里打开\n「设置 → 手机连接」，选择局域网或 Cloudflare 外出连接'}
          </Text>
          {notice ? (
            <View
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={{
                marginTop: 4,
                flexDirection: 'row',
                justifyContent: 'center',
                gap: 6,
              }}
            >
              <View style={{ marginTop: 2 }}>
                <Icon name="circle-alert" size={15} color={dark.err} strokeWidth={2} />
              </View>
              <Text style={{ flexShrink: 1, fontSize: 13, lineHeight: 19, color: dark.err }}>
                {notice}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={{ flex: 139, minHeight: 16 }} />
        <View
          style={{
            marginHorizontal: 12,
            marginBottom: Math.max(insets.bottom, 34),
            backgroundColor: colors.card,
            borderRadius: 26,
            padding: 8,
          }}
        >
          <CardRow
            icon="image"
            title={selectingPhoto ? '正在识别图片…' : '从相册选择二维码'}
            disabled={selectingPhoto}
            onPress={() => void selectPhoto()}
          />
          <View style={{ height: 1, backgroundColor: colors.hair, marginLeft: 44 }} />
          <CardRow icon="link" title="粘贴配对链接" onPress={leave(onPaste)} />
          <View style={{ height: 1, backgroundColor: colors.hair, marginLeft: 44 }} />
          <CardRow icon="pencil" title="手动输入地址" chevron onPress={leave(onManual)} />
          <Text
            style={{
              paddingTop: 6,
              paddingHorizontal: 12,
              paddingBottom: 8,
              fontSize: 12.5,
              lineHeight: 18,
              color: colors.ink3,
            }}
          >
            只连你自己电脑上的 cc-haha，用不着模型的 API Key。
          </Text>
        </View>
      </ScrollView>
    </View>
  )
}

function Corner({ corner }: { corner: 'tl' | 'tr' | 'bl' | 'br' }) {
  const isTop = corner[0] === 't'
  const isLeft = corner[1] === 'l'
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        width: 44,
        height: 44,
        borderColor: '#FFFFFF',
        ...(isTop ? { top: 0, borderTopWidth: 3 } : { bottom: 0, borderBottomWidth: 3 }),
        ...(isLeft ? { left: 0, borderLeftWidth: 3 } : { right: 0, borderRightWidth: 3 }),
        borderTopLeftRadius: corner === 'tl' ? 22 : 0,
        borderTopRightRadius: corner === 'tr' ? 22 : 0,
        borderBottomLeftRadius: corner === 'bl' ? 22 : 0,
        borderBottomRightRadius: corner === 'br' ? 22 : 0,
      }}
    />
  )
}

/** 取景画面上的 44 圆按钮（关闭 / 闪光灯）。闪光灯打开时反白。 */
function GlassButton({
  icon,
  label,
  onPress,
  selected,
}: {
  icon: IconName
  label: string
  onPress(): void
  selected?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: selected ? '#FFFFFF' : 'rgba(255,255,255,0.14)',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Icon name={icon} size={20} color={selected ? scannerBackground : '#FFFFFF'} />
    </Pressable>
  )
}

/** 扫描框位置上的白色胶囊（允许相机 / 去系统设置 / 重试相机）。 */
function PillButton({ title, onPress }: { title: string; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        height: 44,
        paddingHorizontal: 20,
        borderRadius: 22,
        backgroundColor: '#FFFFFF',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ fontSize: 15, fontWeight: '600', color: scannerBackground }}>{title}</Text>
    </Pressable>
  )
}

function CardRow({
  icon,
  title,
  chevron,
  disabled,
  onPress,
}: {
  icon: IconName
  title: string
  chevron?: boolean
  disabled?: boolean
  onPress(): void
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 52,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 12,
        borderRadius: 18,
        backgroundColor: pressed ? colors.fill : 'transparent',
        opacity: disabled ? 0.6 : 1,
      })}
    >
      <Icon name={icon} size={20} color={colors.ink2} />
      <Text style={{ flex: 1, fontSize: 16, color: colors.ink }}>{title}</Text>
      {chevron && (
        <Icon name="chevron-right" size={14} color={colors.chevron} strokeWidth={2.2} />
      )}
    </Pressable>
  )
}
