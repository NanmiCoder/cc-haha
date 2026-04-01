import React from 'react'

export function SnapshotUpdateDialog(props: {
  agentType: string
  scope: unknown
  snapshotTimestamp: string
  onComplete: (result: 'merge' | 'keep' | 'replace') => void
  onCancel: () => void
}) {
  return React.createElement('div', null, 'SnapshotUpdateDialog stub')
}