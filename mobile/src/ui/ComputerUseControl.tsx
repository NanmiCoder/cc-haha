import { View } from 'react-native'
import type { ComputerUse } from '../core/useComputerUse'
import { Button, InlineError, Sheet, Switch, useColors } from './kit'
import { Text } from './Text'
import { computerNote } from './compose/runLogic'

/** Confirmation sheet before turning on "Computer use": the authorization covers all apps on this computer. */
export function ComputerUseConsent({ computer }: { computer: ComputerUse }) {
  const colors = useColors()
  return (
    <Sheet visible={computer.consentOpen} onClose={computer.cancelConsent} title="Turn on computer use">
      <Text style={{ fontSize: 15, lineHeight: 23, color: colors.ink }}>
        Agent will be able to view this computer’s screen, click, type, and use the clipboard and system shortcuts. The authorization covers all apps and may touch sensitive content or perform irreversible actions.
      </Text>
      <Text style={{ fontSize: 14, lineHeight: 21, color: colors.ink2 }}>
        Keep an eye on execution; you can stop the task or turn off computer use anytime. macOS also requires system permission grants on the computer.
      </Text>
      <InlineError text={computer.error} />
      <Button
        title={computer.busy ? 'Turning on…' : 'I understand, turn on'}
        disabled={computer.busy}
        onPress={computer.confirmConsent}
      />
      <Button title="Cancel" variant="secondary" disabled={computer.busy} onPress={computer.cancelConsent} />
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
          <Text style={{ fontSize: 16, color: colors.ink }}>Computer use</Text>
          <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
            {computer.enabled && !reason ? 'Applies only to this message and closes after sending; computer use authorization stays valid.' : computerNote({ supported: computer.supported, reason })}
          </Text>
        </View>
        <Switch
          label="Computer use"
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
          <Text style={{ fontSize: 13, color: colors.ink2 }}>Enabled; please finish Screen Recording and Accessibility authorization on the computer.</Text>
          <Button
            title={computer.busy ? 'Please finish authorization on the computer…' : 'Open permission settings on the computer'}
            disabled={computer.busy}
            onPress={computer.openPermissionCard}
          />
        </View>
      ) : null}
    </View>
  )
}
