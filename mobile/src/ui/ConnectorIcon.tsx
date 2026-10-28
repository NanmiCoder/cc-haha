import { Image, View } from 'react-native'
import { Glyph } from './compose/glyphs'
import { connectorIconSources } from './connectorIconSources'
import { useColors } from './kit'

/** 连接器的 logo（桌面端同一套，构建期转成 PNG 随应用发布）；没有对应图标时画一个插头。 */
export function ConnectorIcon({ id, size = 30 }: { id?: string; size?: number }) {
  const colors = useColors()
  const source = id ? connectorIconSources[id] : undefined
  const radius = Math.round(size * 0.27)
  if (source)
    return (
      <Image
        accessible={false}
        source={source}
        style={{ width: size, height: size, borderRadius: radius, backgroundColor: colors.fill }}
      />
    )
  return (
    <View
      style={{ width: size, height: size, borderRadius: radius, backgroundColor: colors.fill, alignItems: 'center', justifyContent: 'center' }}
    >
      <Glyph name="plug" size={Math.round(size * 0.55)} color={colors.ink2} />
    </View>
  )
}
