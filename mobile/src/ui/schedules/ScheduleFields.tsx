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
  { value: 'once', label: '仅一次' }, { value: 'daily', label: '每天' },
  { value: 'weekdays', label: '工作日' }, { value: 'specificDays', label: '每周' },
  { value: 'monthly', label: '每月' }, { value: 'everyNMinutes', label: '每隔几分钟' },
  { value: 'everyNHours', label: '每隔几小时' }, { value: 'customCron', label: '自定义 Cron' },
]
const presets: { value: SchedulePreset; label: string }[] = [
  { value: 'halfHour', label: '30 分钟后' }, { value: 'tomorrow', label: '明早 9 点' }, { value: 'workdays', label: '工作日 9 点' },
]
const days = [1, 2, 3, 4, 5, 6, 0]
const dayNames = ['日', '一', '二', '三', '四', '五', '六']

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
    if (schedule.kind === 'once') preview = `仅一次 · ${value.runAt.replace('T', ' ')}`
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
        <Text style={{ fontSize: 15, color: colors.ink2 }}>执行计划</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {(more || advanced ? frequencies : frequencies.slice(0, 4)).map(item => <ScheduleChoice key={item.value} label={item.label} selected={value.frequency === item.value} disabled={disabled} onPress={() => edit({ frequency: item.value })} />)}
          {!more && !advanced ? <TextButton title="更多" disabled={disabled} onPress={() => setMore(true)} /> : null}
        </View>
      </View>
      {showTime ? <><Separator /><FormRow label="执行时间" labelFlex><TimeField value={value.time} onChangeText={time => edit({ time })} editable={!disabled} /></FormRow>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 14, paddingBottom: 12 }}>{['09:00', '12:00', '18:00', '21:00'].map(time => <ScheduleChoice key={time} label={time} selected={value.time === time} disabled={disabled} onPress={() => edit({ time })} />)}</View>
      </> : null}
      {value.frequency === 'once' ? <View style={{ paddingHorizontal: 14, paddingBottom: 12, gap: 8 }}>
        <Text style={{ color: colors.ink2 }}>执行日期和时间</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <ScheduleChoice label={selectedDate} disabled={disabled} onPress={() => { setCalendar(!calendar); setMonth('') }} />
          <TimeField value={value.runAt.slice(11)} onChangeText={time => edit({ runAt: `${selectedDate}T${time}` })} editable={!disabled} />
        </View>
        {calendar ? <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><TextButton title="上个月" disabled={disabled} onPress={() => moveMonth(-1)} /><Text style={{ color: colors.ink }}>{shownMonth}</Text><TextButton title="下个月" disabled={disabled} onPress={() => moveMonth(1)} /></View>
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
        return <ScheduleChoice key={day} label={`周${dayNames[day]}`} selected={selected} disabled={disabled} onPress={() => edit({ selectedDays: selected ? value.selectedDays.filter(item => item % 7 !== day) : [...value.selectedDays, day] })} />
      })}</View> : null}
      {value.frequency === 'monthly' ? <View style={{ padding: 14, gap: 8 }}>
        <FormRow label="每月几号" labelFlex><TextInput accessibilityLabel="每月几号" value={String(value.monthDay)} onChangeText={text => edit({ monthDay: Number(text) })} keyboardType="number-pad" editable={!disabled} style={[inputStyle, { flex: 0, width: 72 }]} /></FormRow>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{[1, 5, 10, 15, 20, 25, 28].map(day => <ScheduleChoice key={day} label={`${day} 号`} selected={day === value.monthDay} disabled={disabled} onPress={() => edit({ monthDay: day })} />)}</View>
        {value.monthDay > 28 ? <Text style={{ fontSize: 13, color: colors.ink3 }}>没有 {value.monthDay} 号的月份会跳过。</Text> : null}
      </View> : null}
      {value.frequency === 'everyNMinutes' || value.frequency === 'everyNHours' ? <View style={{ padding: 14, gap: 10 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{(value.frequency === 'everyNMinutes' ? [5, 10, 15, 20, 30] : [1, 2, 3, 4, 6, 8, 12]).map(n => <ScheduleChoice key={n} label={`${n} ${value.frequency === 'everyNMinutes' ? '分钟' : '小时'}`} selected={n === (value.frequency === 'everyNMinutes' ? value.minuteInterval : value.hourInterval)} disabled={disabled} onPress={() => edit(value.frequency === 'everyNMinutes' ? { minuteInterval: n } : { hourInterval: n })} />)}</View>
        {value.frequency === 'everyNHours' ? <FormRow label="第几分钟" labelFlex><TextInput accessibilityLabel="每小时的第几分钟" value={String(value.minuteOffset)} onChangeText={text => edit({ minuteOffset: Number(text) })} keyboardType="number-pad" editable={!disabled} style={[inputStyle, { flex: 0, width: 72 }]} /></FormRow> : null}
        <Text style={{ fontSize: 13, color: colors.ink3 }}>按时钟刻度触发，和桌面端一致。</Text>
      </View> : null}
      {value.frequency === 'customCron' ? <View style={{ padding: 14, gap: 6 }}><TextInput accessibilityLabel="自定义 Cron" value={value.customCron} onChangeText={customCron => edit({ customCron })} editable={!disabled} autoCapitalize="none" autoCorrect={false} placeholder="0 9 * * 1-5" placeholderTextColor={colors.ink3} style={inputStyle} /><Text style={{ fontSize: 12, color: colors.ink3 }}>分 时 日 月 星期 · 与桌面端使用相同规则</Text></View> : null}
      <Separator />
      <View style={{ paddingHorizontal: 14 }}><TextButton title={`时区 · ${value.legacy && value.frequency !== 'once' ? '电脑本地时间' : value.timeZone}`} disabled={disabled} onPress={() => setZoneOpen(!zoneOpen)} /></View>
      {zoneOpen ? <View style={{ paddingHorizontal: 14, paddingBottom: 12, gap: 8 }}>
        <TextInput accessibilityLabel="时区" value={value.timeZone} onChangeText={timeZone => edit({ timeZone, legacy: false })} editable={!disabled} autoCapitalize="none" autoCorrect={false} style={inputStyle} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{[...new Set([Intl.DateTimeFormat().resolvedOptions().timeZone, 'Asia/Shanghai', 'UTC'])].map(zone => <ScheduleChoice key={zone} label={zone} disabled={disabled} onPress={() => edit({ timeZone: zone, legacy: false })} />)}</View>
      </View> : null}
    </Group>
    <Text accessibilityLiveRegion="polite" style={{ color: colors.ink2, fontSize: 13, lineHeight: 19 }}>{preview ? `${preview} · ${value.legacy && value.frequency !== 'once' ? '电脑本地时间' : value.timeZone}` : ''}</Text>
    <InlineError text={invalid} />
  </View>
}
