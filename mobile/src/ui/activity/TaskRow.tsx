import { Pressable, View, type ViewStyle } from 'react-native'
import { isAgent, type BackgroundTask } from '../../core/operations'
import { Mono, StatusGlyph, useColors } from '../kit'
import { Text } from '../Text'
import { outputPreview, taskGlyph, taskSubline, taskTitle } from './taskLabels'

/**
 * One background task row (Activity design): status · title · subline · (while running) stop capsule; 
 * two lines of output preview under running commands. Tap the body to open output; whole-computer mode is read-only and tapping a row enters the session.
 */
export function TaskRow({
  task,
  now,
  onOpen,
  onStop,
  stopDisabled,
  stopping,
}: {
  task: BackgroundTask
  now: number
  onOpen?(): void
  /** When omitted it is read-only: no stop button. */
  onStop?(): void
  stopDisabled?: boolean
  stopping?: boolean
}) {
  const colors = useColors()
  const running = task.status === 'running'
  const agent = isAgent(task)
  const title = taskTitle(task)
  const line = taskSubline(task, now)
  const preview = outputPreview(task)
  const showStop = running && !!onStop
  const lineColor = line.tone === 'err' ? colors.err : colors.ink3
  const head = (
    <>
      <StatusGlyph status={taskGlyph(task.status)} size={15} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        {agent ? (
          <Text
            numberOfLines={1}
            style={{
              fontSize: 16,
              lineHeight: 22,
              fontWeight: '500',
              color: task.status === 'stopped' ? colors.ink2 : colors.ink,
            }}
          >
            {title}
          </Text>
        ) : (
          <Mono
            numberOfLines={1}
            style={{
              fontSize: 14.5,
              lineHeight: 22,
              fontWeight: '500',
              color: task.status === 'stopped' ? colors.ink2 : colors.ink,
            }}
          >
            {title}
          </Mono>
        )}
        {line.mono ? (
          <Mono numberOfLines={1} style={{ fontSize: 12.5, lineHeight: 17, color: lineColor }}>
            {line.text}
          </Mono>
        ) : (
          <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 17, color: lineColor }}>
            {line.text}
          </Text>
        )}
      </View>
    </>
  )
  return (
    <View
      style={{
        paddingTop: 13,
        paddingBottom: 13,
        paddingLeft: 14,
        paddingRight: showStop ? 10 : 14,
        gap: 10,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        {onOpen ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`View output of ${title}`}
            onPress={onOpen}
            style={({ pressed }) => ({
              flex: 1,
              minWidth: 0,
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: 10,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            {head}
          </Pressable>
        ) : (
          <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
            {head}
          </View>
        )}
        {showStop && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Stop ${title}`}
            accessibilityState={{ disabled: stopDisabled, busy: stopping }}
            disabled={stopDisabled}
            onPress={onStop}
            hitSlop={4}
            style={({ pressed }) => ({
              height: 34,
              paddingHorizontal: 12,
              borderRadius: 17,
              backgroundColor: colors.fill,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: stopDisabled ? 0.45 : pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ fontSize: 14, fontWeight: '600', color: colors.err }}>
              {stopping ? 'Stopping' : 'Stop'}
            </Text>
          </Pressable>
        )}
      </View>
      {preview.length > 0 && <OutputPreview lines={preview} title={title} onOpen={onOpen} />}
    </View>
  )
}

/** Two-line output preview of a running command; not tappable in read-only mode. */
function OutputPreview({
  lines,
  title,
  onOpen,
}: {
  lines: string[]
  title: string
  onOpen?(): void
}) {
  const colors = useColors()
  const box: ViewStyle = {
    marginLeft: 26,
    backgroundColor: colors.code,
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 11,
  }
  const content = lines.map((text, index) => (
    <Mono key={index} numberOfLines={1} style={{ fontSize: 12, lineHeight: 18, color: colors.ink2 }}>
      {text}
    </Mono>
  ))
  if (!onOpen) return <View style={box}>{content}</View>
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`View full output of ${title}`}
      onPress={onOpen}
      style={({ pressed }) => [box, { opacity: pressed ? 0.7 : 1 }]}
    >
      {content}
    </Pressable>
  )
}
