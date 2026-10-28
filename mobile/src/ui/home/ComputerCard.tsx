import { Pressable, View } from 'react-native'
import { Text } from '../Text'
import { Button, Dot, Icon, Spinner, useColors } from '../kit'
import { useNow, useToneColor } from './parts'
import type { HostLink } from './homeModel'
import { computerCardLabel, computerCardView } from './computerCardModel'

/**
 * 首页顶部的电脑卡（设计稿 B1 / B2）：64pt 一行，点一下进电脑设置。
 * 离线时向下展开一句原因和两个按钮；授权失效时右侧换成「重新配对」胶囊。
 */
export function ComputerCard({
  name,
  host,
  link,
  lastSyncedAt,
  model,
  expiresAt,
  onOpen,
  onSwitch,
  onReconnect,
  onRepair,
}: {
  name: string
  host: { auth: 'lan' | 'remote' }
  link: HostLink
  lastSyncedAt?: number
  /** 新任务默认模型名；读不到就不传。 */
  model?: string
  /** 公网配对到期时间（毫秒时间戳）；读不到就不传。 */
  expiresAt?: number
  onOpen(): void
  onSwitch(): void
  onReconnect(): void
  onRepair(): void
}) {
  const colors = useColors()
  const toneColor = useToneColor()
  const now = useNow(30000, link !== 'online')
  const view = computerCardView({ link, host, lastSyncedAt, now, model, expiresAt })
  const statusColor =
    view.textTone === 'attn' ? colors.attn : view.textTone === 'err' ? colors.err : colors.ink3
  // 设计稿里空心圈和转圈的灰是 ink3，不是更浅的 faint。
  const leadColor = view.leadTone === 'faint' ? colors.ink3 : toneColor(view.leadTone)
  const tileColor =
    view.tile === 'err' ? colors.err : view.tile === 'dim' ? colors.ink3 : colors.ink
  return (
    <View style={{ backgroundColor: colors.card, borderRadius: 16 }}>
      <View
        style={{
          height: 64,
          paddingHorizontal: 12,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={computerCardLabel(name, view)}
          onPress={onOpen}
          style={({ pressed }) => ({
            flex: 1,
            minWidth: 0,
            height: 64,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              backgroundColor: view.tile === 'err' ? colors.errSoft : colors.fill,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {view.tile === 'err' ? (
              <Icon name="shield" size={21} color={tileColor} strokeWidth={1.8} />
            ) : (
              <Icon name="laptop" size={22} color={tileColor} strokeWidth={1.7} />
            )}
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text
              numberOfLines={1}
              style={{
                fontSize: 16,
                lineHeight: 21,
                fontWeight: '600',
                color: view.dimName ? colors.ink2 : colors.ink,
              }}
            >
              {name}
            </Text>
            <View
              accessibilityLiveRegion="polite"
              style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
            >
              {view.lead === 'spinner' ? (
                <Spinner
                  size={11}
                  thickness={2.6}
                  color={leadColor}
                  track={`${leadColor}33`}
                />
              ) : (
                <Dot color={leadColor} size={6} ring={view.lead === 'ring'} />
              )}
              <Text
                numberOfLines={1}
                style={{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: statusColor }}
              >
                {view.text.map((part, index) => (
                  <Text
                    key={index}
                    style={part.tone === 'attn' ? { color: colors.attn } : undefined}
                  >
                    {part.text}
                  </Text>
                ))}
              </Text>
            </View>
          </View>
          {view.trailing === 'chevron' ? (
            <Icon name="chevron-right" size={16} color={colors.chevron} strokeWidth={2} />
          ) : null}
        </Pressable>
        {view.trailing === 'repair' ? (
          <Button title="重新配对" size="sm" pill onPress={onRepair} />
        ) : null}
      </View>
      {view.detail ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 12 }}>
          <Text
            accessibilityRole="alert"
            style={{ paddingLeft: 52, fontSize: 14, lineHeight: 21, color: colors.ink2 }}
          >
            {view.detail}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {view.buttons.map((button) =>
              button === 'switch' ? (
                <Button
                  key={button}
                  title="换一台电脑"
                  variant="secondary"
                  onPress={onSwitch}
                  style={{ flex: 1 }}
                />
              ) : (
                <Button key={button} title="重新连接" onPress={onReconnect} style={{ flex: 1 }} />
              )
            )}
          </View>
        </View>
      ) : null}
    </View>
  )
}
