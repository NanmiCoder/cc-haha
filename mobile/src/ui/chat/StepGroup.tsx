import { memo, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { Text } from '../Text'
import type { ChatItem } from '../../core/types'
import { DiffView, HaloDot, Icon, Mono, Spinner, useColors } from '../kit'
import {
  activityLabel,
  describeStep,
  groupTail,
  editDiff,
  formatInput,
  groupIsOpen,
  outputTail,
  stepInput,
  type ChatRow,
  type StepState,
} from './steps'

export type StepContext = {
  workDir?: string | null
  /** 正在等审批的工具调用。 */
  waiting: ReadonlySet<string>
  /** 仍在后台运行的子 Agent / 命令对应的工具调用。 */
  background: ReadonlySet<string>
  activeThinkingId?: string
  turnActive: boolean
}

export type StepUi = {
  expanded: ReadonlySet<string>
  open: ReadonlySet<string>
  /** 手动收起的运行中步骤组，不随下一步的流式更新重新展开。 */
  closed: ReadonlySet<string>
  /** 不再使用（摘要行取代了“前面还有 N 步”）；保留字段让聊天页的 state 形状不变。 */
  revealed: ReadonlySet<string>
}


function stepState(item: ChatItem, live: boolean, context: StepContext): StepState {
  if (item.type === 'thinking')
    return live && context.turnActive && context.activeThinkingId === item.id ? 'running' : 'done'
  if (item.toolUseId && context.waiting.has(item.toolUseId)) return 'waiting'
  if (item.isError) return 'error'
  if (item.toolUseId && context.background.has(item.toolUseId)) return 'background'
  // 中途打开的会话里，历史记录中的进行中工具没有 pending 标记，只是还没有结果。
  const unfinished = item.pending || item.result === undefined
  if (unfinished && live && context.turnActive) return 'running'
  return unfinished ? 'missing' : 'done'
}

function Marker({ state }: { state: StepState }) {
  const colors = useColors()
  if (state === 'running')
    return (
      <View
        style={{
          position: 'absolute',
          left: -21,
          top: 10,
          width: 12,
          height: 12,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Spinner size={12} thickness={2.5} />
      </View>
    )
  if (state === 'waiting')
    return (
      <View style={{ position: 'absolute', left: -19, top: 12 }}>
        <HaloDot size={8} />
      </View>
    )
  return (
    <View
      style={{
        position: 'absolute',
        left: -19,
        top: 12,
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: colors.bg,
        boxShadow: `inset 0 0 0 1.5px ${state === 'error' ? colors.err : colors.faint}`,
      }}
    />
  )
}

function Trailing({ item, state, label }: { item: ChatItem; state: StepState; label: ReturnType<typeof describeStep> }) {
  const colors = useColors()
  if (state === 'waiting')
    return <Text style={{ fontSize: 12.5, color: colors.attn, flexShrink: 0 }}>等你批准</Text>
  if (state === 'error')
    return <Text style={{ fontSize: 12.5, color: colors.err, flexShrink: 0 }}>失败</Text>
  if (state === 'background')
    return <Text style={{ fontSize: 12.5, color: colors.run, flexShrink: 0 }}>后台进行中</Text>
  if (item.type === 'tool' && (label.added || label.removed))
    return (
      <View style={{ flexDirection: 'row', gap: 8, flexShrink: 0 }}>
        {label.added ? <Mono style={{ fontSize: 12.5, color: colors.add }}>+{label.added}</Mono> : null}
        {label.removed ? <Mono style={{ fontSize: 12.5, color: colors.del }}>−{label.removed}</Mono> : null}
      </View>
    )
  return null
}

function StepText({ label }: { label: ReturnType<typeof describeStep> }) {
  const colors = useColors()
  return (
    <>
      <Text style={{ fontSize: 14, color: colors.ink2, flexShrink: 0 }}>{label.verb}</Text>
      {label.object ? (
        label.mono ? (
          <Mono numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 13, color: colors.ink }}>
            {label.object}
          </Mono>
        ) : (
          <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 14, color: colors.ink }}>
            {label.object}
          </Text>
        )
      ) : (
        <View style={{ flex: 1 }} />
      )}
    </>
  )
}

function StepRow({
  item,
  live,
  context,
  onToggle,
}: {
  item: ChatItem
  live: boolean
  context: StepContext
  onToggle(id: string): void
}) {
  const label = describeStep(item, context.workDir)
  const state = stepState(item, live, context)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[label.verb, label.object].filter(Boolean).join(' ')}
      accessibilityHint="展开这一步的详情"
      onPress={() => onToggle(item.id)}
      style={({ pressed }) => ({
        height: 32,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Marker state={state} />
      <StepText label={label} />
      <Trailing item={item} state={state} label={label} />
    </Pressable>
  )
}

function CodeText({ children }: { children: ReactNode }) {
  const colors = useColors()
  return (
    <View
      style={{
        backgroundColor: colors.code,
        marginHorizontal: 8,
        marginBottom: 8,
        borderRadius: 10,
        paddingVertical: 10,
        paddingHorizontal: 12,
      }}
    >
      <Mono selectable style={{ fontSize: 12.5, lineHeight: 19, color: colors.ink2 }}>
        {children}
      </Mono>
    </View>
  )
}

function Omitted({ count, after }: { count: number; after?: boolean }) {
  const colors = useColors()
  if (!count) return null
  return (
    <Mono style={{ color: colors.ink3 }}>
      {after ? `\n… 还有 ${count} 行` : `… 前面省略 ${count} 行\n`}
    </Mono>
  )
}

function StepDetail({ item, state }: { item: ChatItem; state: StepState }) {
  const colors = useColors()
  if (item.type === 'thinking')
    return (
      <Text
        selectable
        style={{ fontSize: 14, lineHeight: 21, color: colors.ink2, paddingHorizontal: 12, paddingBottom: 12 }}
      >
        {item.text}
      </Text>
    )
  const input = stepInput(item)
  const name = item.toolName ?? ''
  const output = outputTail(item.text ?? '')
  const empty =
    state === 'running' ? '正在运行…' : state === 'missing' ? '没有拿到结果' : '（没有输出）'
  if (name === 'Bash' || name === 'PowerShell') {
    const command = typeof input?.command === 'string' ? input.command : ''
    return (
      <CodeText>
        {command ? <Mono style={{ color: colors.ink }}>{`$ ${command}`}</Mono> : null}
        {command && output.text ? '\n' : null}
        <Omitted count={output.omitted} />
        {output.text || empty}
      </CodeText>
    )
  }
  if (name === 'Edit' || name === 'MultiEdit') {
    const lines = editDiff(input)
    if (lines.length) {
      const shown = lines.slice(0, 80)
      return (
        <View
          style={{
            marginHorizontal: 8,
            marginBottom: 8,
            borderRadius: 10,
            overflow: 'hidden',
            backgroundColor: colors.code,
          }}
        >
          <DiffView
            numbers="single"
            lines={
              lines.length > shown.length
                ? [...shown, { kind: 'meta', text: `… 还有 ${lines.length - shown.length} 行` }]
                : shown
            }
          />
          {item.isError && output.text ? (
            <Mono selectable style={{ fontSize: 12.5, lineHeight: 19, color: colors.err, padding: 12 }}>
              {output.text}
            </Mono>
          ) : null}
        </View>
      )
    }
  }
  if (name === 'Write' && typeof input?.content === 'string') {
    const all = input.content.replace(/\n$/, '').split('\n')
    return (
      <CodeText>
        {all.slice(0, 12).join('\n')}
        <Omitted count={Math.max(0, all.length - 12)} after />
      </CodeText>
    )
  }
  const formatted = formatInput(input)
  return (
    <CodeText>
      {formatted ? <Mono style={{ color: colors.ink }}>{formatted}</Mono> : null}
      {formatted && output.text ? '\n\n' : null}
      <Omitted count={output.omitted} />
      {output.text}
      {!output.text ? `${formatted ? '\n\n' : ''}${empty}` : null}
    </CodeText>
  )
}

function StepCard({
  item,
  live,
  context,
  onToggle,
}: {
  item: ChatItem
  live: boolean
  context: StepContext
  onToggle(id: string): void
}) {
  const colors = useColors()
  const label = describeStep(item, context.workDir)
  const state = stepState(item, live, context)
  return (
    <View style={{ backgroundColor: colors.card, borderRadius: 14, overflow: 'hidden' }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[label.verb, label.object].filter(Boolean).join(' ')}
        accessibilityHint="收起详情"
        accessibilityState={{ expanded: true }}
        onPress={() => onToggle(item.id)}
        style={({ pressed }) => ({
          minHeight: 40,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 12,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        {state === 'running' ? (
          <Spinner size={14} thickness={2.4} />
        ) : state === 'waiting' ? (
          <View style={{ width: 15, alignItems: 'center' }}>
            <HaloDot size={8} />
          </View>
        ) : state === 'error' ? (
          <Icon name="circle-alert" size={15} color={colors.err} strokeWidth={2.2} />
        ) : item.type === 'thinking' ? (
          <Icon name="sparkle" size={15} color={colors.ink3} strokeWidth={2} />
        ) : state === 'missing' ? (
          <View style={{ width: 15, alignItems: 'center' }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, boxShadow: `inset 0 0 0 1.5px ${colors.faint}` }} />
          </View>
        ) : (
          <Icon name="check" size={15} color={colors.ok} strokeWidth={2.4} />
        )}
        <StepText label={label} />
        <Trailing item={item} state={state} label={label} />
        <Icon name="chevron-up" size={14} color={colors.ink3} strokeWidth={2.2} />
      </Pressable>
      <StepDetail item={item} state={state} />
    </View>
  )
}

/** 一轮结束后的“用时 3 分 12 秒 ›”：点开看这一轮的摘要行。 */
export const TurnFold = memo(function TurnFold({
  label,
  open,
  onToggle,
}: {
  label: string
  open: boolean
  onToggle(): void
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={open ? '收起处理过程' : `展开处理过程，${label}`}
      accessibilityState={{ expanded: open }}
      onPress={onToggle}
      hitSlop={6}
      style={({ pressed }) => ({
        alignSelf: 'flex-start',
        height: 32,
        marginTop: 4,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text style={{ fontSize: 14, color: colors.ink3 }}>{label}</Text>
      <Icon name={open ? 'chevron-down' : 'chevron-right'} size={15} color={colors.ink3} strokeWidth={2.2} />
    </Pressable>
  )
})

/**
 * 运行中在消息流里展开完整步骤时间线，包含正在执行的一步；读者仍可手动收起。
 * 结束后的历史组默认折成“已读 3 个文件 · 运行 2 条命令 ›”，点一下在原地展开。
 */
export const StepGroup = memo(function StepGroup({
  row,
  context,
  ui,
  onToggleStep,
  onToggleOpen,
}: {
  row: Extract<ChatRow, { kind: 'steps' }>
  context: StepContext
  ui: StepUi
  onToggleStep(id: string): void
  onToggleOpen(key: string, live?: boolean): void
  /** @deprecated 不再需要“前面还有 N 步”；保留是为了聊天页接线不变。 */
  onReveal?(key: string): void
}) {
  const colors = useColors()
  const open = groupIsOpen(ui, row.key, row.live)
  const states = new Map(row.steps.map((item) => [item, stepState(item, row.live, context)] as const))
  const shown = row.steps
  const segments = row.segments
  const tail = groupTail(shown.map((item) => states.get(item) ?? 'done'))
  const label = activityLabel(segments)
  const divider = row.turnEnd ? (
    <View aria-hidden style={{ height: 1, backgroundColor: colors.hair, marginTop: 6, marginBottom: 4 }} />
  ) : null
  if (!shown.length) return divider
  const tailColor = tail?.tone === 'err' ? colors.err : tail?.tone === 'run' ? colors.run : colors.attn
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[label, tail?.text].filter(Boolean).join('，')}
        accessibilityHint={open ? '收起步骤' : '展开步骤'}
        accessibilityState={{ expanded: open }}
        onPress={() => onToggleOpen(row.key, row.live)}
        hitSlop={4}
        style={({ pressed }) => ({
          minHeight: 32,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Icon name={segments.at(-1)?.icon ?? 'terminal'} size={16} color={colors.ink3} strokeWidth={1.9} />
        <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 14, color: colors.ink3 }}>
          {label}
        </Text>
        <Icon
          name={open ? 'chevron-down' : 'chevron-right'}
          size={15}
          color={colors.ink3}
          strokeWidth={2.2}
        />
        {tail ? (
          <Text style={{ fontSize: 12.5, color: tailColor, flexShrink: 0 }}>{tail.text}</Text>
        ) : null}
      </Pressable>
      {open ? (
        <View
          style={{
            borderLeftWidth: 1.5,
            borderLeftColor: colors.hair,
            marginLeft: 6,
            marginTop: 2,
            paddingLeft: 14,
          }}
        >
          {shown.map((item) =>
            ui.expanded.has(item.id) ? (
              <View key={item.id} style={{ marginVertical: 4 }}>
                <StepCard item={item} live={row.live} context={context} onToggle={onToggleStep} />
              </View>
            ) : (
              <StepRow key={item.id} item={item} live={row.live} context={context} onToggle={onToggleStep} />
            )
          )}
        </View>
      ) : null}
      {divider}
    </View>
  )
})
