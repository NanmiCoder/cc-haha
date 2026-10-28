import { View } from 'react-native'
import { Mono } from '../kit'
import { dark } from '../palette'
import { Text } from '../Text'

/**
 * 锁屏与灵动岛设置页顶部的装饰预览：深色的灵动岛胶囊 + 等待态的锁屏活动。
 * 锁屏本身不跟随 App 的明暗主题，所以这里的深色是固定的；琥珀/文字色取深色 token。
 * 只是示意（对读屏隐藏），内容随「锁屏上显示命令」开关变化，文案与真实活动一致。
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
        <Text style={{ fontSize: 12, fontWeight: '600', color: AMBER }}>等你</Text>
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
          <Text style={{ fontSize: 13, fontWeight: '600', color: AMBER }}>想运行命令</Text>
        </View>
        <Text numberOfLines={1} style={{ fontSize: 15, lineHeight: 20, fontWeight: '600', color: TEXT }}>
          修复 WebSocket 重连后消息重复
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
            打开 App 查看命令
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
            <Text style={{ fontSize: 14, fontWeight: '600', color: TEXT }}>拒绝</Text>
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
            <Text style={{ fontSize: 14, fontWeight: '600', color: '#1D1C1A' }}>允许</Text>
          </View>
        </View>
        <Text style={{ fontSize: 12, color: 'rgba(243,241,236,0.6)', marginTop: 4 }}>
          MacBook Pro · 还有 1 个任务在跑
        </Text>
      </View>
    </View>
  )
}
