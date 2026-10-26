import { useState } from 'react'
import { View } from 'react-native'
import {
  Footnote,
  Group,
  Icon,
  InlineError,
  ListRow,
  Separator,
  Sheet,
  Spinner,
  useColors,
} from '../kit'
import { errorText } from '../theme'
import {
  autoAnswerLabel,
  autoAnswerMinutes,
  selectedMinutes,
  type AutoQuestion,
} from './settingsModel'

/** AI 代答等待时间：点一档立即写到当前电脑，成功后收起。 */
export function AutoAnswerSheet({
  visible,
  hostName,
  current,
  onClose,
  onSelect,
}: {
  visible: boolean
  hostName: string
  current: AutoQuestion
  onClose(): void
  onSelect(minutes: number): Promise<void>
}) {
  const colors = useColors()
  const [saving, setSaving] = useState<number | null>(null)
  const [error, setError] = useState('')
  const selected = selectedMinutes(current)
  async function choose(minutes: number) {
    if (saving !== null) return
    if (minutes === selected) {
      onClose()
      return
    }
    setSaving(minutes)
    setError('')
    try {
      await onSelect(minutes)
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(null)
    }
  }
  return (
    <Sheet visible={visible} onClose={onClose} dismissable={saving === null} title="AI 代答">
      <Group style={{ marginTop: 4 }}>
        {autoAnswerMinutes.map((minutes, index) => (
          <View key={minutes}>
            {index > 0 && <Separator />}
            <ListRow
              title={autoAnswerLabel(minutes)}
              accessibilityLabel={minutes ? `等 ${minutes} 分钟后代答` : '不代答'}
              disabled={saving !== null && saving !== minutes}
              onPress={() => void choose(minutes)}
              trailing={
                saving === minutes ? (
                  <Spinner size={16} />
                ) : minutes === selected ? (
                  <Icon name="check" size={18} color={colors.run} strokeWidth={2.4} />
                ) : null
              }
            />
          </View>
        ))}
      </Group>
      {error ? (
        <InlineError text={error} />
      ) : (
        <Footnote style={{ paddingTop: 0 }}>
          {`提问超过这段时间没人回，AI 按推荐选项作答；工具审批永远不代答。只对 ${hostName} 生效，保存在这台电脑上。`}
        </Footnote>
      )}
    </Sheet>
  )
}
