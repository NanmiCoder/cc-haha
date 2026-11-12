import { useState } from 'react'
import {
  FieldRow,
  Footnote,
  Group,
  InlineError,
  ListRow,
  Separator,
  Sheet,
  Switch,
  TextButton,
} from '../kit'
import { errorText } from '../theme'
import { quietHint, validateQuietHours, type QuietHours } from './settingsModel'

/**
 * Quiet hours: the toggle and start/end times are drafts, validated together and written once on "Done"; 
 * canceling or swiping down does not change saved settings. The caller changes the key on each open so the draft starts from the saved values.
 */
export function QuietHoursSheet({
  visible,
  initial,
  onClose,
  onSave,
}: {
  visible: boolean
  initial: QuietHours
  onClose(): void
  onSave(value: QuietHours): Promise<void>
}) {
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<QuietHours>) => {
    setDraft((current) => ({ ...current, ...patch }))
    setError('')
  }
  async function done() {
    if (saving) return
    const checked = validateQuietHours(draft)
    if (checked.error !== undefined) {
      setError(checked.error)
      return
    }
    setSaving(true)
    try {
      await onSave(checked.value)
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }
  const hint = quietHint(draft)
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      dismissable={!saving}
      title="Quiet hours"
      left={<TextButton title="Cancel" disabled={saving} onPress={onClose} />}
      right={<TextButton title="Done" strong disabled={saving} onPress={() => void done()} />}
    >
      <Group style={{ marginTop: 4 }}>
        <ListRow
          title="Enabled"
          trailing={
            <Switch
              label="Enable quiet hours"
              value={draft.enabled}
              disabled={saving}
              onValueChange={(enabled) => set({ enabled })}
            />
          }
        />
        <Separator />
        <FieldRow
          label="Start"
          mono
          value={draft.start}
          onChangeText={(start) => set({ start })}
          placeholder="23:00"
          keyboardType="numbers-and-punctuation"
          maxLength={5}
          editable={!saving}
          returnKeyType="next"
        />
        <Separator />
        <FieldRow
          label="End"
          mono
          value={draft.end}
          onChangeText={(end) => set({ end })}
          placeholder="08:00"
          keyboardType="numbers-and-punctuation"
          maxLength={5}
          editable={!saving}
          returnKeyType="done"
          onSubmitEditing={() => void done()}
        />
      </Group>
      {error ? (
        <InlineError text={error} />
      ) : (
        <Footnote style={{ paddingTop: 0 }}>
          {hint || 'No notifications are pushed during this period. Use 24-hour time, e.g. 23:00.'}
        </Footnote>
      )}
    </Sheet>
  )
}
