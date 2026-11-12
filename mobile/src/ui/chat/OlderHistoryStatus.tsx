import { Pressable } from 'react-native'
import { Text } from '../Text'
import { Spinner, useColors } from '../kit'

/**
 * Paging-back state at the top of the message stream. Normally it auto-loads within a screen and a half of the top, so by scrolling here it is usually already spinning; 
 * tapping is only needed when not connected, loading failed or auto-loading is paused. All states have the same height so content does not jump when switching.
 */
export function OlderHistoryStatus({
  loading,
  failed,
  ready,
  onLoad,
}: {
  loading: boolean
  failed: boolean
  ready: boolean
  onLoad(): void
}) {
  const colors = useColors()
  const label = loading
    ? 'Loading earlier messages'
    : !ready
      ? 'Continues loading after connecting to the computer'
      : failed
        ? 'Failed to load, tap to retry'
        : 'Load earlier messages'
  const disabled = loading || !ready
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: loading }}
      disabled={disabled}
      hitSlop={8}
      onPress={onLoad}
      style={({ pressed }) => ({
        alignSelf: 'center',
        height: 44,
        justifyContent: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        opacity: pressed ? 0.5 : 1,
      })}
    >
      {loading ? <Spinner size={14} /> : null}
      <Text style={{ fontSize: 14, color: disabled ? colors.ink3 : colors.ink2 }}>{label}</Text>
    </Pressable>
  )
}
