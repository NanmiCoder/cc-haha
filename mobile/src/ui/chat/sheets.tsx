import type { ReactNode } from 'react'
import { TextInput, View } from 'react-native'
import { Text } from '../Text'
import {
  Button,
  Callout,
  Footnote,
  InlineError,
  Sheet,
  TextButton,
  type,
  useColors,
} from '../kit'

/** Sheet header in the same style as the rewind design: 20pt title + one line of description. */
function SheetHeading({ title, detail }: { title: string; detail?: string }) {
  const colors = useColors()
  return (
    <View style={{ gap: 4, paddingHorizontal: 4, paddingTop: 4 }}>
      <Text accessibilityRole="header" style={[type.title, { color: colors.ink }]}>
        {title}
      </Text>
      {detail ? (
        <Text style={{ fontSize: 14, lineHeight: 20, color: colors.ink2 }}>{detail}</Text>
      ) : null}
    </View>
  )
}

function SheetButtons({
  confirmLabel,
  onCancel,
  onConfirm,
  destructive,
  busy,
  disabled,
}: {
  confirmLabel: string
  onCancel(): void
  onConfirm(): void
  destructive?: boolean
  busy?: boolean
  disabled?: boolean
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 8, paddingTop: 4 }}>
      <Button title="Cancel" variant="secondary" size="lg" onPress={onCancel} disabled={busy} style={{ flex: 1 }} />
      <Button
        title={confirmLabel}
        variant={destructive ? 'destructive' : 'primary'}
        size="lg"
        busy={busy}
        disabled={disabled}
        onPress={onConfirm}
        style={{ flex: 1 }}
      />
    </View>
  )
}

/** Actions needing one more confirmation (stop, delete): each open is a fresh confirmation. */
export function ConfirmSheet({
  visible,
  onClose,
  title,
  message,
  confirmLabel,
  destructive,
  busy,
  disabled,
  error,
  onConfirm,
  children,
}: {
  visible: boolean
  onClose(): void
  title: string
  message: string
  confirmLabel: string
  destructive?: boolean
  busy?: boolean
  disabled?: boolean
  error?: string
  onConfirm(): void
  children?: ReactNode
}) {
  return (
    <Sheet visible={visible} onClose={onClose} dismissable={!busy}>
      <SheetHeading title={title} detail={message} />
      {children}
      <InlineError text={error} />
      <SheetButtons
        confirmLabel={confirmLabel}
        destructive={destructive}
        busy={busy}
        disabled={disabled}
        onCancel={onClose}
        onConfirm={onConfirm}
      />
    </Sheet>
  )
}

function Input({
  value,
  onChangeText,
  label,
  multiline,
  editable,
  autoFocus,
}: {
  value: string
  onChangeText(value: string): void
  label: string
  multiline?: boolean
  editable?: boolean
  autoFocus?: boolean
}) {
  const colors = useColors()
  return (
    <TextInput
      accessibilityLabel={label}
      value={value}
      onChangeText={onChangeText}
      editable={editable}
      autoFocus={autoFocus}
      multiline={multiline}
      selectTextOnFocus={!multiline}
      placeholder={label}
      placeholderTextColor={colors.ink3}
      style={{
        minHeight: multiline ? 132 : 50,
        maxHeight: multiline ? 260 : undefined,
        borderRadius: 14,
        backgroundColor: colors.card,
        paddingHorizontal: 14,
        paddingTop: multiline ? 12 : 0,
        paddingBottom: multiline ? 12 : 0,
        fontSize: 16,
        lineHeight: multiline ? 23 : undefined,
        color: colors.ink,
        textAlignVertical: multiline ? 'top' : 'center',
      }}
    />
  )
}

export function RenameSheet({
  visible,
  onClose,
  value,
  onChange,
  busy,
  error,
  onSave,
}: {
  visible: boolean
  onClose(): void
  value: string
  onChange(value: string): void
  busy: boolean
  error?: string
  onSave(): void
}) {
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      dismissable={!busy}
      title="Rename"
      left={<TextButton title="Cancel" onPress={onClose} disabled={busy} />}
    >
      <Input value={value} onChangeText={onChange} label="Session name" editable={!busy} autoFocus />
      <InlineError text={error} />
      <Button title="Save" size="lg" busy={busy} disabled={!value.trim()} onPress={onSave} />
    </Sheet>
  )
}

/** Full text of any segment can be selected. */
export function SelectTextSheet({
  visible,
  onClose,
  text,
  onCopy,
}: {
  visible: boolean
  onClose(): void
  text: string
  onCopy(): void
}) {
  const colors = useColors()
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Select text"
      left={<TextButton title="Done" strong onPress={onClose} />}
      right={<TextButton title="Copy all" onPress={onCopy} />}
    >
      <View style={{ backgroundColor: colors.card, borderRadius: 16, padding: 14 }}>
        <Text selectable style={{ fontSize: 16, lineHeight: 25, color: colors.ink }}>
          {text || 'This message only has attachments, no text.'}
        </Text>
      </View>
    </Sheet>
  )
}

/** Edit and resend: reuses conversation rewind; files on the computer are untouched. */
export function EditResendSheet({
  visible,
  onClose,
  value,
  onChange,
  removed,
  busy,
  disabled,
  disabledReason,
  error,
  onConfirm,
}: {
  visible: boolean
  onClose(): void
  value: string
  onChange(value: string): void
  removed: number
  busy: boolean
  disabled: boolean
  disabledReason?: string
  error?: string
  onConfirm(): void
}) {
  return (
    <Sheet visible={visible} onClose={onClose} dismissable={!busy}>
      <SheetHeading title="Edit and resend" detail="Rewind to this message; files on the computer are untouched." />
      <Callout>
        {`This deletes ${removed} conversation records starting from this message, then sends the edited content.`}
      </Callout>
      <Input value={value} onChangeText={onChange} label="Edited message" multiline editable={!busy} />
      {disabledReason ? <Footnote style={{ paddingTop: 0 }}>{disabledReason}</Footnote> : null}
      <InlineError text={error} />
      <SheetButtons
        confirmLabel="Rewind and resend"
        busy={busy}
        disabled={disabled || !value.trim()}
        onCancel={onClose}
        onConfirm={onConfirm}
      />
    </Sheet>
  )
}
