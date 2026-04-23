import React, { type ReactNode } from 'react'
import { WizardDialogLayout } from '../../wizard/index.js'
import { useWizard } from '../../wizard/useWizard.js'
import { ModelSelector } from '../../agents/ModelSelector.js'
import type { ScheduledTaskWizardData } from '../types.js'

export function TaskModelStep(): ReactNode {
  const { goNext, goBack, updateWizardData, wizardData } =
    useWizard<ScheduledTaskWizardData>()

  return (
    <WizardDialogLayout subtitle="Model">
      <ModelSelector
        initialModel={wizardData.model}
        onComplete={(model) => {
          updateWizardData({ model })
          goNext()
        }}
        onCancel={goBack}
      />
    </WizardDialogLayout>
  )
}
