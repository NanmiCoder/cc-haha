import { Pressable, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  Button,
  FieldRow,
  Footnote,
  Group,
  Icon,
  InlineError,
  Segmented,
  Separator,
  Sheet,
  Spinner,
  useColors,
} from '../kit'
import { Text } from '../Text'
import {
  addressPlaceholder,
  formFootnote,
  needsToken,
  primaryTitle,
  shouldMaskAddress,
  type ConnectMode,
} from './connectForm'
import { useKeyboardShown } from './motion'

/** In the design the panel top edge is at 214pt on an 844-high screen; other screens scale proportionally. */
const sheetRatio = 630 / 844
/** Grabber 15 + header 48 + scroll area bottom padding 8 + button area top margin 12 + button 50. */
const sheetChrome = 15 + 48 + 8 + 12 + 50

/** "Manual connect": LAN / public methods, with progress and errors inline in the panel. */
export function ManualSheet({
  visible,
  onClose,
  mode,
  onModeChange,
  name,
  onNameChange,
  address,
  onAddressChange,
  token,
  onTokenChange,
  onPasteToken,
  busy,
  status,
  error,
  onConnect,
  onCancel,
  onRescan,
}: {
  visible: boolean
  onClose(): void
  mode: ConnectMode
  onModeChange(mode: ConnectMode): void
  name: string
  onNameChange(value: string): void
  address: string
  onAddressChange(value: string): void
  token: string
  onTokenChange(value: string): void
  onPasteToken(): void
  busy: boolean
  status: string
  error: string
  onConnect(): void
  onCancel(): void
  /** When public pairing fails (most likely an expired link) offer a way back to scanning. */
  onRescan(): void
}) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  const keyboard = useKeyboardShown()
  const rescan = mode === 'remote' && Boolean(error) && !busy
  const footerBottom = Math.max(insets.bottom, 16)
  // Keyboard open: drop the fixed height so the focused field stays visible.
  const minHeight = keyboard
    ? 0
    : Math.max(0, Math.round(height * sheetRatio) - sheetChrome - footerBottom - (rescan ? 52 : 0))
  const showToken = needsToken(mode, address)

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      dismissable={!busy}
      left={
        <Text
          accessibilityRole="header"
          style={{ fontSize: 20, lineHeight: 26, fontWeight: '600', color: colors.ink, paddingLeft: 4 }}
        >
          Manual connect
        </Text>
      }
      right={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={8}
          onPress={onClose}
          style={({ pressed }) => ({
            width: 32,
            height: 32,
            borderRadius: 16,
            backgroundColor: colors.fill,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Icon name="x" size={14} color={colors.ink2} strokeWidth={3} />
        </Pressable>
      }
      footer={
        <View style={{ gap: 8 }}>
          {busy ? (
            <Button title="Cancel connection" variant="secondary" size="lg" onPress={onCancel} />
          ) : (
            <Button
              title={primaryTitle(mode)}
              size="lg"
              disabled={!address.trim()}
              onPress={onConnect}
            />
          )}
          {rescan && <Button title="Scan again" variant="plain" onPress={onRescan} />}
        </View>
      }
    >
      <View
        // Android Fabric must not reparent the segmented controls or fields while
        // the native sheet/screen retains its outgoing views for a transition.
        collapsable={false}
        collapsableChildren={false}
        style={{ minHeight }}
      >
        <Segmented
          label="Connection method"
          value={mode}
          disabled={busy}
          style={{ marginTop: 8 }}
          options={[
            { label: 'Same LAN', value: 'lan' },
            { label: 'Remote connection', value: 'remote' },
          ]}
          onChange={onModeChange}
        />
        <Group style={{ marginTop: 16 }}>
          <FieldRow
            label="Name"
            value={name}
            onChangeText={onNameChange}
            placeholder="My computer"
            editable={!busy}
            returnKeyType="next"
          />
          <Separator />
          <FieldRow
            label="Address"
            mono
            value={address}
            onChangeText={onAddressChange}
            placeholder={addressPlaceholder(mode)}
            editable={!busy}
            keyboardType="url"
            autoComplete="off"
            textContentType="none"
            secureTextEntry={shouldMaskAddress(address)}
            returnKeyType={showToken ? 'next' : 'go'}
            onSubmitEditing={showToken ? undefined : onConnect}
          />
          {showToken && (
            <>
              <Separator />
              <FieldRow
                label="Access token"
                value={token}
                onChangeText={onTokenChange}
                placeholder="Required"
                editable={!busy}
                autoComplete="off"
                textContentType="none"
                secureTextEntry
                returnKeyType="go"
                onSubmitEditing={onConnect}
                trailing={
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Paste access token"
                    disabled={busy}
                    onPress={onPasteToken}
                    style={({ pressed }) => ({
                      height: 32,
                      paddingHorizontal: 10,
                      borderRadius: 8,
                      backgroundColor: colors.fill,
                      justifyContent: 'center',
                      opacity: busy ? 0.45 : pressed ? 0.6 : 1,
                    })}
                  >
                    <Text style={{ fontSize: 13, color: colors.ink }}>Paste</Text>
                  </Pressable>
                }
              />
            </>
          )}
        </Group>
        <Footnote style={{ paddingTop: 10 }}>{formFootnote(mode, address)}</Footnote>
        {status ? (
          <View
            style={{ marginTop: 16, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}
          >
            <Spinner size={15} />
            <Text
              accessibilityLiveRegion="polite"
              style={{ flex: 1, fontSize: 14, lineHeight: 20, color: colors.ink2 }}
            >
              {status}
            </Text>
          </View>
        ) : null}
        <InlineError text={error} style={{ marginTop: 16 }} />
      </View>
    </Sheet>
  )
}
