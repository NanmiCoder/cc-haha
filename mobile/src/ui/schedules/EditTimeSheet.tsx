import { useState } from 'react'
import { View } from 'react-native'
import { dailyCron } from '../../core/operations'
import { editableSchedule } from '../../core/schedulesView'
import { Button, Callout, Group, InlineError, Mono, Segmented, Separator, Sheet, useColors } from '../kit'
import { Text } from '../Text'
import { FormRow, TimeField } from './parts'

type Frequency = 'daily' | 'weekdays'

/** 改执行时间：每天 / 工作日 + 电脑本地时间，保存为新的 cron。 */
export function EditTimeSheet({
  visible,
  cron,
  busy,
  error,
  onSave,
  onClose,
}: {
  visible: boolean
  cron: string
  busy: boolean
  error: string
  onSave(cron: string): void
  onClose(): void
}) {
  const colors = useColors()
  const initial = editableSchedule(cron)
  const [frequency, setFrequency] = useState<Frequency>(initial.weekdays ? 'weekdays' : 'daily')
  const [time, setTime] = useState(initial.time)
  const [invalid, setInvalid] = useState('')
  const save = () => {
    try {
      const next = dailyCron(time, frequency === 'weekdays')
      setInvalid('')
      onSave(next)
    } catch (e) {
      setInvalid((e as Error).message)
    }
  }
  return (
    <Sheet visible={visible} onClose={onClose} title="改执行时间" dismissable={!busy}>
      {initial.custom ? (
        <Callout tone="info">
          <Text style={{ fontSize: 13, lineHeight: 19, color: colors.ink2 }}>
            现在按 <Mono style={{ fontSize: 13 }}>{cron}</Mono> 执行，保存后改成每天或工作日的固定时间。
          </Text>
        </Callout>
      ) : null}
      <Group>
        <FormRow label="重复" labelFlex minHeight={52}>
          <Segmented<Frequency>
            label="重复"
            value={frequency}
            onChange={setFrequency}
            disabled={busy}
            height={34}
            style={{ width: 150, borderRadius: 9 }}
            options={[
              { label: '每天', value: 'daily' },
              { label: '工作日', value: 'weekdays' },
            ]}
          />
        </FormRow>
        <Separator />
        <FormRow label="电脑本地时间" labelFlex minHeight={52}>
          <TimeField
            value={time}
            onChangeText={(value) => {
              setTime(value)
              setInvalid('')
            }}
            editable={!busy}
            onSubmitEditing={save}
          />
        </FormRow>
      </Group>
      <InlineError text={invalid || error} />
      <View style={{ paddingTop: 4 }}>
        <Button title="保存" size="lg" busy={busy} onPress={save} />
      </View>
    </Sheet>
  )
}
