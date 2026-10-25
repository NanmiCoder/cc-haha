import { Pressable, View } from 'react-native'
import type { ScheduledTask } from '../../core/operations'
import { latestRunLine, projectLabel, type RunSummary } from '../../core/schedulesView'
import { Switch, useColors } from '../kit'
import { Text } from '../Text'
import { DotLine, ScheduleLine } from './parts'

/** 定时任务列表一行：名称 · 计划与项目 · 最近运行；右侧开关。点行进入详情。 */
export function ScheduleRow({
  task,
  run,
  enabled,
  now,
  disabled,
  onOpen,
  onToggle,
}: {
  task: ScheduledTask
  run?: RunSummary
  enabled: boolean
  now: Date
  disabled?: boolean
  onOpen(): void
  onToggle(value: boolean): void
}) {
  const colors = useColors()
  const name = task.name || '未命名任务'
  const line = latestRunLine(run, task.cron, now)
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`打开 ${name}`}
        onPress={onOpen}
        style={({ pressed }) => ({ flex: 1, minWidth: 0, gap: 3, opacity: pressed ? 0.6 : 1 })}
      >
        <Text
          numberOfLines={1}
          style={{ fontSize: 16, lineHeight: 22, fontWeight: '500', color: enabled ? colors.ink : colors.ink2 }}
        >
          {name}
        </Text>
        <ScheduleLine
          cron={task.cron}
          extras={[projectLabel(task.folderPath), enabled ? '' : '已暂停']}
          color={enabled ? colors.ink2 : colors.ink3}
        />
        {enabled && <DotLine tone={line.tone} text={line.text} />}
      </Pressable>
      <Switch
        label={`启用${name}`}
        value={enabled}
        disabled={disabled}
        onValueChange={onToggle}
      />
    </View>
  )
}
