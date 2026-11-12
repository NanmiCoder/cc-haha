import { Pressable, View } from 'react-native'
import type { ActivityProgress } from '../../core/sessionActivityModel'
import { Icon, Mono, Spinner, useColors } from '../kit'
import { Text } from '../Text'
import { capsuleBadge, capsuleLabel, capsuleText } from './activityView'

const SHADOW = '0 1px 2px rgba(28,25,23,0.06), 0 2px 8px rgba(28,25,23,0.07)'

/**
 * Activity capsule on the right of the header: spinner + done/total, with a corner count when subagents/background are running; 
 * turns amber with "!" while waiting for your approval; shows "Starting" right after the team is approved while members are getting in place.
 * Not rendered when there are no tasks and nothing running. Tap to open the running sheet.
 */
export function ActivityCapsule({
  progress,
  runningCount,
  tone,
  onPress,
  active = runningCount > 0,
  visible = runningCount > 0 || progress.total > 0,
  launching = false,
}: {
  progress: ActivityProgress
  runningCount: number
  tone: 'run' | 'attention'
  onPress(): void
  /** Whether to spin; by default spins whenever something is running. Pass false when the list is unfinished but idle. */
  active?: boolean
  /** Default: there are tasks or something is running. The integrator may pass `activity.capsuleVisible`. */
  visible?: boolean
  /** Team plan approved but members not in place yet: show even without tasks. */
  launching?: boolean
}) {
  const colors = useColors()
  const attention = tone === 'attention'
  const starting = launching && !attention
  if (!starting && (!visible || (runningCount === 0 && progress.total === 0))) return null
  const badge = starting ? null : capsuleBadge({ progress, runningCount })
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={capsuleLabel({ progress, runningCount, tone, active, launching })}
      onPress={onPress}
      style={({ pressed }) => ({ height: 44, justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
    >
      <View
        style={{
          height: 36,
          paddingLeft: 10,
          paddingRight: 12,
          borderRadius: 18,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          backgroundColor: attention ? colors.attnSoft : colors.card,
          boxShadow: attention
            ? `0 1px 2px rgba(28,25,23,0.06), 0 0 0 1.5px ${colors.attn}61`
            : `${SHADOW}, 0 0 0 1px ${colors.hair}`,
        }}
      >
        {attention ? (
          <View
            style={{
              width: 18,
              height: 18,
              borderRadius: 9,
              backgroundColor: colors.attn,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.card }}>!</Text>
          </View>
        ) : active || starting ? (
          <Spinner size={16} thickness={2.4} />
        ) : (
          <Icon name="list-checks" size={16} color={colors.ink2} />
        )}
        {starting ? (
          <Text style={{ fontSize: 14, fontWeight: '600', color: colors.ink }}>Starting</Text>
        ) : (
          <Mono
            style={{ fontSize: 14, fontWeight: '600', color: attention ? colors.attnInk : colors.ink }}
          >
            {capsuleText({ progress, runningCount })}
          </Mono>
        )}
      </View>
      {badge !== null ? (
        <View
          style={{
            position: 'absolute',
            top: 1,
            right: -4,
            minWidth: 18,
            height: 18,
            paddingHorizontal: 4,
            borderRadius: 9,
            backgroundColor: colors.btn,
            boxShadow: `0 0 0 2px ${colors.bg}`,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Mono style={{ fontSize: 12, lineHeight: 18, fontWeight: '600', color: colors.btnInk }}>
            {badge}
          </Mono>
        </View>
      ) : null}
    </Pressable>
  )
}
