import { Pressable, View } from 'react-native'
import type { TeamRow, TeamTask } from '../../core/sessionActivityModel'
import { Icon, Mono, Spinner, useColors } from '../kit'
import { Text } from '../Text'

const card = (colors: ReturnType<typeof useColors>) => ({
  backgroundColor: colors.card,
  borderRadius: 16,
  boxShadow: `0 0 0 1px ${colors.hair}`,
  overflow: 'hidden' as const,
})

const stateLabel = (state: TeamTask['state']) =>
  state === 'done' ? 'Done' : state === 'active' ? 'In progress' : state === 'waiting' ? 'Waiting on dependencies' : 'Not started'

/** "Waiting on #2 #3"; when prerequisites were deleted and numbers do not match, only say it is waiting. */
export const waitingText = (task: Pick<TeamTask, 'waitingOn'>) =>
  task.waitingOn.length ? `Waiting on ${task.waitingOn.map((id) => `#${id}`).join(' ')}` : 'Waiting on dependencies'

export function memberTone(row: Pick<TeamRow, 'tone'>, colors: ReturnType<typeof useColors>) {
  return row.tone === 'run' ? colors.run : row.tone === 'err' ? colors.err : colors.ink3
}

/** Member avatar: two letters; a running-blue ring while working. */
export function MemberMark({ row, size = 32 }: { row: Pick<TeamRow, 'mark' | 'tone'>; size?: number }) {
  const colors = useColors()
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.fill,
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: row.tone === 'run' ? `0 0 0 2px ${colors.card}, 0 0 0 3.5px ${colors.run}` : undefined,
      }}
    >
      <Text style={{ fontSize: Math.round(size * 0.375), fontWeight: '600', color: colors.ink2 }}>{row.mark}</Text>
    </View>
  )
}

function TaskMark({ state }: { state: TeamTask['state'] }) {
  const colors = useColors()
  if (state === 'done')
    return (
      <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: colors.ok, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="check" size={13} color={colors.card} strokeWidth={3} />
      </View>
    )
  if (state === 'active') return <Spinner size={20} thickness={2.2} />
  return <View style={{ width: 20, height: 20, borderRadius: 10, boxShadow: `inset 0 0 0 1.75px ${colors.faint}` }} />
}

export function MemberTaskLine({ task }: { task: TeamTask }) {
  const colors = useColors()
  const active = task.state === 'active'
  const done = task.state === 'done'
  return (
    <View
      accessible
      accessibilityLabel={[
        task.ref ? `Tasks ${task.ref}` : '',
        task.title,
        task.state === 'waiting' ? waitingText(task) : stateLabel(task.state),
        active ? task.detail : '',
      ]
        .filter(Boolean)
        .join(', ')}
      style={{
        minHeight: active && task.detail ? 56 : 44,
        paddingHorizontal: 14,
        paddingVertical: active && task.detail ? 8 : 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: active ? colors.runTint : undefined,
      }}
    >
      <TaskMark state={task.state} />
      {task.ref ? <Mono style={{ fontSize: 13, color: colors.ink3 }}>{`#${task.ref}`}</Mono> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{
            fontSize: 15,
            lineHeight: 20,
            fontWeight: active ? '600' : '400',
            color: done ? colors.ink3 : colors.ink,
            textDecorationLine: done ? 'line-through' : 'none',
          }}
        >
          {task.title}
        </Text>
        {active && task.detail ? (
          <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 17, color: colors.run }}>
            {task.detail}
          </Text>
        ) : null}
      </View>
      {task.state === 'waiting' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <Icon name="clock" size={13} color={colors.ink3} />
          <Text style={{ fontSize: 13, color: colors.ink3 }}>{waitingText(task)}</Text>
        </View>
      ) : null}
    </View>
  )
}

export function TaskLines({ tasks }: { tasks: TeamTask[] }) {
  const colors = useColors()
  return tasks.map((task) => (
    <View key={task.key} style={{ borderTopWidth: 1, borderTopColor: colors.hair }}>
      <MemberTaskLine task={task} />
    </View>
  ))
}

/**
 * One card per member: avatar, name, model, status; tasks it claimed hang below.
 * With onOpen it can be tapped to view its execution log (the lead is the session itself, so not passed).
 */
export function MemberCard({ row, onOpen }: { row: TeamRow; onOpen?(): void }) {
  const colors = useColors()
  const header = (
    <View style={{ minHeight: 56, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <MemberMark row={row} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 15, lineHeight: 20, fontWeight: '600', color: colors.ink }}>
          {row.name}
        </Text>
        {row.model ? (
          <Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: colors.ink3 }}>
            {row.model}
          </Text>
        ) : null}
      </View>
      <Text style={{ flexShrink: 0, fontSize: 13, fontWeight: '500', color: memberTone(row, colors) }}>{row.state}</Text>
      {onOpen ? <Icon name="chevron-right" size={15} color={colors.ink3} strokeWidth={2.2} /> : null}
    </View>
  )
  return (
    <View style={card(colors)}>
      {onOpen ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${row.name}, ${row.state}, view execution log`}
          onPress={onOpen}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          {header}
        </Pressable>
      ) : (
        <View accessible accessibilityLabel={`${row.name}, ${row.state}`}>
          {header}
        </View>
      )}
      <TaskLines tasks={row.tasks} />
    </View>
  )
}

/** Tasks on the team board not yet claimed by anyone. */
export function UnassignedCard({ tasks }: { tasks: TeamTask[] }) {
  const colors = useColors()
  return (
    <View style={card(colors)}>
      <View accessibilityRole="header" style={{ height: 40, paddingHorizontal: 14, justifyContent: 'center' }}>
        <Text style={{ fontSize: 13, fontWeight: '600', color: colors.ink2 }}>{`Unclaimed · ${tasks.length}`}</Text>
      </View>
      <TaskLines tasks={tasks} />
    </View>
  )
}
