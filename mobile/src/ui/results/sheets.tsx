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
import { plural } from '../../core/plural'

/** Switch turn: newest on top, each row "Turn N · N files" + line stats, with the current turn checked. */
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
    <Sheet visible={visible} onClose={onClose} title="Switch turn">
      <Group>
        {checkpointsNewestFirst(checkpoints).map((item, index) => {
          const id = item.target.targetUserMessageId
          const selected = id === selectedId
          const title = `Turn ${turnNumber(item)} · ${plural(item.code.filesChanged.length, 'file')}`
          return (
            <View key={id}>
              {index ? <Separator /> : null}
              <ListRow
                title={title}
                accessibilityLabel={`${title}${selected ? ', current' : ''}`}
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

/** Rewind confirmation: choose one of three scopes (numbers from dryRun), risk notes, cancel / rewind. */
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
  // During the close animation preview is already cleared, so keep the last content to avoid the sheet content vanishing first.
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
            title="Cancel"
            variant="secondary"
            size="lg"
            disabled={busy}
            onPress={onCancel}
            style={{ flex: 1 }}
          />
          <Button
            title="Rewind"
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
              Back to before turn {turnNumber(shown)} started
            </Text>
            <Text style={{ fontSize: 14, lineHeight: 20, color: colors.ink2 }}>
              The current run will be stopped first.
            </Text>
          </View>
          <View accessibilityRole="radiogroup" accessibilityLabel="Rewind scope" style={{ gap: 8 }}>
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
