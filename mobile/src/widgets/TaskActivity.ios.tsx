import {
  Circle,
  HStack,
  Image,
  Link,
  Spacer,
  Text,
  VStack,
  ZStack,
} from '@expo/ui/swift-ui'
import {
  activityBackgroundTint,
  background,
  clipShape,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  monospacedDigit,
  multilineTextAlignment,
  padding,
} from '@expo/ui/swift-ui/modifiers'
import { createLiveActivity, type LiveActivityEnvironment } from 'expo-widgets'
import type { TaskActivityProps } from './activityData'

/**
 * 锁屏实时活动与灵动岛（LockScreen 稿）。'widget' 函数会被序列化后在扩展里执行，
 * 只能用 props、environment 和 @expo/ui 的全局组件；文案都在 activityData 里算好。
 * 电脑端 APNs 推送只带基础字段，新字段缺失时这里兜底。
 */
const TaskActivity = (
  props: TaskActivityProps,
  environment: LiveActivityEnvironment
) => {
  'widget'
  const dim = environment.isLuminanceReduced
  const stale = environment.isStale || props.connectionState === 'stale'
  const ink = dim ? '#CFCCC5' : '#F3F1EC'
  const ink2 = dim ? 'rgba(207,204,197,0.72)' : 'rgba(243,241,236,0.72)'
  const ink3 = dim ? 'rgba(207,204,197,0.6)' : 'rgba(243,241,236,0.6)'
  const attn = '#F0A445'
  const run = '#8DB0F4'
  const ok = '#6CC892'
  const err = '#F07B86'
  const glass = 'rgba(58,56,52,0.62)'
  const waiting = !stale && props.status === 'waiting'
  const running = !stale && props.status === 'running'
  const completed = !stale && props.status === 'completed'
  const failed = !stale && props.status === 'failed'
  const tone = waiting ? attn : running ? run : completed ? ok : failed ? err : ink3
  const label = stale ? '状态待更新' : props.label || '需要你决定'
  const detail = stale ? '打开 App 重新连接' : props.detail
  const summary =
    props.summary || (completed ? '完成' : failed ? '出错停下' : '')
  const others = Math.max(0, props.activeCount - (completed || failed ? 0 : 1))
  const othersText = others > 0 ? `还有 ${others} 个任务在跑` : ''
  const footer = othersText ? `${props.hostName} · ${othersText}` : props.hostName
  const canAnswer = waiting && Boolean(props.allowUrl && props.denyUrl)
  const started =
    running && typeof props.startedAt === 'number'
      ? new Date(props.startedAt)
      : null
  const timer = (size: number) =>
    started ? (
      <Text
        timerInterval={{
          lower: started,
          upper: new Date(started.getTime() + 24 * 3600 * 1000),
        }}
        countsDown={false}
        modifiers={[
          font({ size, weight: 'medium', design: 'monospaced' }),
          monospacedDigit(),
          foregroundStyle(ink),
          multilineTextAlignment('trailing'),
          frame({ width: size * 4.6, alignment: 'trailing' }),
        ]}
      />
    ) : null
  const dot = (size: number) =>
    running ? (
      <ZStack modifiers={[frame({ width: size + 6, height: size + 6 })]}>
        <Circle
          modifiers={[
            frame({ width: size + 6, height: size + 6 }),
            foregroundStyle('rgba(141,176,244,0.25)'),
          ]}
        />
        <Circle
          modifiers={[frame({ width: size - 1, height: size - 1 }), foregroundStyle(run)]}
        />
      </ZStack>
    ) : (
      <Circle modifiers={[frame({ width: size, height: size }), foregroundStyle(tone)]} />
    )
  const pill = (title: string, url: string, primary: boolean) => (
    <Link destination={url} modifiers={[frame({ maxWidth: Infinity })]}>
      <Text
        modifiers={[
          font({ size: 15, weight: 'semibold' }),
          foregroundStyle(primary ? '#111111' : ink),
          frame({ maxWidth: Infinity, minHeight: 44 }),
          background(primary ? '#F3F1EC' : 'rgba(255,255,255,0.16)'),
          clipShape('capsule'),
        ]}
      >
        {title}
      </Text>
    </Link>
  )
  const actions = canAnswer ? (
    <HStack spacing={8}>
      {pill('拒绝', props.denyUrl!, false)}
      {pill('允许', props.allowUrl!, true)}
    </HStack>
  ) : waiting || stale ? (
    pill(stale ? '打开 App' : props.actionLabel || '打开 App 处理', props.openUrl, false)
  ) : null
  const titleText = (size: number) => (
    <Text
      modifiers={[
        font({ size, weight: 'semibold' }),
        foregroundStyle(ink),
        lineLimit(1),
        frame({ maxWidth: Infinity, alignment: 'leading' }),
      ]}
    >
      {props.title}
    </Text>
  )
  const detailText = detail ? (
    <Text
      modifiers={[
        font({ size: 13, design: 'monospaced' }),
        foregroundStyle(ink2),
        lineLimit(1),
      ]}
    >
      {detail}
    </Text>
  ) : null
  const footerText = (
    <Text modifiers={[font({ size: 12.5 }), foregroundStyle(ink3), lineLimit(1)]}>
      {footer}
    </Text>
  )
  const outcome = (
    <HStack spacing={12}>
      <Image
        systemName={completed ? 'checkmark.circle' : 'exclamationmark.circle'}
        size={20}
        color={completed ? ok : err}
      />
      <VStack alignment="leading" spacing={2} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}>
        {titleText(15)}
        <Text modifiers={[font({ size: 13 }), foregroundStyle(ink2), lineLimit(1)]}>
          {summary}
        </Text>
      </VStack>
    </HStack>
  )
  const waitingHeader = (
    <HStack spacing={10}>
      {dot(9)}
      <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(stale ? ink3 : attn), lineLimit(1)]}>
        {label}
      </Text>
      <Spacer />
      <Text modifiers={[font({ size: 13 }), foregroundStyle(ink3), lineLimit(1)]}>
        {props.hostName}
      </Text>
    </HStack>
  )
  const banner =
    completed || failed ? (
      <VStack alignment="leading" modifiers={[padding({ vertical: 14, horizontal: 16 }), activityBackgroundTint(glass)]}>
        {outcome}
      </VStack>
    ) : running ? (
      <VStack
        alignment="leading"
        spacing={10}
        modifiers={[padding({ all: 16 }), activityBackgroundTint(glass)]}
      >
        <HStack spacing={10}>
          {dot(9)}
          {titleText(16)}
          {timer(16)}
        </HStack>
        {detailText}
        {footerText}
      </VStack>
    ) : (
      <VStack
        alignment="leading"
        spacing={12}
        modifiers={[padding({ all: 16 }), activityBackgroundTint(glass)]}
      >
        {waitingHeader}
        <VStack alignment="leading" spacing={4}>
          {titleText(16)}
          {detailText}
        </VStack>
        {actions}
      </VStack>
    )
  const compactText = stale
    ? '待更新'
    : waiting
      ? '等你'
      : completed
        ? '完成'
        : failed
          ? '出错'
          : String(props.activeCount)
  return {
    banner,
    compactLeading: dot(10),
    compactTrailing:
      running && started ? (
        timer(12)
      ) : (
        <Text
          modifiers={[
            font({ size: 12, weight: 'semibold' }),
            foregroundStyle(tone),
            lineLimit(1),
          ]}
        >
          {compactText}
        </Text>
      ),
    minimal: dot(10),
    expandedLeading: (
      <HStack spacing={8} modifiers={[padding({ leading: 6, top: 4 })]}>
        {dot(9)}
        <Text
          modifiers={[
            font({ size: 13, weight: 'semibold' }),
            foregroundStyle(waiting ? attn : ink3),
            lineLimit(1),
          ]}
        >
          {waiting || stale ? label : props.hostName}
        </Text>
      </HStack>
    ),
    expandedTrailing: running && started ? (
      <HStack modifiers={[padding({ trailing: 6, top: 4 })]}>{timer(13)}</HStack>
    ) : waiting || stale ? (
      <Text
        modifiers={[
          font({ size: 13 }),
          foregroundStyle(ink3),
          lineLimit(1),
          padding({ trailing: 6, top: 4 }),
        ]}
      >
        {props.hostName}
      </Text>
    ) : null,
    expandedBottom:
      completed || failed ? (
        <VStack alignment="leading" modifiers={[padding({ horizontal: 6, bottom: 6 })]}>
          {outcome}
        </VStack>
      ) : (
        <VStack
          alignment="leading"
          spacing={12}
          modifiers={[padding({ horizontal: 6, bottom: 6 })]}
        >
          <VStack alignment="leading" spacing={4}>
            {titleText(16)}
            {detailText}
          </VStack>
          {running ? (
            othersText ? (
              <Text modifiers={[font({ size: 12.5 }), foregroundStyle(ink3), lineLimit(1)]}>
                {othersText}
              </Text>
            ) : null
          ) : (
            actions
          )}
        </VStack>
      ),
  }
}
export default createLiveActivity<TaskActivityProps>(
  'CCHahaTaskActivity',
  TaskActivity
)
