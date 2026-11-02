import { useState } from 'react'
import { View } from 'react-native'
import { Text } from '../Text'
import {
  Button,
  Callout,
  DiffStat,
  Group,
  Icon,
  InlineError,
  ListRow,
  OptionCard,
  Separator,
  Sheet,
  type,
  useColors,
} from '../kit'
import type { Checkpoint, RewindMode } from '../../core/operations'
import {
  checkpointsNewestFirst,
  rewindChoices,
  rewindRisks,
  turnNumber,
} from '../../core/changesView'

/** 换一轮：最新的在上，每行“第 N 轮 · N 个文件”+ 增删，当前轮打勾。 */
export function TurnSheet({
  visible,
  onClose,
  checkpoints,
  selectedId,
  onSelect,
}: {
  visible: boolean
  onClose(): void
  checkpoints: readonly Checkpoint[]
  selectedId?: string
  onSelect(targetUserMessageId: string): void
}) {
  const colors = useColors()
  return (
    <Sheet visible={visible} onClose={onClose} title="换一轮">
      <Group>
        {checkpointsNewestFirst(checkpoints).map((item, index) => {
          const id = item.target.targetUserMessageId
          const selected = id === selectedId
          const title = `第 ${turnNumber(item)} 轮 · ${item.code.filesChanged.length} 个文件`
          return (
            <View key={id}>
              {index ? <Separator /> : null}
              <ListRow
                title={title}
                accessibilityLabel={`${title}${selected ? '，当前' : ''}`}
                onPress={() => onSelect(id)}
                trailing={
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <DiffStat added={item.code.insertions} removed={item.code.deletions} />
                    <View style={{ width: 18, alignItems: 'center' }}>
                      {selected ? (
                        <Icon name="check" size={18} color={colors.run} strokeWidth={2.4} />
                      ) : null}
                    </View>
                  </View>
                }
              />
            </View>
          )
        })}
      </Group>
    </Sheet>
  )
}

/** 回退确认：范围三选一（数字来自 dryRun）、风险说明、取消 / 回退。 */
export function RewindSheet({
  preview,
  mode,
  onMode,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  preview: Checkpoint | null
  mode: RewindMode
  onMode(mode: RewindMode): void
  busy: boolean
  error?: string
  onCancel(): void
  onConfirm(): void
}) {
  const colors = useColors()
  // 关闭动画期间 preview 已清空，沿用上一次的内容，避免弹层内容先消失。
  const [last, setLast] = useState(preview)
  if (preview && preview !== last) setLast(preview)
  const shown = preview ?? last
  const choices = shown ? rewindChoices(shown) : []
  const risks = shown ? rewindRisks(shown, mode) : []
  return (
    <Sheet
      visible={!!preview}
      onClose={onCancel}
      dismissable={!busy}
      footer={
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            title="取消"
            variant="secondary"
            size="lg"
            disabled={busy}
            onPress={onCancel}
            style={{ flex: 1 }}
          />
          <Button
            title="回退"
            variant="destructive"
            size="lg"
            busy={busy}
            onPress={onConfirm}
            style={{ flex: 1 }}
          />
        </View>
      }
    >
      {shown ? (
        <>
          <View style={{ gap: 4, paddingHorizontal: 4 }}>
            <Text accessibilityRole="header" style={[type.title, { color: colors.ink }]}>
              回到第 {turnNumber(shown)} 轮开始之前
            </Text>
            <Text style={{ fontSize: 14, lineHeight: 20, color: colors.ink2 }}>
              会先停下当前的运行。
            </Text>
          </View>
          <View accessibilityRole="radiogroup" accessibilityLabel="回退范围" style={{ gap: 8 }}>
            {choices.map((choice) => (
              <OptionCard
                key={choice.mode}
                tone="err"
                selected={mode === choice.mode}
                title={choice.title}
                description={choice.description}
                disabled={choice.disabled || busy}
                background={colors.card}
                onPress={() => onMode(choice.mode)}
              />
            ))}
          </View>
          {risks.length ? <Callout>{risks.join('\n')}</Callout> : null}
          <InlineError text={error} />
        </>
      ) : null}
    </Sheet>
  )
}
