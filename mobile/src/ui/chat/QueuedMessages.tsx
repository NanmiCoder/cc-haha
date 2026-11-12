import { Pressable, View } from 'react-native'
import { Text } from '../Text'
import { useColors } from '../kit'
import type { QueuedMessage } from './queue'
import { plural } from '../../core/plural'

/**
 * Follow-up messages queued while running: one per row, can be steered into this turn immediately or withdrawn to the input.
 * When the previous turn errored or delivery was not confirmed, pause auto-sending, give the reason, and let the user decide to send or withdraw.
 */
export function QueuedMessages({
  items,
  paused,
  onWithdraw,
  onSendNow,
  onGuide,
  guiding,
  guideDisabled,
}: {
  items: QueuedMessage[]
  paused?: string
  onWithdraw(id: string): void
  onSendNow(id: string): void
  onGuide(id: string): void
  /** This turn is running: show "Steer". */
  guiding?: boolean
  /** Cannot steer while a decision is pending, configuration is unconfirmed or the connection is not ready. */
  guideDisabled?: boolean
}) {
  const colors = useColors()
  if (!items.length) return null
  return (
    <View style={{ gap: 6 }}>
      {paused ? (
        <Text style={{ fontSize: 12.5, lineHeight: 17, color: colors.attn, paddingHorizontal: 4 }}>
          {paused}
        </Text>
      ) : null}
      {items.map((item, index) => (
        <View
          key={item.id}
          style={{
            minHeight: 48,
            borderRadius: 14,
            backgroundColor: colors.card,
            boxShadow: `inset 0 0 0 1px ${colors.hair}`,
            paddingLeft: 12,
            paddingRight: 4,
            paddingVertical: 6,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <Text style={{ fontSize: 12, lineHeight: 16, color: colors.ink3 }}>
              {paused ? 'Queued · paused' : 'Queued · sends after this turn ends'}
              {item.attachments.length ? ` · ${plural(item.attachments.length, 'material')}` : ''}
              {item.team ? ' · team' : ''}
            </Text>
            <Text numberOfLines={1} style={{ fontSize: 14, lineHeight: 20, color: colors.ink }}>
              {item.text || item.references?.map((reference) => `@${reference.displayName || reference.name}`).join(' ') || '(materials only)'}
            </Text>
          </View>
          {guiding ? (
            <QueueAction
              label="Steer"
              strong
              disabled={guideDisabled}
              onPress={() => onGuide(item.id)}
              a11y={`Steer queued message now: ${item.text}`}
            />
          ) : paused && index === 0 ? (
            <QueueAction label="Send" strong onPress={() => onSendNow(item.id)} a11y={`Send queued message now: ${item.text}`} />
          ) : null}
          <QueueAction label="Withdraw" onPress={() => onWithdraw(item.id)} a11y={`Withdraw queued message: ${item.text}`} />
        </View>
      ))}
    </View>
  )
}

function QueueAction({
  label,
  onPress,
  strong,
  disabled,
  a11y,
}: {
  label: string
  onPress(): void
  strong?: boolean
  disabled?: boolean
  a11y: string
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 36,
        paddingHorizontal: 10,
        justifyContent: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.5 : 1,
      })}
    >
      <Text style={{ fontSize: 14, fontWeight: strong ? '600' : '400', color: strong ? colors.ink : colors.ink2 }}>
        {label}
      </Text>
    </Pressable>
  )
}
