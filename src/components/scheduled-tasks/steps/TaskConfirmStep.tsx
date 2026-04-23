import React, { type ReactNode } from 'react'
import { Box, Text } from '../../../ink.js'
import { useKeybinding } from '../../../hooks/useKeybinding.js'
import { cronToHuman } from '../../../utils/cron.js'
import { WizardDialogLayout } from '../../wizard/index.js'
import { useWizard } from '../../wizard/useWizard.js'
import type { ScheduledTaskWizardData } from '../types.js'

export function TaskConfirmStep(): ReactNode {
  const { goNext, goBack, wizardData } =
    useWizard<ScheduledTaskWizardData>()

  useKeybinding('confirm:no', goBack, { context: 'Settings' })

  const schedule = wizardData.cron
    ? cronToHuman(wizardData.cron)
    : wizardData.frequency === 'manual'
      ? 'Manual (on demand)'
      : 'Not set'

  return (
    <WizardDialogLayout subtitle="Review & confirm">
      <Box flexDirection="column" gap={1}>
        <Box>
          <Text bold>Name: </Text>
          <Text>{wizardData.name ?? '—'}</Text>
        </Box>
        <Box>
          <Text bold>Description: </Text>
          <Text>{wizardData.description ?? '—'}</Text>
        </Box>
        <Box>
          <Text bold>Prompt: </Text>
          <Text>
            {wizardData.prompt
              ? wizardData.prompt.length > 60
                ? wizardData.prompt.slice(0, 57) + '...'
                : wizardData.prompt
              : '—'}
          </Text>
        </Box>
        <Box>
          <Text bold>Model: </Text>
          <Text>{wizardData.model ?? 'default'}</Text>
        </Box>
        <Box>
          <Text bold>Permissions: </Text>
          <Text>{wizardData.permissionMode ?? 'ask'}</Text>
        </Box>
        <Box>
          <Text bold>Folder: </Text>
          <Text>{wizardData.folder ?? 'current project'}</Text>
        </Box>
        <Box>
          <Text bold>Worktree: </Text>
          <Text>{wizardData.worktree ? 'yes' : 'no'}</Text>
        </Box>
        <Box>
          <Text bold>Schedule: </Text>
          <Text>{schedule}</Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>Press Enter to confirm, Esc to go back.</Text>
        </Box>
      </Box>
    </WizardDialogLayout>
  )
}
