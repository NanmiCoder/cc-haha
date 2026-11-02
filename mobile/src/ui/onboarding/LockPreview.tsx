import { View } from 'react-native'
import { Text } from '../Text'
import { Mono, Spinner, useColors } from '../kit'
import { Logo } from '../Logo'
import { dark } from '../palette'

/**
 * 通知引导页里的锁屏示意：纯装饰，读屏忽略。
 * 锁屏本身永远是深色（系统画的），所以取深色色板，不跟随 App 的明暗。
 */
export function LockPreview({ hostName }: { hostName: string }) {
  const colors = useColors()
  const glass = {
    borderRadius: 20,
    backgroundColor: 'rgba(238,236,231,0.12)',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 4,
  } as const
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        borderRadius: 28,
        backgroundColor: dark.fill,
        paddingTop: 22,
        paddingHorizontal: 14,
        paddingBottom: 16,
        gap: 10,
      }}
    >
      <Text
        style={{
          textAlign: 'center',
          color: dark.ink2,
          fontSize: 40,
          lineHeight: 46,
          fontWeight: '300',
          letterSpacing: -0.5,
          paddingBottom: 6,
        }}
      >
        9:41
      </Text>
      <View style={glass}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              backgroundColor: colors.card,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Logo size={17} label="" />
          </View>
          <Text style={{ flex: 1, color: dark.ink, fontSize: 13, fontWeight: '600' }}>
            cc-haha
          </Text>
          <Text style={{ color: dark.ink3, fontSize: 12 }}>现在</Text>
        </View>
        <Text
          numberOfLines={1}
          style={{ color: dark.ink, fontSize: 15, lineHeight: 20, fontWeight: '600' }}
        >
          {hostName} 想运行命令
        </Text>
        <Mono
          numberOfLines={1}
          style={{ color: dark.ink2, fontSize: 12.5, lineHeight: 18 }}
        >
          $ bun test src/core/sessionTransport.test.ts
        </Mono>
      </View>
      <View style={[glass, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
        <Spinner size={18} color={dark.run} track={dark.runSoft} thickness={2.2} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text
            numberOfLines={1}
            style={{ color: dark.ink, fontSize: 14, fontWeight: '600' }}
          >
            给移动端加扫码配对
          </Text>
          <Text numberOfLines={1} style={{ color: dark.ink3, fontSize: 12 }}>
            {hostName} · 还有 1 个任务在跑
          </Text>
        </View>
        <Mono style={{ color: dark.run, fontSize: 15 }}>14:35</Mono>
      </View>
    </View>
  )
}
