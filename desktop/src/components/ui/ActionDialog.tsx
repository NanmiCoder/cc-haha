import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Modal } from './Modal'

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

export type ActionDialogAction = {
  label: string
  onClick: () => void | Promise<void>
  variant?: ButtonVariant
  loading?: boolean
  disabled?: boolean
}

type ActionDialogProps = {
  open: boolean
  onClose: () => void
  title: string
  body: ReactNode
  actions: ActionDialogAction[]
  width?: number
  loading?: boolean
}

export function ActionDialog({
  open,
  onClose,
  title,
  body,
  actions,
  width = 460,
  loading = false,
}: ActionDialogProps) {
  const busy = loading || actions.some((action) => action.loading)

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={title}
      width={width}
      footer={(
        <>
          {actions.map((action) => (
            <Button
              key={action.label}
              type="button"
              variant={action.variant ?? 'secondary'}
              onClick={() => void action.onClick()}
              loading={action.loading}
              disabled={busy || action.disabled}
            >
              {action.label}
            </Button>
          ))}
        </>
      )}
    >
      {typeof body === 'string' ? (
        <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
          {body}
        </p>
      ) : body}
    </Modal>
  )
}
