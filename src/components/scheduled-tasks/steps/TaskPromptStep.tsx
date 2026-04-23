import React, { type ReactNode, useState } from 'react'
import { Box, Text } from '../../../ink.js'
import { useKeybinding } from '../../../hooks/useKeybinding.js'
import TextInput from '../../TextInput.js'
import { WizardDialogLayout } from '../../wizard/index.js'
import { useWizard } from '../../wizard/useWizard.js'
import type { ScheduledTaskWizardData } from '../types.js'

export function TaskPromptStep(): ReactNode {
  const { goNext, goBack, updateWizardData, wizardData } =
    useWizard<ScheduledTaskWizardData>()
  const [value, setValue] = useState(wizardData.prompt ?? '')
  const [error, setError] = useState<string | null>(null)

  useKeybinding('confirm:no', goBack, { context: 'Settings' })

  const handleSubmit = () => {
    const trimmed = value.trim()
    if (!trimmed) {
      setError('Prompt is required')
      return
    }
    setError(null)
    updateWizardData({ prompt: trimmed })
    goNext()
  }

  return (
    <WizardDialogLayout subtitle="Prompt">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text dimColor>
            Enter the prompt that will be sent to Claude when this task runs.
          </Text>
        </Box>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder="e.g. Look at the commits from the last 24 hours..."
        />
        {error && (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}
      </Box>
    </WizardDialogLayout>
  )
}
