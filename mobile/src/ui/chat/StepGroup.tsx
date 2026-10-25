import { memo, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { Text } from '../Text'
import type { ChatItem } from '../../core/types'
import { DiffView, HaloDot, Icon, Mono, Spinner, useColors } from '../kit'
import {
  collapsible,
  describeStep,
  editDiff,
  formatInput,
  outputTail,
  stepInput,
  summaryLabel,
  visibleSteps,
  type ChatRow,
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
  revealed: ReadonlySet<string>
}

/** done = 有结果；missing = 这一轮已经结束却没拿到结果（例如被停止）。 */
type StepState = 'running' | 'waiting' | 'background' | 'error' | 'done' | 'missing'

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

function Fold({ label, open, onPress }: { label: string; open: boolean; onPress(): void }) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        alignSelf: 'flex-start',
        height: 32,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} color={colors.ink3} strokeWidth={2.2} />
      <Text style={{ fontSize: 13, color: colors.ink3 }}>{label}</Text>
    </Pressable>
  )
}

/** 工具步骤时间线：左侧发丝竖线，每步一个空心点；结束后的组折成摘要行。 */
export const StepGroup = memo(function StepGroup({
  row,
  context,
  ui,
  onToggleStep,
  onToggleOpen,
  onReveal,
}: {
  row: Extract<ChatRow, { kind: 'steps' }>
  context: StepContext
  ui: StepUi
  onToggleStep(id: string): void
  onToggleOpen(key: string): void
  onReveal(key: string): void
}) {
  const colors = useColors()
  const folded = !row.live && collapsible(row.summary)
  const open = ui.open.has(row.key)
  const timeline = (steps: ChatItem[]) => (
    <View
      style={{
        borderLeftWidth: 1.5,
        borderLeftColor: colors.hair,
        marginLeft: 6,
        paddingLeft: 14,
      }}
    >
      {steps.map((item) =>
        ui.expanded.has(item.id) ? (
          <View key={item.id} style={{ marginVertical: 4 }}>
            <StepCard item={item} live={row.live} context={context} onToggle={onToggleStep} />
          </View>
        ) : (
          <StepRow key={item.id} item={item} live={row.live} context={context} onToggle={onToggleStep} />
        )
      )}
    </View>
  )
  if (folded)
    return (
      <View style={{ gap: open ? 0 : 14 }}>
        <Fold label={summaryLabel(row.summary)} open={open} onPress={() => onToggleOpen(row.key)} />
        {open
          ? timeline(row.steps)
          : row.steps
              .filter((item) => ui.expanded.has(item.id))
              .map((item) => (
                <StepCard key={item.id} item={item} live={false} context={context} onToggle={onToggleStep} />
              ))}
      </View>
    )
  const visible = visibleSteps(row.steps, !row.live || ui.revealed.has(row.key))
  return (
    <View>
      {visible.hidden ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`前面还有 ${visible.hidden} 步，点按展开`}
          onPress={() => onReveal(row.key)}
          hitSlop={6}
          style={({ pressed }) => ({
            alignSelf: 'flex-start',
            height: 32,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Icon name="chevron-down" size={14} color={colors.ink3} strokeWidth={2.2} />
          <Text style={{ fontSize: 13, color: colors.ink3 }}>前面还有 {visible.hidden} 步</Text>
        </Pressable>
      ) : null}
      {timeline(visible.steps)}
    </View>
  )
})
