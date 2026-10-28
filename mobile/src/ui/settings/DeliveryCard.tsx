import { useState } from 'react'
import { Pressable, View } from 'react-native'
import Svg, { Circle, Path } from 'react-native-svg'
import { Button, Group, Icon, InlineError, Separator, useColors } from '../kit'
import { Text } from '../Text'
import type { Delivery, RowTone } from './deliveryModel'

/** 设置首页只显示通知状态，诊断和测试按需展开。 */
export function DeliveryCard({
  delivery,
  busy,
  note,
  error,
  onAction,
  onGuide,
}: {
  delivery: Delivery
  busy?: Delivery['actions'][number]['kind'] | null
  note?: string
  error?: string
  onAction(kind: Delivery['actions'][number]['kind']): void
  onGuide(): void
}) {
  const colors = useColors()
  const [expanded, setExpanded] = useState(false)
  const blocked = delivery.state === 'blocked'
  const tint = blocked ? colors.attn : delivery.state === 'ok' ? colors.ok : colors.ink3
  const soft = blocked ? colors.attnSoft : delivery.state === 'ok' ? colors.okSoft : colors.fill
  return (
    <Group>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`通知，${delivery.title}`}
        accessibilityHint={expanded ? '收起通知详情' : '查看通知状态与测试'}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => ({
          minHeight: 68,
          paddingHorizontal: 14,
          paddingVertical: 12,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          backgroundColor: pressed ? colors.fill : 'transparent',
        })}
      >
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 11,
            backgroundColor: soft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <BellGlyph off={blocked} color={tint} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={{ fontSize: 16, lineHeight: 21, fontWeight: '500', color: colors.ink }}>
            通知
          </Text>
          <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
            {delivery.title}
          </Text>
        </View>
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={16} color={colors.chevron} />
      </Pressable>
      {expanded && (
        <>
          <Separator />
          <View style={{ padding: 14, gap: 12 }}>
            <Text style={{ fontSize: 13, lineHeight: 19, color: colors.ink3 }}>
              {delivery.subtitle}
            </Text>
            <View>
              {delivery.rows.map((row) => {
                const color = toneColor(row.tone, colors)
                return (
                  <View
                    key={row.key}
                    accessible
                    accessibilityLabel={`${row.label}，${row.value}`}
                    style={{ minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 10 }}
                  >
                    <ToneGlyph tone={row.tone} color={color} />
                    <Text style={{ flex: 1, fontSize: 14, color: colors.ink }}>{row.label}</Text>
                    <Text
                      style={{
                        fontSize: 13,
                        lineHeight: 18,
                        color: row.tone === 'bad' || row.tone === 'warn' ? color : colors.ink3,
                        flexShrink: 1,
                        maxWidth: '55%',
                        textAlign: 'right',
                      }}
                    >
                      {row.value}
                    </Text>
                  </View>
                )
              })}
            </View>
            {delivery.actions.some((action) => action.kind === 'test') && (
              <Text style={{ fontSize: 13, lineHeight: 19, color: colors.ink3 }}>
                发送一条通知，检查手机能否收到提醒。
              </Text>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              {delivery.actions.map((action) => (
                <Button
                  key={action.kind}
                  title={action.label}
                  variant={action.look === 'primary' ? 'primary' : action.look === 'plain' ? 'plain' : 'secondary'}
                  style={{ height: 44, paddingHorizontal: 16 }}
                  busy={busy === action.kind}
                  disabled={busy != null}
                  onPress={() => onAction(action.kind)}
                />
              ))}
              {delivery.guide && (
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel="推送设置说明"
                  onPress={onGuide}
                  style={({ pressed }) => ({
                    minHeight: 44,
                    paddingHorizontal: 8,
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <Text style={{ fontSize: 14, color: colors.ink2 }}>推送设置说明</Text>
                </Pressable>
              )}
            </View>
            {error ? (
              <InlineError text={error} />
            ) : note ? (
              <Text accessibilityLiveRegion="polite" style={{ fontSize: 13, lineHeight: 20, color: colors.ink2 }}>
                {note}
              </Text>
            ) : null}
          </View>
        </>
      )}
    </Group>
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
