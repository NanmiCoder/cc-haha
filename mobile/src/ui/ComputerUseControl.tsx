import { View } from 'react-native'
import type { ComputerUse } from '../core/useComputerUse'
import { Button, InlineError, Sheet, Switch, useColors } from './kit'
import { Text } from './Text'
import { computerNote } from './compose/runLogic'

/** 开启「操作电脑」前的确认单：授权覆盖这台电脑上的所有应用。 */
export function ComputerUseConsent({ computer }: { computer: ComputerUse }) {
  const colors = useColors()
  return (
    <Sheet visible={computer.consentOpen} onClose={computer.cancelConsent} title="开启操作电脑">
      <Text style={{ fontSize: 15, lineHeight: 23, color: colors.ink }}>
        Agent 将能够查看这台电脑的屏幕内容，点击、输入、使用剪贴板和系统快捷键。授权覆盖所有应用，可能操作敏感内容或执行不可撤销的动作。
      </Text>
      <Text style={{ fontSize: 14, lineHeight: 21, color: colors.ink2 }}>
        请留意执行过程；你可以停止任务，或随时关闭操作电脑。macOS 还需要在电脑完成系统权限授权。
      </Text>
      <InlineError text={computer.error} />
      <Button
        title={computer.busy ? '正在开启…' : '我了解并开启'}
        disabled={computer.busy}
        onPress={computer.confirmConsent}
      />
      <Button title="取消" variant="secondary" disabled={computer.busy} onPress={computer.cancelConsent} />
    </Sheet>
  )
}

/** The row selects a skill for this message; the consent below remains global. */
export function ComputerUseRow({ computer, selected, onSelected, reason }: {
  computer: ComputerUse
  selected: boolean
  onSelected(value: boolean): void
  reason?: string
}) {
  const colors = useColors()
  return (
    <View>
      <View style={{ minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14 }}>
        <View style={{ flex: 1, gap: 2, paddingVertical: 8 }}>
          <Text style={{ fontSize: 16, color: colors.ink }}>操作电脑</Text>
          <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
            {computer.enabled && !reason ? '只对这条消息生效，发送后收起；电脑操作授权仍有效。' : computerNote({ supported: computer.supported, reason })}
          </Text>
        </View>
        <Switch
          label="操作电脑"
          value={selected}
          disabled={computer.supported !== true || computer.busy || !!reason}
          onValueChange={(value) => {
            if (value) computer.selectForMessage(() => onSelected(true))
            else onSelected(false)
          }}
        />
      </View>
      {computer.error && !computer.consentOpen ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
          <InlineError text={computer.error} />
        </View>
      ) : null}
      {computer.needsPermission ? (
        <View style={{ gap: 8, paddingHorizontal: 14, paddingBottom: 12 }}>
          <Text style={{ fontSize: 13, color: colors.ink2 }}>已开启，请在电脑完成屏幕录制和辅助功能授权。</Text>
          <Button
            title={computer.busy ? '请在电脑完成授权…' : '在电脑上打开权限设置'}
            disabled={computer.busy}
            onPress={computer.openPermissionCard}
          />
        </View>
      ) : null}
    </View>
  )
}
