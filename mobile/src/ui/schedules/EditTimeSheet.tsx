import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ScheduledTask } from '../../core/operations'
import { scheduleDraftForTask, scheduleUpdate } from '../../core/scheduleDraft'
import { Button, Callout, InlineError, PageSheet } from '../kit'
import { KeyboardViewport } from '../KeyboardViewport'
import { ScheduleFields } from './ScheduleFields'

export function EditTimeSheet({ visible, task, busy, error, onSave, onClose }: {
  visible: boolean
  task: ScheduledTask
  busy: boolean
  error: string
  onSave(update: NonNullable<ReturnType<typeof scheduleUpdate>>): void
  onClose(): void
}) {
  const insets = useSafeAreaInsets()
  // Keep the revision the user opened; background refresh must not authorize overwriting a newer plan.
  const [original] = useState(task)
  const [draft, setDraft] = useState(() => scheduleDraftForTask(task))
  const [invalid, setInvalid] = useState('')
  const save = () => {
    if (busy) return
    try {
      const update = scheduleUpdate(draft, original)
      setInvalid('')
      if (update) onSave(update)
      else onClose()
    } catch (e) { setInvalid((e as Error).message) }
  }
  return <PageSheet visible={visible} onClose={() => { if (!busy) onClose() }} title="Change run time">
    <KeyboardViewport style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 12 }}>
        {!original.schedule && draft.legacy && draft.frequency !== 'once' ? <Callout>The old schedule uses the computer’s local time zone; {original.recurring === false ? 'Run once only' : 'Repeat per the original rule'}. After choosing a quick schedule, once only, or a specific time zone, the new schedule will be used.</Callout> : null}
        <ScheduleFields value={draft} originalSchedule={original.schedule} disabled={busy} onChange={value => { setDraft(value); setInvalid('') }} />
        <InlineError text={invalid || error} />
      </ScrollView>
      <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: Math.max(insets.bottom, 16) }}><Button title="Save" size="lg" busy={busy} onPress={save} /></View>
    </KeyboardViewport>
  </PageSheet>
}
