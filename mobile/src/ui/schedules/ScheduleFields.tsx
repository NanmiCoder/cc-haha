import { useState } from 'react'
import { Pressable, TextInput, View } from 'react-native'
import { applySchedulePreset, scheduleFromDraft, type ScheduleDraft, type SchedulePreset } from '../../core/scheduleDraft'
import { scheduleParts } from '../../core/schedulesView'
import { Group, InlineError, Separator, TextButton, useColors } from '../kit'
import { Text } from '../Text'
import { useNow } from '../activity/useNow'
import { FormRow, TimeField } from './parts'
import type { TaskSchedule } from '../../../../src/shared/taskSchedule'

/** Large, wrapping targets stay usable on narrow screens and with larger text. */
export function ScheduleChoice({ label, selected, disabled, compact, onPress }: { label: string; selected?: boolean; disabled?: boolean; compact?: boolean; onPress(): void }) {
  const colors = useColors()
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ selected, disabled }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => ({ minHeight: 44, minWidth: compact ? 0 : 44, paddingHorizontal: compact ? 0 : 12, paddingVertical: 10, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: selected ? colors.ink : colors.fill, opacity: disabled ? 0.4 : pressed ? 0.65 : 1 })}
  ><Text style={{ fontSize: 14, color: selected ? colors.card : colors.ink, fontWeight: selected ? '600' : '400' }}>{label}</Text></Pressable>
}

const frequencies: { value: ScheduleDraft['frequency']; label: string }[] = [
  { value: 'once', label: 'Once only' }, { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' }, { value: 'specificDays', label: 'Every' },
  { value: 'monthly', label: 'Monthly' }, { value: 'everyNMinutes', label: 'Every few minutes' },
  { value: 'everyNHours', label: 'Every few hours' }, { value: 'customCron', label: 'Custom Cron' },
]
const presets: { value: SchedulePreset; label: string }[] = [
  { value: 'halfHour', label: '30 minutes from now' }, { value: 'tomorrow', label: 'Tomorrow 9 AM' }, { value: 'workdays', label: 'Weekdays 9 AM' },
]
const days = [1, 2, 3, 4, 5, 6, 0]
const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function ScheduleFields({ value, onChange, disabled = false, originalSchedule }: { value: ScheduleDraft; onChange(value: ScheduleDraft): void; disabled?: boolean; originalSchedule?: TaskSchedule }) {
  const colors = useColors()
  const now = useNow(true, 30_000)
  const [more, setMore] = useState(false)
  const [zoneOpen, setZoneOpen] = useState(false)
  const [calendar, setCalendar] = useState(false)
  const [month, setMonth] = useState('')
  const edit = (patch: Partial<ScheduleDraft>) => onChange({ ...value, ...patch })
  const advanced = frequencies.slice(4).some(item => item.value === value.frequency)
  const showTime = ['daily', 'weekdays', 'specificDays', 'monthly'].includes(value.frequency)
  let preview = ''
  let invalid = ''
  try {
    const schedule = scheduleFromDraft(value, now, originalSchedule)
    if (schedule.kind === 'once') preview = `Once only · ${value.runAt.replace('T', ' ')}`
    else {
      const parts = scheduleParts(schedule.expression)
      preview = parts ? `${parts.repeat} ${parts.time}` : schedule.expression
    }
  } catch (e) { invalid = (e as Error).message }
  const inputStyle = { minHeight: 44, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: colors.fill, color: colors.ink, fontSize: 16, flex: 1 }
  const selectedDate = value.runAt.slice(0, 10)
  const shownMonth = month || selectedDate.slice(0, 7)
  const monthDate = new Date(`${shownMonth}-01T12:00:00Z`)
  const monthDays = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 0)).getUTCDate()
  const monthOffset = (monthDate.getUTCDay() + 6) % 7
  const moveMonth = (offset: number) => {
    const date = new Date(monthDate)
    date.setUTCMonth(date.getUTCMonth() + offset)
    setMonth(date.toISOString().slice(0, 7))
  }
  return <View style={{ gap: 12 }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {presets.map(item => <ScheduleChoice key={item.value} label={item.label} disabled={disabled} onPress={() => {
        try { onChange(applySchedulePreset(value, item.value)); setCalendar(false) } catch { setZoneOpen(true) }
      }} />)}
    </View>
    <Group>
      <View style={{ padding: 14, gap: 10 }}>
        <Text style={{ fontSize: 15, color: colors.ink2 }}>Schedule</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {(more || advanced ? frequencies : frequencies.slice(0, 4)).map(item => <ScheduleChoice key={item.value} label={item.label} selected={value.frequency === item.value} disabled={disabled} onPress={() => edit({ frequency: item.value })} />)}
          {!more && !advanced ? <TextButton title="More" disabled={disabled} onPress={() => setMore(true)} /> : null}
        </View>
      </View>
      {showTime ? <><Separator /><FormRow label="Run time" labelFlex><TimeField value={value.time} onChangeText={time => edit({ time })} editable={!disabled} /></FormRow>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 14, paddingBottom: 12 }}>{['09:00', '12:00', '18:00', '21:00'].map(time => <ScheduleChoice key={time} label={time} selected={value.time === time} disabled={disabled} onPress={() => edit({ time })} />)}</View>
      </> : null}
      {value.frequency === 'once' ? <View style={{ paddingHorizontal: 14, paddingBottom: 12, gap: 8 }}>
        <Text style={{ color: colors.ink2 }}>Run date and time</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <ScheduleChoice label={selectedDate} disabled={disabled} onPress={() => { setCalendar(!calendar); setMonth('') }} />
          <TimeField value={value.runAt.slice(11)} onChangeText={time => edit({ runAt: `${selectedDate}T${time}` })} editable={!disabled} />
        </View>
        {calendar ? <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><TextButton title="Previous month" disabled={disabled} onPress={() => moveMonth(-1)} /><Text style={{ color: colors.ink }}>{shownMonth}</Text><TextButton title="Next month" disabled={disabled} onPress={() => moveMonth(1)} /></View>
          <View style={{ flexDirection: 'row' }}>{days.map(day => <Text key={day} style={{ width: `${100 / 7}%`, textAlign: 'center', color: colors.ink3 }}>{dayNames[day]}</Text>)}</View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{Array.from({ length: monthOffset + monthDays }, (_, index) => {
            const day = index - monthOffset + 1
            const date = `${shownMonth}-${String(day).padStart(2, '0')}`
            return <View key={index} style={{ width: `${100 / 7}%`, padding: 1 }}>{day > 0 ? <ScheduleChoice compact label={String(day)} selected={date === selectedDate} disabled={disabled} onPress={() => { edit({ runAt: `${date}T${value.runAt.slice(11)}` }); setCalendar(false) }} /> : null}</View>
          })}</View>
        </View> : null}
      </View> : null}
      {value.frequency === 'specificDays' ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 14 }}>{days.map(day => {
        const selected = value.selectedDays.some(item => item % 7 === day)
        return <ScheduleChoice key={day} label={dayNames[day]} selected={selected} disabled={disabled} onPress={() => edit({ selectedDays: selected ? value.selectedDays.filter(item => item % 7 !== day) : [...value.selectedDays, day] })} />
      })}</View> : null}
      {value.frequency === 'monthly' ? <View style={{ padding: 14, gap: 8 }}>
        <FormRow label="Day of month" labelFlex><TextInput accessibilityLabel="Day of month" value={String(value.monthDay)} onChangeText={text => edit({ monthDay: Number(text) })} keyboardType="number-pad" editable={!disabled} style={[inputStyle, { flex: 0, width: 72 }]} /></FormRow>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{[1, 5, 10, 15, 20, 25, 28].map(day => <ScheduleChoice key={day} label={`${day} th`} selected={day === value.monthDay} disabled={disabled} onPress={() => edit({ monthDay: day })} />)}</View>
        {value.monthDay > 28 ? <Text style={{ fontSize: 13, color: colors.ink3 }}>Months without day {value.monthDay} are skipped.</Text> : null}
      </View> : null}
      {value.frequency === 'everyNMinutes' || value.frequency === 'everyNHours' ? <View style={{ padding: 14, gap: 10 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{(value.frequency === 'everyNMinutes' ? [5, 10, 15, 20, 30] : [1, 2, 3, 4, 6, 8, 12]).map(n => <ScheduleChoice key={n} label={`${n} ${value.frequency === 'everyNMinutes' ? 'Minutes' : 'h'}`} selected={n === (value.frequency === 'everyNMinutes' ? value.minuteInterval : value.hourInterval)} disabled={disabled} onPress={() => edit(value.frequency === 'everyNMinutes' ? { minuteInterval: n } : { hourInterval: n })} />)}</View>
        {value.frequency === 'everyNHours' ? <FormRow label="Minute" labelFlex><TextInput accessibilityLabel="Minute of each hour" value={String(value.minuteOffset)} onChangeText={text => edit({ minuteOffset: Number(text) })} keyboardType="number-pad" editable={!disabled} style={[inputStyle, { flex: 0, width: 72 }]} /></FormRow> : null}
        <Text style={{ fontSize: 13, color: colors.ink3 }}>Triggers on clock ticks, consistent with desktop.</Text>
      </View> : null}
      {value.frequency === 'customCron' ? <View style={{ padding: 14, gap: 6 }}><TextInput accessibilityLabel="Custom Cron" value={value.customCron} onChangeText={customCron => edit({ customCron })} editable={!disabled} autoCapitalize="none" autoCorrect={false} placeholder="0 9 * * 1-5" placeholderTextColor={colors.ink3} style={inputStyle} /><Text style={{ fontSize: 12, color: colors.ink3 }}>min hour day month weekday · same rules as desktop</Text></View> : null}
      <Separator />
      <View style={{ paddingHorizontal: 14 }}><TextButton title={`Time zone · ${value.legacy && value.frequency !== 'once' ? 'Computer local time' : value.timeZone}`} disabled={disabled} onPress={() => setZoneOpen(!zoneOpen)} /></View>
      {zoneOpen ? <View style={{ paddingHorizontal: 14, paddingBottom: 12, gap: 8 }}>
        <TextInput accessibilityLabel="Time zone" value={value.timeZone} onChangeText={timeZone => edit({ timeZone, legacy: false })} editable={!disabled} autoCapitalize="none" autoCorrect={false} style={inputStyle} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{[...new Set([Intl.DateTimeFormat().resolvedOptions().timeZone, 'Asia/Shanghai', 'UTC'])].map(zone => <ScheduleChoice key={zone} label={zone} disabled={disabled} onPress={() => edit({ timeZone: zone, legacy: false })} />)}</View>
      </View> : null}
    </Group>
    <Text accessibilityLiveRegion="polite" style={{ color: colors.ink2, fontSize: 13, lineHeight: 19 }}>{preview ? `${preview} · ${value.legacy && value.frequency !== 'once' ? 'Computer local time' : value.timeZone}` : ''}</Text>
    <InlineError text={invalid} />
  </View>
}
