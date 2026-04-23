import React, { type ReactNode } from 'react'
import { WizardProvider } from '../wizard/index.js'
import type { ScheduledTaskWizardData } from './types.js'
import { NameStep } from './steps/NameStep.js'
import { TaskDescriptionStep } from './steps/TaskDescriptionStep.js'
import { TaskPromptStep } from './steps/TaskPromptStep.js'
import { TaskModelStep } from './steps/TaskModelStep.js'
import { PermissionStep } from './steps/PermissionStep.js'
import { FolderStep } from './steps/FolderStep.js'
import { ScheduleStep } from './steps/ScheduleStep.js'
import { TaskConfirmStep } from './steps/TaskConfirmStep.js'

type Props = {
  mode: 'create' | 'edit'
  initialData?: Partial<ScheduledTaskWizardData>
  onComplete: (data: ScheduledTaskWizardData) => void
  onCancel: () => void
}

export function ScheduledTaskWizard({
  mode,
  initialData = {},
  onComplete,
  onCancel,
}: Props): ReactNode {
  const steps = [
    NameStep,
    TaskDescriptionStep,
    TaskPromptStep,
    TaskModelStep,
    PermissionStep,
    FolderStep,
    ScheduleStep,
    TaskConfirmStep,
  ]

  const title = mode === 'create' ? 'New scheduled task' : 'Edit scheduled task'

  return (
    <WizardProvider
      steps={steps}
      initialData={initialData as ScheduledTaskWizardData}
      onComplete={onComplete}
      onCancel={onCancel}
      title={title}
      showStepCounter={true}
    />
  )
}
