import { ActivityIndicator, Pressable, View } from 'react-native'
import Svg, { Circle, Path } from 'react-native-svg'
import { Button, Chevron, Group, useColors } from '../kit'
import { Text } from '../Text'
import type { Delivery, RowTone } from './deliveryModel'

/** 「提醒能不能送到」：一句结论 + 系统通知 / 电脑推送 / 锁屏实时活动各自的状态 + 补救按钮。 */
export function DeliveryCard({
  delivery,
  busy,
  onAction,
  onGuide,
}: {
  delivery: Delivery
  /** 正在执行的按钮（如开启通知、测试通知已安排）。 */
  busy?: Delivery['actions'][number]['kind'] | null
  onAction(kind: Delivery['actions'][number]['kind']): void
  onGuide(): void
}) {
  const colors = useColors()
  const blocked = delivery.state === 'blocked'
  const tint = blocked ? colors.attn : delivery.state === 'ok' ? colors.ok : colors.ink3
  const soft = blocked ? colors.attnSoft : delivery.state === 'ok' ? colors.okSoft : colors.fill
  return (
    <Group style={{ padding: 14 }}>
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={`${delivery.title}，${delivery.subtitle}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
      >
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: soft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <BellGlyph off={blocked} color={tint} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={{ fontSize: 16, lineHeight: 21, fontWeight: '600', color: colors.ink }}>
            {delivery.title}
          </Text>
          <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
            {delivery.subtitle}
          </Text>
        </View>
      </View>
      <View style={{ marginTop: 10, marginBottom: 12, marginLeft: 52 }}>
        {delivery.rows.map((row) => {
          const color = toneColor(row.tone, colors)
          return (
            <View
              key={row.key}
              accessible
              accessibilityLabel={`${row.label}，${row.value}`}
              style={{ height: 34, flexDirection: 'row', alignItems: 'center', gap: 10 }}
            >
              <ToneGlyph tone={row.tone} color={color} />
              <Text style={{ flex: 1, fontSize: 15, color: colors.ink }}>{row.label}</Text>
              <Text
                numberOfLines={1}
                style={{
                  fontSize: 13,
                  lineHeight: 18,
                  color: row.tone === 'bad' || row.tone === 'warn' ? color : colors.ink3,
                  flexShrink: 1,
                  maxWidth: '60%',
                }}
              >
                {row.value}
              </Text>
            </View>
          )
        })}
      </View>
      {delivery.actions.map((action) =>
        action.icon === 'send' ? (
          <SendButton
            key={action.kind}
            title={action.label}
            busy={busy === action.kind}
            disabled={busy != null}
            onPress={() => onAction(action.kind)}
          />
        ) : action.look === 'plain' ? (
          <Button
            key={action.kind}
            title={action.label}
            variant="plain"
            style={{ marginTop: 6, height: 40 }}
            disabled={busy != null}
            onPress={() => onAction(action.kind)}
          />
        ) : (
          <Button
            key={action.kind}
            title={action.label}
            variant={action.look === 'primary' ? 'primary' : 'secondary'}
            style={{ marginTop: action.kind === delivery.actions[0].kind ? 0 : 6 }}
            busy={busy === action.kind}
            disabled={busy != null}
            onPress={() => onAction(action.kind)}
          />
        )
      )}
      {delivery.guide && (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="电脑推送怎么配"
          onPress={onGuide}
          style={({ pressed }) => ({
            marginTop: 6,
            height: 40,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ fontSize: 14, fontWeight: '500', color: colors.ink2 }}>
            电脑推送怎么配
          </Text>
          <Chevron color={colors.ink2} />
        </Pressable>
      )}
    </Group>
  )
}

/** 灰底「发一条测试通知」，iOS 设计稿里带 17pt 纸飞机；共享的 Button 只收图标名，所以在这里自己画。 */
function SendButton({
  title,
  busy,
  disabled,
  onPress,
}: {
  title: string
  busy: boolean
  disabled: boolean
  onPress(): void
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 44,
        borderRadius: 12,
        backgroundColor: colors.fill,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        opacity: pressed ? 0.7 : disabled && !busy ? 0.45 : 1,
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.ink} />
      ) : (
        <Svg
          width={17}
          height={17}
          viewBox="0 0 24 24"
          fill="none"
          stroke={colors.ink}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <Path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
          <Path d="m21.854 2.147-10.94 10.939" />
        </Svg>
      )}
      <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink }}>{title}</Text>
    </Pressable>
  )
}

function toneColor(tone: RowTone, colors: ReturnType<typeof useColors>) {
  switch (tone) {
    case 'ok':
      return colors.ok
    case 'warn':
      return colors.attn
    case 'bad':
      return colors.err
    default:
      return colors.ink3
  }
}

/** 17pt 圆形状态标记：勾=通、叉=关、叹号=待处理、横线=不适用。 */
function ToneGlyph({ tone, color }: { tone: RowTone; color: string }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg
        width={17}
        height={17}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <Circle cx={12} cy={12} r={9.5} />
        {tone === 'ok' && <Path d="m8.5 12.2 2.4 2.4 4.6-4.8" />}
        {tone === 'bad' && <Path d="m15 9-6 6M9 9l6 6" />}
        {tone === 'warn' && <Path d="M12 7.5v5.5M12 16.5h.01" />}
        {tone === 'off' && <Path d="M8 12h8" />}
      </Svg>
    </View>
  )
}

function BellGlyph({ off, color }: { off: boolean; color: string }) {
  return (
    <Svg
      width={21}
      height={21}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M10.27 21a2 2 0 0 0 3.46 0" />
      {off ? (
        <>
          <Path d="M17 17H4a1 1 0 0 1-.74-1.67C4.59 13.96 6 12.5 6 8a6 6 0 0 1 .26-1.74" />
          <Path d="M8.67 3.17A6 6 0 0 1 18 8c0 2.6.47 4.18 1.08 5.27" />
          <Path d="m2 2 20 20" />
        </>
      ) : (
        <Path d="M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33" />
      )}
    </Svg>
  )
}
