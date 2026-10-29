import { useRef, useState, type ReactNode } from 'react'
import { Linking, Platform, Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { BrandMark, Icon, useColors, type IconName } from '../kit'
import { Text } from '../Text'
import { dark } from '../palette'
import { errorText } from '../theme'
import { ScanLine } from './motion'

/** 扫码页固定用暗色取景：相机画面之上只有白色线条与文字。 */
const scannerBackground = '#121110'
const frameSize = 240

/**
 * 「首次打开 · 扫码」：全屏相机取景、扫描框、说明和底部白卡（粘贴 / 手动）。
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
  const top = Platform.OS === 'web' ? 47 : Math.max(insets.top, 12)
  const [permission, requestPermission] = useCameraPermissions()
  const [cameraError, setCameraError] = useState('')
  const [torch, setTorch] = useState(false)
  const handled = useRef<string | null>(null)
  const cameraOn = active && Boolean(permission?.granted) && !cameraError

  const leave = (next: () => void) => () => {
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
            if (!active || data === handled.current) return
            handled.current = data
            setTorch(false)
            onScanned(data)
          }}
        />
      )}
      <View style={{ flex: 1, paddingTop: top }}>
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
            // Absolutely placed under the copy so the scan frame never jumps.
            <View
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={{
                position: 'absolute',
                top: '100%',
                left: 24,
                right: 24,
                marginTop: 12,
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
      </View>
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
  onPress,
}: {
  icon: IconName
  title: string
  chevron?: boolean
  onPress(): void
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        height: 52,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 12,
        borderRadius: 18,
        backgroundColor: pressed ? colors.fill : 'transparent',
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
