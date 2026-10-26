import { Platform, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button, Icon, InlineError, Mono, Spinner, useColors } from '../kit'
import { Text } from '../Text'
import { PulseRing } from './motion'

export type PairingState =
  | { badge: string; phase: 'waiting' | 'saving' }
  | { badge: string; phase: 'failed'; error: string }

/**
 * 「等电脑批准」整页：公网配对发出请求后显示，批准后自动保存并进入首页。
 * 被拒、超时、过期等失败用原有文案说明，并给出「重新扫码」。
 */
export function PairingView({
  state,
  onCancel,
  onRescan,
}: {
  state: PairingState
  onCancel(): void
  onRescan(): void
}) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  // iOS card-style modals report no top inset; keep the layout off the card edge.
  const top = Platform.OS === 'web' ? 47 : Math.max(insets.top, 12)
  const failed = state.phase === 'failed'
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: top }}>
      <View style={{ flex: 1, paddingTop: 123 }}>
        <View style={{ alignItems: 'center' }}>
          <View style={{ width: 120, height: 120, alignItems: 'center', justifyContent: 'center' }}>
            {!failed && <PulseRing color={colors.run} />}
            <View
              style={{
                width: 96,
                height: 96,
                borderRadius: 48,
                backgroundColor: colors.card,
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 6px 20px rgba(28,25,23,0.08)',
              }}
            >
              <Icon name="laptop" size={44} color={colors.ink} strokeWidth={1.4} />
            </View>
          </View>
        </View>
        <View style={{ marginTop: 40, marginHorizontal: 28, alignItems: 'center', gap: 10 }}>
          <Text
            accessibilityRole="header"
            style={{ fontSize: 24, lineHeight: 31, fontWeight: '600', color: colors.ink, textAlign: 'center' }}
          >
            {failed ? '这次没有连上' : '去电脑上批准这台手机'}
          </Text>
          {failed ? (
            <InlineError text={state.error} style={{ alignSelf: 'stretch' }} />
          ) : (
            <Text style={{ fontSize: 15, lineHeight: 23, color: colors.ink2, textAlign: 'center' }}>
              电脑上的 cc-haha 会弹出确认。核对是这台手机，再点批准。
            </Text>
          )}
          <View
            style={{
              marginTop: 6,
              height: 30,
              paddingHorizontal: 12,
              borderRadius: 15,
              backgroundColor: colors.fill,
              justifyContent: 'center',
              maxWidth: '100%',
            }}
          >
            <Mono numberOfLines={1} style={{ fontSize: 13, color: colors.ink2 }}>
              {state.badge}
            </Mono>
          </View>
        </View>
      </View>
      <View
        style={{
          marginHorizontal: 16,
          marginBottom: Math.max(insets.bottom, 34),
          gap: 14,
          alignItems: 'center',
        }}
      >
        {failed ? (
          <Button title="重新扫码" size="lg" icon="scan" onPress={onRescan} style={{ alignSelf: 'stretch' }} />
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Spinner size={15} />
              <Text accessibilityLiveRegion="polite" style={{ fontSize: 14, color: colors.ink2 }}>
                {state.phase === 'saving' ? '连接成功，正在安全保存…' : '批准后会自动连上'}
              </Text>
            </View>
            <Button
              title="取消"
              variant="outline"
              size="lg"
              onPress={onCancel}
              style={{ alignSelf: 'stretch' }}
            />
          </>
        )}
      </View>
    </View>
  )
}
