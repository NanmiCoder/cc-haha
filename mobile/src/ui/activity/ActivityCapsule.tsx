import { Pressable, View } from 'react-native'
import type { ActivityProgress } from '../../core/sessionActivityModel'
import { Icon, Mono, Spinner, useColors } from '../kit'
import { Text } from '../Text'
import { capsuleBadge, capsuleLabel, capsuleText } from './activityView'

const SHADOW = '0 1px 2px rgba(28,25,23,0.06), 0 2px 8px rgba(28,25,23,0.07)'

/**
 * 顶栏右侧的活动胶囊：转圈 + 完成数/总数，子 Agent/后台在跑时角上叠个数；
 * 等你批准时变琥珀色带「!」。没有任务也没有在跑的东西时不渲染。点开运行中底单。
 */
export function ActivityCapsule({
  progress,
  runningCount,
  tone,
  onPress,
  active = runningCount > 0,
  visible = runningCount > 0 || progress.total > 0,
}: {
  progress: ActivityProgress
  runningCount: number
  tone: 'run' | 'attention'
  onPress(): void
  /** 是否转圈；默认只要有东西在跑就转。清单没做完但已空闲时传 false。 */
  active?: boolean
  /** 默认：有任务或有东西在跑。整合者可传入 `activity.capsuleVisible`。 */
  visible?: boolean
}) {
  const colors = useColors()
  if (!visible || (runningCount === 0 && progress.total === 0)) return null
  const attention = tone === 'attention'
  const badge = capsuleBadge({ progress, runningCount })
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={capsuleLabel({ progress, runningCount, tone, active })}
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
        ) : active ? (
          <Spinner size={16} thickness={2.4} />
        ) : (
          <Icon name="list-checks" size={16} color={colors.ink2} />
        )}
        <Mono
          style={{ fontSize: 14, fontWeight: '600', color: attention ? colors.attnInk : colors.ink }}
        >
          {capsuleText({ progress, runningCount })}
        </Mono>
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
