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
  stepImages,
  stepInput,
  type ChatRow,
  type NamedToolImage,
  type StepState,
} from './steps'
import { ToolImageStrip } from './ToolImages'
import { plural } from '../../core/plural'

export type StepContext = {
  workDir?: string | null
  /** Tool call waiting for approval. */
  waiting: ReadonlySet<string>
  /** Tool calls of subagents / commands still running in background. */
  background: ReadonlySet<string>
  activeThinkingId?: string
  turnActive: boolean
}

export type StepUi = {
  expanded: ReadonlySet<string>
  open: ReadonlySet<string>
  /** A running step group collapsed manually does not re-expand with the next step's streaming update. */
  closed: ReadonlySet<string>
  /** No longer used (summary rows replaced "N earlier steps"); field kept so the chat page state shape is unchanged. */
  revealed: ReadonlySet<string>
}


function stepState(item: ChatItem, live: boolean, context: StepContext): StepState {
  if (item.type === 'thinking')
    return live && context.turnActive && context.activeThinkingId === item.id ? 'running' : 'done'
  if (item.toolUseId && context.waiting.has(item.toolUseId)) return 'waiting'
  if (item.isError) return 'error'
  if (item.toolUseId && context.background.has(item.toolUseId)) return 'background'
  // In sessions opened midway, in-progress tools in history have no pending flag; they just have no result yet.
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
    return <Text style={{ fontSize: 12.5, color: colors.attn, flexShrink: 0 }}>Waiting for your approval</Text>
  if (state === 'error')
    return <Text style={{ fontSize: 12.5, color: colors.err, flexShrink: 0 }}>Failed</Text>
  if (state === 'background')
    return <Text style={{ fontSize: 12.5, color: colors.run, flexShrink: 0 }}>Running in background</Text>
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
      accessibilityHint="Expand details of this step"
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
      {after ? `\n… ${plural(count, 'more line')}` : `… ${plural(count, 'earlier line')} omitted\n`}
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
    state === 'running' ? 'Running…' : state === 'missing' ? 'No result received' : '(no output)'
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
                ? [...shown, { kind: 'meta', text: `… ${plural(lines.length - shown.length, 'more line')}` }]
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
        accessibilityHint="Collapse details"
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

/** "Took 3 min 12 sec ›" after a turn ends: tap to see this turn's summary rows. */
export const TurnFold = memo(function TurnFold({
  label,
  open,
  onToggle,
  images,
}: {
  label: string
  open: boolean
  onToggle(): void
  /** Images that must stay visible when collapsed (the point of asking the computer to send a screenshot is to see it). */
  images?: NamedToolImage[]
}) {
  const colors = useColors()
  const fold = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={open ? 'Collapse process' : `Expand process, ${label}`}
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
  if (open || !images?.length) return fold
  return (
    <View>
      {fold}
      <ToolImageStrip images={images} />
    </View>
  )
})

/**
 * While running, the full step timeline expands in the message stream, including the step in progress; readers can still collapse it manually.
 * After finishing, history groups collapse by default into "Read 3 files · Ran 2 commands ›", expanding in place on tap.
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
  /** @deprecated "N earlier steps" is no longer needed; kept so chat page wiring stays unchanged. */
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
  // Same as desktop: when expanded images hang under their steps; when collapsed they gather under the summary row.
  const folded = open ? [] : shown.flatMap(stepImages)
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[label, tail?.text].filter(Boolean).join(', ')}
        accessibilityHint={open ? 'Collapse steps' : 'Expand steps'}
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
      {folded.length ? <ToolImageStrip images={folded} /> : null}
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
          {shown.map((item) => {
            const images = stepImages(item)
            return (
              <View key={item.id}>
                {ui.expanded.has(item.id) ? (
                  <View style={{ marginVertical: 4 }}>
                    <StepCard item={item} live={row.live} context={context} onToggle={onToggleStep} />
                  </View>
                ) : (
                  <StepRow item={item} live={row.live} context={context} onToggle={onToggleStep} />
                )}
                {images.length ? <ToolImageStrip images={images} /> : null}
              </View>
            )
          })}
        </View>
      ) : null}
      {divider}
    </View>
  )
})
