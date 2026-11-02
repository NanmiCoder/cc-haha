import { Fragment, useState } from 'react'
import { Alert } from 'react-native'
import { modeChange, modeConfirmation } from '../compose/runLogic'
import { Group, InlineError, Separator, Sheet } from '../kit'
import { errorText } from '../theme'
import { modes } from '../modes'
import { ChoiceRow } from '../newtask/ChoiceRow'
import type { PermissionMode } from '../../core/types'

/** 新任务默认权限：点一项立即写到当前电脑，成功后收起，失败留在弹层里显示原因。 */
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
    // 和会话里的运行面板一致：默认权限切到全权限或自动之前先确认，其余直接生效。
    if (modeChange(mode, current || undefined) !== 'confirm') {
      void save(mode)
      return
    }
    const copy = modeConfirmation(mode === 'auto' ? 'auto' : 'bypassPermissions')
    Alert.alert(copy.title, `${copy.message}\n\n之后新任务都会默认使用这一档。`, [
      { text: '取消', style: 'cancel' },
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
      title="新任务默认权限"
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
