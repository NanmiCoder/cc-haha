import { View } from 'react-native'
import { Mono } from '../kit'
import { dark } from '../palette'
import { Text } from '../Text'

/**
 * Decorative preview at the top of the lock screen and Dynamic Island settings page: a dark Dynamic Island capsule + a waiting lock screen activity.
 * The lock screen itself does not follow the app light/dark theme, so the dark here is fixed; amber/text colors use dark tokens.
 * Illustration only (hidden from screen readers); content follows the "Show commands on lock screen" toggle, with text matching the real activity.
 */
const SCREEN = '#26251F'
const PANEL = 'rgba(72,70,65,0.72)'
const TEXT = '#F3F1EC'
const ISLAND = '#000000'
const AMBER = dark.attn

export function LockScreenPreview({ showCommand }: { showCommand: boolean }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        borderRadius: 24,
        backgroundColor: SCREEN,
        paddingHorizontal: 12,
        paddingTop: 12,
        paddingBottom: 14,
        alignItems: 'center',
        gap: 12,
      }}
    >
      <View
        style={{
          height: 30,
          minWidth: 150,
          borderRadius: 15,
          backgroundColor: ISLAND,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 12,
          gap: 40,
        }}
      >
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: AMBER }} />
        <Text style={{ fontSize: 12, fontWeight: '600', color: AMBER }}>Waiting</Text>
      </View>
      <View
        style={{
          alignSelf: 'stretch',
          borderRadius: 20,
          backgroundColor: PANEL,
          paddingHorizontal: 14,
          paddingVertical: 12,
          gap: 4,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: AMBER }} />
          <Text style={{ fontSize: 13, fontWeight: '600', color: AMBER }}>Wants to run a command</Text>
        </View>
        <Text numberOfLines={1} style={{ fontSize: 15, lineHeight: 20, fontWeight: '600', color: TEXT }}>
          Fix duplicate messages after WebSocket reconnect
        </Text>
        {showCommand ? (
          <Mono
            numberOfLines={1}
            style={{ fontSize: 12.5, lineHeight: 18, color: 'rgba(243,241,236,0.78)' }}
          >
            $ bun test src/core/sessionTransport.test.ts
          </Mono>
        ) : (
          <Text numberOfLines={1} style={{ fontSize: 12.5, lineHeight: 18, color: 'rgba(243,241,236,0.78)' }}>
            Open the app to view the command
          </Text>
        )}
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
          <View
            style={{
              flex: 1,
              height: 34,
              borderRadius: 17,
              backgroundColor: 'rgba(243,241,236,0.16)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: '600', color: TEXT }}>Deny</Text>
          </View>
          <View
            style={{
              flex: 1,
              height: 34,
              borderRadius: 17,
              backgroundColor: TEXT,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: '600', color: '#1D1C1A' }}>Allow</Text>
          </View>
        </View>
        <Text style={{ fontSize: 12, color: 'rgba(243,241,236,0.6)', marginTop: 4 }}>
          MacBook Pro · 1 more task running
        </Text>
      </View>
    </View>
  )
}
