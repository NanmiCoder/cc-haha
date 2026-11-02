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

/** 回退稿同款的弹层头：20 号标题 + 一行说明。 */
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
      <Button title="取消" variant="secondary" size="lg" onPress={onCancel} disabled={busy} style={{ flex: 1 }} />
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

/** 需要再确认一次的操作（停止、删除）：每次打开都是全新的确认。 */
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
      title="重命名"
      left={<TextButton title="取消" onPress={onClose} disabled={busy} />}
    >
      <Input value={value} onChangeText={onChange} label="会话名称" editable={!busy} autoFocus />
      <InlineError text={error} />
      <Button title="保存" size="lg" busy={busy} disabled={!value.trim()} onPress={onSave} />
    </Sheet>
  )
}

/** 可以选中任意一段的全文。 */
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
      title="选择文字"
      left={<TextButton title="完成" strong onPress={onClose} />}
      right={<TextButton title="复制全部" onPress={onCopy} />}
    >
      <View style={{ backgroundColor: colors.card, borderRadius: 16, padding: 14 }}>
        <Text selectable style={{ fontSize: 16, lineHeight: 25, color: colors.ink }}>
          {text || '这条消息只有附件，没有文字。'}
        </Text>
      </View>
    </Sheet>
  )
}

/** 编辑后重新发送：沿用对话回退，电脑上的文件不动。 */
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
      <SheetHeading title="编辑后重新发送" detail="回退到这条消息，电脑上的文件不动。" />
      <Callout>
        {`会删掉从这条消息开始的 ${removed} 条对话记录，再发出修改后的内容。`}
      </Callout>
      <Input value={value} onChangeText={onChange} label="修改后的消息" multiline editable={!busy} />
      {disabledReason ? <Footnote style={{ paddingTop: 0 }}>{disabledReason}</Footnote> : null}
      <InlineError text={error} />
      <SheetButtons
        confirmLabel="回退并重新发送"
        busy={busy}
        disabled={disabled || !value.trim()}
        onCancel={onClose}
        onConfirm={onConfirm}
      />
    </Sheet>
  )
}
