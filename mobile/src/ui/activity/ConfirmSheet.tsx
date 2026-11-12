import { View } from 'react-native'
import { Button, InlineError, Sheet, useColors } from '../kit'
import { Text } from '../Text'

/** Second confirmation sheet: title · target · description · primary action · cancel. Cannot tap backdrop to close while busy. */
export function ConfirmSheet({
  visible,
  title,
  subject,
  detail,
  confirmTitle,
  destructive,
  busy,
  disabled,
  error,
  onConfirm,
  onClose,
}: {
  visible: boolean
  title: string
  subject?: string
  detail: string
  confirmTitle: string
  destructive?: boolean
  busy?: boolean
  disabled?: boolean
  error?: string
  onConfirm(): void
  onClose(): void
}) {
  const colors = useColors()
  return (
    <Sheet visible={visible} onClose={onClose} title={title} dismissable={!busy}>
      <View style={{ gap: 6, paddingHorizontal: 4 }}>
        {subject ? (
          <Text style={{ fontSize: 16, lineHeight: 23, fontWeight: '500', color: colors.ink }}>
            {subject}
          </Text>
        ) : null}
        <Text style={{ fontSize: 14, lineHeight: 21, color: colors.ink2 }}>{detail}</Text>
      </View>
      <InlineError text={error} />
      <View style={{ gap: 8, paddingTop: 4 }}>
        <Button
          title={confirmTitle}
          size="lg"
          variant={destructive ? 'destructive' : 'primary'}
          busy={busy}
          disabled={disabled}
          onPress={onConfirm}
        />
        <Button title="Cancel" size="lg" variant="secondary" disabled={busy} onPress={onClose} />
      </View>
    </Sheet>
  )
}
