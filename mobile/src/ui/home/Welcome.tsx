import { Fragment } from 'react'
import { ScrollView, View } from 'react-native'
import Svg, { Path, Rect } from 'react-native-svg'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Text } from '../Text'
import { Button, InlineError, useColors } from '../kit'
import { Logo } from '../Logo'

/** 第一次打开（还没有电脑）：品牌、一张示意图、三步说明和两个入口。 */
export function Welcome({
  error,
  onScan,
  onManual,
}: {
  /** 读取本地存储失败等需要告诉用户的错误。 */
  error?: string
  onScan(): void
  onManual(): void
}) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  return (
    <ScrollView
      contentContainerStyle={{
        flexGrow: 1,
        paddingHorizontal: 24,
        paddingTop: 38,
        paddingBottom: Math.max(insets.bottom, 34),
      }}
    >
      <InlineError text={error} style={{ marginBottom: 12 }} />
      <View style={{ marginLeft: -4 }}>
        <Logo size={78} />
      </View>
      <Text
        accessibilityRole="header"
        style={{
          marginTop: 18,
          fontSize: 32,
          lineHeight: 38,
          fontWeight: '700',
          letterSpacing: -0.4,
          color: colors.ink,
        }}
      >
        cc-haha
      </Text>
      <Text style={{ marginTop: 8, fontSize: 16, lineHeight: 24, color: colors.ink2 }}>
        电脑上的任务在跑，你在手机上看着、拍板。
      </Text>

      <SettingsSketch />

      <View
        style={{ marginTop: 14, backgroundColor: colors.card, borderRadius: 16, overflow: 'hidden' }}
      >
        {steps.map((step, index) => (
          <Fragment key={step.title}>
            {index > 0 ? <View style={{ height: 1, backgroundColor: colors.hair }} /> : null}
            <View
              accessible
              accessibilityLabel={`第 ${index + 1} 步，${step.title}${step.hint ? `。${step.hint}` : ''}`}
              style={{
                minHeight: 56,
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: 12,
                paddingHorizontal: 14,
                paddingVertical: 12,
              }}
            >
              <View
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  backgroundColor: colors.fill,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: '600', color: colors.ink }}>
                  {index + 1}
                </Text>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontSize: 15, lineHeight: 24, color: colors.ink }}>{step.title}</Text>
                {step.hint ? (
                  <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>{step.hint}</Text>
                ) : null}
              </View>
            </View>
          </Fragment>
        ))}
      </View>

      <View style={{ flex: 1, minHeight: 24 }} />
      <Button title="扫码连接" icon="scan" size="lg" onPress={onScan} />
      <Button title="手动输入地址" variant="plain" onPress={onManual} style={{ marginTop: 8 }} />
    </ScrollView>
  )
}

const steps = [
  { title: '在电脑上打开 cc-haha', hint: '' },
  { title: '进入 设置 → H5 访问', hint: '同一个 Wi-Fi 用局域网直连，不在一起用公网访问' },
  { title: '用手机扫页面上的二维码', hint: '' },
]

/** 电脑「设置 → H5 访问」页的示意：侧栏 + 两段说明 + 二维码。只是装饰，读屏跳过。 */
function SettingsSketch() {
  const colors = useColors()
  const side = (label: string, active?: boolean) => (
    <View
      key={label}
      style={{
        height: 22,
        borderRadius: 6,
        paddingHorizontal: 8,
        justifyContent: 'center',
        backgroundColor: active ? colors.card : 'transparent',
        boxShadow: active ? `0 0 0 1px ${colors.hair}` : undefined,
      }}
    >
      <Text
        style={{
          fontSize: 11,
          fontWeight: active ? '600' : '400',
          color: active ? colors.ink : colors.ink3,
        }}
      >
        {label}
      </Text>
    </View>
  )
  const bar = (width: number, top = 0) => (
    <View
      style={{ height: 6, width, borderRadius: 3, backgroundColor: colors.fill, marginTop: top }}
    />
  )
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        marginTop: 26,
        height: 128,
        borderRadius: 14,
        flexDirection: 'row',
        overflow: 'hidden',
        backgroundColor: colors.card,
        boxShadow: `0 0 0 1px ${colors.hair}`,
      }}
    >
      <View style={{ width: 112, backgroundColor: colors.sheet, padding: 8, paddingTop: 10, gap: 3 }}>
        <View style={{ flexDirection: 'row', gap: 4, paddingHorizontal: 2, paddingBottom: 8 }}>
          {[0, 1, 2].map((dot) => (
            <View
              key={dot}
              style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: colors.switchOff }}
            />
          ))}
        </View>
        {side('通用')}
        {side('模型配置')}
        {side('H5 访问', true)}
        {side('IM 接入')}
      </View>
      <View
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingHorizontal: 14,
          paddingVertical: 12,
        }}
      >
        <View style={{ flex: 1, gap: 6 }}>
          <Text style={{ fontSize: 12, fontWeight: '600', color: colors.ink }}>局域网直连</Text>
          {bar(72)}
          {bar(54)}
          <Text style={{ fontSize: 12, fontWeight: '600', color: colors.ink, marginTop: 6 }}>
            公网访问
          </Text>
          {bar(64)}
        </View>
        <QrSketch />
      </View>
    </View>
  )
}

/** 21×21 的示意二维码（不可扫描）。 */
function QrSketch() {
  const colors = useColors()
  return (
    <View style={{ borderRadius: 6, overflow: 'hidden', boxShadow: `0 0 0 1px ${colors.hair}` }}>
      <Svg width={76} height={76} viewBox="0 0 21 21">
        <Rect width={21} height={21} fill="#FFFFFF" />
        <Path d="M1 1h7v7H1zM13 1h7v7h-7zM1 13h7v7H1z" fill="#1D1C1A" />
        <Path d="M2 2h5v5H2zM14 2h5v5h-5zM2 14h5v5H2z" fill="#FFFFFF" />
        <Path d="M3 3h3v3H3zM15 3h3v3h-3zM3 15h3v3H3z" fill="#1D1C1A" />
        <Path
          d="M10 1h1v2h-1zM9 4h2v1H9zM10 6h1v3h-1zM12 9h2v1h-2zM9 10h2v2H9zM1 10h2v1H1zM4 9h3v1H4zM15 10h2v1h-2zM18 9h2v2h-2zM13 12h2v2h-2zM10 14h3v1h-3zM16 13h1v3h-1zM18 15h2v1h-2zM10 17h1v3h-1zM12 18h3v1h-3zM17 18h3v2h-3z"
          fill="#1D1C1A"
        />
      </Svg>
    </View>
  )
}
