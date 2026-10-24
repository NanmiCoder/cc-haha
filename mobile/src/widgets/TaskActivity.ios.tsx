import {
  Circle,
  HStack,
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
  offset,
  padding,
  shadow,
} from '@expo/ui/swift-ui/modifiers'
import { createLiveActivity, type LiveActivityEnvironment } from 'expo-widgets'
import type { TaskActivityProps } from './activityData'

const TaskActivity = (
  props: TaskActivityProps,
  environment: LiveActivityEnvironment
) => {
  'widget'
  const dim = environment.isLuminanceReduced
  const ink = dim ? '#D5D2CB' : '#23201C'
  const muted = dim ? '#ABA59B' : '#5E5952'
  const paper = dim ? '#24221E' : '#E8E7E3'
  const stale = environment.isStale || props.connectionState === 'stale'
  const statusText = stale
    ? '状态待更新 · 打开 App 重新连接'
    : props.status === 'waiting'
      ? props.detail
      : props.status === 'completed'
        ? '任务已完成'
        : props.status === 'failed'
          ? '遇到问题，打开 App 查看'
          : props.detail
  const canAnswer = !stale && Boolean(props.allowUrl && props.denyUrl)
  const lens = (
    <ZStack modifiers={[frame({ width: 44, height: 44 })]}>
      <Circle
        modifiers={[
          frame({ width: 44, height: 44 }),
          foregroundStyle({
            type: 'radialGradient',
            colors: ['#D27A5C', '#B4553A', '#8F3F2A'],
            center: { x: 0.34, y: 0.28 },
            startRadius: 0,
            endRadius: 30,
          }),
          shadow({ radius: 3, y: 3, color: '#6E342040' }),
        ]}
      />
      <Circle
        modifiers={[
          frame({ width: 34, height: 34 }),
          foregroundStyle({
            type: 'angularGradient',
            colors: ['#EDEBE6', '#C7C3BA', '#F6F5F1', '#BAB6AD', '#EDEBE6'],
            center: { x: 0.5, y: 0.5 },
          }),
        ]}
      />
      <Circle
        modifiers={[
          frame({ width: 26, height: 26 }),
          foregroundStyle('#1D1C1A'),
        ]}
      />
      <Text
        modifiers={[
          font({ size: 13, weight: 'medium', design: 'monospaced' }),
          foregroundStyle('#F2C38A'),
        ]}
      >
        {String(props.activeCount)}
      </Text>
      <Circle
        modifiers={[
          frame({ width: 7, height: 7 }),
          foregroundStyle({
            type: 'radialGradient',
            colors: ['#FFD9A0', '#E39A3B', '#A86A1C'],
            center: { x: 0.35, y: 0.3 },
            startRadius: 0,
            endRadius: 5,
          }),
          offset({ x: 14.5, y: -15.5 }),
        ]}
      />
    </ZStack>
  )
  const actions = canAnswer ? (
    <HStack spacing={8}>
      <Link
        destination={props.denyUrl!}
        modifiers={[frame({ maxWidth: Infinity })]}
      >
        <Text
          modifiers={[
            font({ size: 14, weight: 'semibold' }),
            foregroundStyle(ink),
            frame({ maxWidth: Infinity }),
            frame({ height: 40 }),
            background({
              type: 'linearGradient',
              colors: ['#F7F6F3', '#E9E8E4'],
              startPoint: { x: 0, y: 0 },
              endPoint: { x: 0, y: 1 },
            }),
            clipShape('roundedRectangle', 13),
            shadow({ radius: 0, y: 2, color: '#C8C5BE' }),
          ]}
        >
          拒绝
        </Text>
      </Link>
      <Link
        destination={props.allowUrl!}
        modifiers={[frame({ maxWidth: Infinity })]}
      >
        <Text
          modifiers={[
            font({ size: 14, weight: 'semibold' }),
            foregroundStyle('#FFFFFF'),
            frame({ maxWidth: Infinity }),
            frame({ height: 40 }),
            background({
              type: 'linearGradient',
              colors: ['#C1603F', '#A64D33'],
              startPoint: { x: 0, y: 0 },
              endPoint: { x: 0, y: 1 },
            }),
            clipShape('roundedRectangle', 13),
            shadow({ radius: 0, y: 2, color: '#7E3824' }),
          ]}
        >
          允许
        </Text>
      </Link>
    </HStack>
  ) : (
    <Link destination={props.openUrl}>
      <Text
        modifiers={[
          font({ size: 13, weight: 'medium' }),
          foregroundStyle(dim ? '#E3B49C' : '#B4553A'),
        ]}
      >
        {props.status === 'waiting' ? '打开 App 处理' : '查看任务'}
      </Text>
    </Link>
  )
  return {
    banner: (
      <VStack
        alignment="leading"
        spacing={12}
        modifiers={[padding({ all: 14 }), activityBackgroundTint(paper)]}
      >
        <HStack spacing={12}>
          {lens}
          <VStack
            alignment="leading"
            spacing={3}
            modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}
          >
            <Text
              modifiers={[
                font({ size: 14, weight: 'semibold' }),
                foregroundStyle(ink),
                lineLimit(1),
              ]}
            >
              {props.title}
            </Text>
            <Text
              modifiers={[
                font({ size: 12 }),
                foregroundStyle(muted),
                lineLimit(1),
              ]}
            >
              {statusText}
            </Text>
          </VStack>
        </HStack>
        {actions}
        <HStack spacing={8} modifiers={[padding({ horizontal: 2 })]}>
          <Circle
            modifiers={[
              frame({ width: 6, height: 6 }),
              foregroundStyle(stale ? '#A39B8D' : '#8FA35A'),
            ]}
          />
          <Text
            modifiers={[
              font({ size: 11, design: 'monospaced' }),
              foregroundStyle(muted),
              lineLimit(1),
            ]}
          >
            {props.hostName}
            {props.activeCount > 1
              ? ` · 另有 ${props.activeCount - 1} 个在跑`
              : ' · cc-haha'}
          </Text>
          <Spacer />
        </HStack>
      </VStack>
    ),
    compactLeading: (
      <Circle
        modifiers={[
          frame({ width: 15, height: 15 }),
          foregroundStyle('#B4553A'),
        ]}
      />
    ),
    compactTrailing: (
      <Text
        modifiers={[
          font({ size: 12, design: 'monospaced' }),
          foregroundStyle(props.status === 'waiting' ? '#F2C38A' : '#A9C27A'),
        ]}
      >
        {stale
          ? '待更新'
          : props.status === 'waiting'
            ? '待确认'
            : String(props.activeCount)}
      </Text>
    ),
    minimal: (
      <Text
        modifiers={[
          font({ size: 12, weight: 'semibold' }),
          foregroundStyle('#F2C38A'),
        ]}
      >
        {stale ? '…' : String(props.activeCount)}
      </Text>
    ),
    expandedLeading: lens,
    expandedTrailing: (
      <Text
        modifiers={[
          font({ size: 12 }),
          foregroundStyle('#C4BEB4'),
          lineLimit(1),
        ]}
      >
        {props.hostName}
      </Text>
    ),
    expandedBottom: (
      <VStack
        alignment="leading"
        spacing={10}
        modifiers={[padding({ all: 8 })]}
      >
        <Text
          modifiers={[
            font({ size: 14, weight: 'semibold' }),
            foregroundStyle('#ECE8E0'),
            lineLimit(1),
          ]}
        >
          {props.title}
        </Text>
        <Text
          modifiers={[
            font({ size: 12 }),
            foregroundStyle('#B3ADA3'),
            lineLimit(2),
          ]}
        >
          {statusText}
        </Text>
        {actions}
      </VStack>
    ),
  }
}
export default createLiveActivity<TaskActivityProps>(
  'CCHahaTaskActivity',
  TaskActivity
)
