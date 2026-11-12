import { Image, View } from 'react-native'
import { Glyph } from './compose/glyphs'
import { connectorIconSources } from './connectorIconSources'
import { useColors } from './kit'

/** Connector logos (same set as desktop, converted to PNG at build time and shipped with the app); draws a plug when there is no matching icon. */
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
