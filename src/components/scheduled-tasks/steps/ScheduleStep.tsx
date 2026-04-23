import React, { type ReactNode, useState } from 'react'
import { Box, Text } from '../../../ink.js'
import { useKeybinding } from '../../../hooks/useKeybinding.js'
import { Select } from '../../CustomSelect/select.js'
import TextInput from '../../TextInput.js'
import { WizardDialogLayout } from '../../wizard/index.js'
import { useWizard } from '../../wizard/useWizard.js'
import {
  FREQUENCY_OPTIONS,
  frequencyToCron,
  type Frequency,
} from '../../../utils/cronFrequency.js'
import type { ScheduledTaskWizardData } from '../types.js'

export function ScheduleStep(): ReactNode {
  const { goNext, goBack, updateWizardData, wizardData } =
    useWizard<ScheduledTaskWizardData>()

  const [frequency, setFrequency] = useState<Frequency>(
    (wizardData.frequency as Frequency) ?? 'daily',
  )
  const [showTimePicker, setShowTimePicker] = useState(false)
  const [time, setTime] = useState(wizardData.scheduledTime ?? '09:00')

  useKeybinding('confirm:no', goBack, { context: 'Settings' })

  const needsTime = frequency === 'daily' || frequency === 'weekdays' || frequency === 'weekly'

  const handleFrequencySelect = (value: string) => {
    const freq = value as Frequency
    setFrequency(freq)

    if (freq === 'manual' || freq === 'hourly') {
      // No time needed
      const cron = frequencyToCron(freq)
      updateWizardData({
        frequency: freq,
        scheduledTime: undefined,
        cron: cron || undefined,
      })
      goNext()
    } else {
      // Show time picker for daily/weekdays/weekly
      setShowTimePicker(true)
    }
  }

  const handleTimeSubmit = () => {
    // Validate time format HH:MM
    if (!/^\d{1,2}:\d{2}$/.test(time)) return
    const cron = frequencyToCron(frequency, time)
    updateWizardData({
      frequency,
      scheduledTime: time,
      cron: cron || undefined,
    })
    goNext()
  }

  if (showTimePicker && needsTime) {
    return (
      <WizardDialogLayout subtitle="Schedule time">
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text dimColor>
              Enter the time for this task (24-hour format, e.g. 09:00):
            </Text>
          </Box>
          <TextInput
            value={time}
            onChange={setTime}
            onSubmit={handleTimeSubmit}
            placeholder="09:00"
          />
          <Box marginTop={1}>
            <Text dimColor>
              Scheduled tasks use a randomized delay of several minutes for
              server performance.
            </Text>
          </Box>
        </Box>
      </WizardDialogLayout>
    )
  }

  return (
    <WizardDialogLayout subtitle="Frequency">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text dimColor>How often should this task run?</Text>
        </Box>
        <Select
          options={FREQUENCY_OPTIONS}
          defaultValue={frequency}
          onChange={handleFrequencySelect}
          onCancel={goBack}
        />
      </Box>
    </WizardDialogLayout>
  )
}
