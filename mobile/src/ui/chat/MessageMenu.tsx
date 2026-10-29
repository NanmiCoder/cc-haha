import { Fragment } from 'react'
import { Modal, Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Text } from '../Text'
import type { ChatItem } from '../../core/types'
import { visibleMessageText } from '../../core/chatComposer'
import { Icon, Spinner, useColors, type IconName } from '../kit'
import { Markdown, UserBubble, type BubbleLayout } from '../Message'

export type MessageAction = {
  key: 'copy' | 'select' | 'edit' | 'fork'
  label: string
  detail?: string
  icon: IconName
  disabled?: boolean
  busy?: boolean
  /** 放在粗分隔带之后。 */
  group?: boolean
}

const MENU_WIDTH = 268

function itemHeight(action: MessageAction) {
  return action.detail ? 58 : 44
}

/** 长按消息：遮罩里原处浮起被按的气泡，下面是操作菜单。 */
export function MessageMenu({
  item,
  layout,
  actions,
  onAction,
  onClose,
}: {
  item: ChatItem | null
  layout: BubbleLayout | null
  actions: MessageAction[]
  onAction(key: MessageAction['key']): void
  onClose(): void
}) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const { width: screenWidth, height: screenHeight } = useWindowDimensions()
  if (!item || !layout) return null
  const user = item.type === 'user'
  const text = visibleMessageText(item.text)
  const menuHeight = actions.reduce(
    (total, action, index) => total + itemHeight(action) + (index ? (action.group ? 6 : 0.5) : 0),
    0
  )
  const top = Math.max(insets.top, Platform.OS === 'web' ? 54 : 0) + 12
  const bottom = Math.max(insets.bottom, 16) + 12
  const gap = 10
  const available = screenHeight - top - bottom - menuHeight - gap
  const bubbleHeight = Math.max(60, Math.min(layout.height, available))
  const bubbleTop = Math.min(Math.max(layout.y, top), screenHeight - bottom - menuHeight - gap - bubbleHeight)
  const right = Math.max(16, screenWidth - layout.x - layout.width)
  const left = Math.max(16, layout.x)
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="关闭消息操作"
        onPress={onClose}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: `${colors.bg}E0` }}
      />
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          top: bubbleTop,
          ...(user ? { right } : { left }),
          alignItems: user ? 'flex-end' : 'flex-start',
          gap,
        }}
      >
        <View
          style={{
            maxHeight: bubbleHeight,
            width: user ? undefined : Math.min(layout.width, screenWidth - 32),
            maxWidth: user ? 300 : screenWidth - 32,
            borderRadius: user ? 20 : 16,
            borderBottomRightRadius: user ? 6 : 16,
            overflow: 'hidden',
            boxShadow: '0 10px 30px rgba(28,25,23,0.16)',
            transform: [{ scale: 1.02 }],
            backgroundColor: user ? colors.bubble : colors.card,
          }}
        >
          <ScrollView scrollEnabled={layout.height > bubbleHeight} bounces={false}>
            {user ? (
              <UserBubble item={item} text={text} team={text !== item.text} />
            ) : (
              <View style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
                <Markdown text={text || '附件消息'} selectable={false} />
              </View>
            )}
          </ScrollView>
        </View>
        <View
          accessibilityRole="menu"
          accessibilityLabel="消息操作"
          style={{
            width: MENU_WIDTH,
            backgroundColor: colors.sheet,
            borderRadius: 14,
            overflow: 'hidden',
            boxShadow: `0 12px 40px rgba(28,25,23,0.18), 0 0 0 0.5px ${colors.hair}`,
          }}
        >
          {actions.map((action, index) => (
            <Fragment key={action.key}>
              {index > 0 ? (
                <View style={{ height: action.group ? 6 : 0.5, backgroundColor: colors.hair }} />
              ) : null}
              <Pressable
                accessibilityRole="menuitem"
                accessibilityLabel={action.detail ? `${action.label}，${action.detail}` : action.label}
                accessibilityState={{ disabled: action.disabled, busy: action.busy }}
                disabled={action.disabled || action.busy}
                onPress={() => onAction(action.key)}
                style={({ pressed }) => ({
                  minHeight: itemHeight(action),
                  paddingHorizontal: 16,
                  paddingVertical: action.detail ? 8 : 0,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  backgroundColor: pressed ? colors.fill : 'transparent',
                })}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ fontSize: 16, color: action.disabled ? colors.faint : colors.ink }}>
                    {action.label}
                  </Text>
                  {action.detail ? (
                    <Text style={{ fontSize: 12.5, lineHeight: 17, color: colors.ink3 }}>{action.detail}</Text>
                  ) : null}
                </View>
                {action.busy ? (
                  <Spinner size={18} />
                ) : (
                  <View style={{ opacity: action.disabled ? 0.45 : 1 }}>
                    <Icon name={action.icon} size={19} color={colors.ink} />
                  </View>
                )}
              </Pressable>
            </Fragment>
          ))}
        </View>
      </View>
    </Modal>
  )
}
