import { Fragment, useState } from 'react'
import { Alert } from 'react-native'
import { modeChange, modeConfirmation } from '../compose/runLogic'
import { Group, InlineError, Separator, Sheet } from '../kit'
import { errorText } from '../theme'
import { modes } from '../modes'
import { ChoiceRow } from '../newtask/ChoiceRow'
import type { PermissionMode } from '../../core/types'

/** New task default permission: tapping an item writes it to the current computer immediately, collapsing on success, and staying in the sheet with the reason on failure. */
export function PermissionSheet({
  visible,
  current,
  onClose,
  onSelect,
}: {
  visible: boolean
  current: string
  onClose(): void
  onSelect(mode: PermissionMode): Promise<void>
}) {
  const [saving, setSaving] = useState<PermissionMode | null>(null)
  const [error, setError] = useState('')
  function choose(mode: PermissionMode) {
    if (saving) return
    if (mode === current) {
      onClose()
      return
    }
    // Consistent with the in-session run panel: confirm before switching the default permission to full access or auto; others take effect directly.
    if (modeChange(mode, current || undefined) !== 'confirm') {
      void save(mode)
      return
    }
    const copy = modeConfirmation(mode === 'auto' ? 'auto' : 'bypassPermissions')
    Alert.alert(copy.title, `${copy.message}\n\nNew tasks will use this tier by default from now on.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: copy.confirm,
        style: copy.destructive ? 'destructive' : 'default',
        onPress: () => void save(mode),
      },
    ])
  }
  async function save(mode: PermissionMode) {
    if (saving) return
    setSaving(mode)
    setError('')
    try {
      await onSelect(mode)
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(null)
    }
  }
  return (
    <Sheet
      visible={visible}
      dismissable={!saving}
      onClose={() => {
        setError('')
        onClose()
      }}
      title="New task default permission"
    >
      <InlineError text={error} />
      <Group>
        {modes.map((mode, index) => (
          <Fragment key={mode.id}>
            {index > 0 && <Separator />}
            <ChoiceRow
              title={mode.title}
              detail={mode.description}
              selected={mode.id === current}
              disabled={Boolean(saving)}
              onPress={() => {
                void choose(mode.id)
              }}
            />
          </Fragment>
        ))}
      </Group>
    </Sheet>
  )
}
