import React, { type ReactNode } from 'react'
import { Box, Text } from '../../../ink.js'
import { Select } from '../../CustomSelect/select.js'
import { WizardDialogLayout } from '../../wizard/index.js'
import { useWizard } from '../../wizard/useWizard.js'
import type { ScheduledTaskWizardData } from '../types.js'

const PERMISSION_OPTIONS = [
  {
    label: 'Ask permissions',
    value: 'ask',
    description: 'Always ask before making changes',
  },
  {
    label: 'Auto accept edits',
    value: 'auto-accept',
    description: 'Automatically accept all file edits',
  },
  {
    label: 'Plan mode',
    value: 'plan',
    description: 'Create a plan before making changes',
  },
  {
    label: 'Bypass permissions',
    value: 'bypass',
    description: 'Accepts all permissions',
  },
]

export function PermissionStep(): ReactNode {
  const { goNext, goBack, updateWizardData, wizardData } =
    useWizard<ScheduledTaskWizardData>()

  return (
    <WizardDialogLayout subtitle="Permission mode">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text dimColor>
            Choose the permission mode for this scheduled task.
          </Text>
        </Box>
        <Select
          options={PERMISSION_OPTIONS}
          defaultValue={wizardData.permissionMode ?? 'ask'}
          onChange={(value) => {
            updateWizardData({ permissionMode: value })
            goNext()
          }}
          onCancel={goBack}
        />
      </Box>
    </WizardDialogLayout>
  )
}
