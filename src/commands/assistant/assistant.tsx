import React from 'react'

export function NewInstallWizard(props: {
  defaultDir: string
  onInstalled: (dir: string) => void
  onCancel: () => void
  onError: (message: string) => void
}) {
  return React.createElement('div', null, 'NewInstallWizard stub')
}

export async function computeDefaultInstallDir(): Promise<string> {
  return ''
}