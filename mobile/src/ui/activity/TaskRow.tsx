import { Pressable, View, type ViewStyle } from 'react-native'
import { isAgent, type BackgroundTask } from '../../core/operations'
import { Mono, StatusGlyph, useColors } from '../kit'
import { Text } from '../Text'
import { outputPreview, taskGlyph, taskSubline, taskTitle } from './taskLabels'

/**
 * 后台任务一行（Activity 稿）：状态 · 标题 · 副行 ·（运行中）停止胶囊；
 * 运行中的命令下方两行输出预览。点主体打开输出，整机模式只读、点行进会话。
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
  /** 不传时只读：不出现停止按钮。 */
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
            accessibilityLabel={`查看 ${title} 输出`}
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
            accessibilityLabel={`停止 ${title}`}
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
              {stopping ? '停止中' : '停止'}
            </Text>
          </Pressable>
        )}
      </View>
      {preview.length > 0 && <OutputPreview lines={preview} title={title} onOpen={onOpen} />}
    </View>
  )
}

/** 运行中命令的两行输出预览；只读模式下不可点。 */
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
      accessibilityLabel={`查看 ${title} 完整输出`}
      onPress={onOpen}
      style={({ pressed }) => [box, { opacity: pressed ? 0.7 : 1 }]}
    >
      {content}
    </Pressable>
  )
}
