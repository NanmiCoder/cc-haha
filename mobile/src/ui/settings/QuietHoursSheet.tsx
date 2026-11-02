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
 * 勿扰时段：开关和起止时间都是草稿，点「完成」统一校验后一次写入；
 * 取消或下滑关闭不改已保存的设置。调用方每次打开时换 key，让草稿从已保存的值开始。
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
      title="勿扰时段"
      left={<TextButton title="取消" disabled={saving} onPress={onClose} />}
      right={<TextButton title="完成" strong disabled={saving} onPress={() => void done()} />}
    >
      <Group style={{ marginTop: 4 }}>
        <ListRow
          title="启用"
          trailing={
            <Switch
              label="启用勿扰时段"
              value={draft.enabled}
              disabled={saving}
              onValueChange={(enabled) => set({ enabled })}
            />
          }
        />
        <Separator />
        <FieldRow
          label="开始"
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
          label="结束"
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
          {hint || '这段时间里不推送通知。时间用 24 小时制，比如 23:00。'}
        </Footnote>
      )}
    </Sheet>
  )
}
