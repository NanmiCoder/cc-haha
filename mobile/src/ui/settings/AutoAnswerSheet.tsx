import { useState } from 'react'
import { View } from 'react-native'
import {
  Footnote,
  Group,
  Icon,
  InlineError,
  ListRow,
  Separator,
  Sheet,
  Spinner,
  useColors,
} from '../kit'
import { errorText } from '../theme'
import {
  autoAnswerLabel,
  autoAnswerMinutes,
  selectedMinutes,
  type AutoQuestion,
} from './settingsModel'

/** AI Auto-answer wait time: tapping a tier writes it to the current computer immediately, collapsing on success. */
export function AutoAnswerSheet({
  visible,
  hostName,
  current,
  onClose,
  onSelect,
}: {
  visible: boolean
  hostName: string
  current: AutoQuestion
  onClose(): void
  onSelect(minutes: number): Promise<void>
}) {
  const colors = useColors()
  const [saving, setSaving] = useState<number | null>(null)
  const [error, setError] = useState('')
  const selected = selectedMinutes(current)
  async function choose(minutes: number) {
    if (saving !== null) return
    if (minutes === selected) {
      onClose()
      return
    }
    setSaving(minutes)
    setError('')
    try {
      await onSelect(minutes)
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(null)
    }
  }
  return (
    <Sheet visible={visible} onClose={onClose} dismissable={saving === null} title="AI Auto-answer">
      <Group style={{ marginTop: 4 }}>
        {autoAnswerMinutes.map((minutes, index) => (
          <View key={minutes}>
            {index > 0 && <Separator />}
            <ListRow
              title={autoAnswerLabel(minutes)}
              accessibilityLabel={minutes ? `Auto-answer after ${minutes} minutes` : 'No auto-answer'}
              disabled={saving !== null && saving !== minutes}
              onPress={() => void choose(minutes)}
              trailing={
                saving === minutes ? (
                  <Spinner size={16} />
                ) : minutes === selected ? (
                  <Icon name="check" size={18} color={colors.run} strokeWidth={2.4} />
                ) : null
              }
            />
          </View>
        ))}
      </Group>
      {error ? (
        <InlineError text={error} />
      ) : (
        <Footnote style={{ paddingTop: 0 }}>
          {`When a question goes unanswered for this long, AI answers with the recommended option; tool approvals are never auto-answered. Applies only to ${hostName} and is saved on that computer.`}
        </Footnote>
      )}
    </Sheet>
  )
}
