import { useId, type PropsWithChildren } from 'react'
import { View } from 'react-native'
import Svg, { Circle, Defs, Path, RadialGradient, Stop } from 'react-native-svg'
import { useTheme } from './theme'

/** The same physical lens appears on the home screen, host cards and QR camera. */
export function Porthole({
  size = 58,
  online = true,
  muted = false,
  variant = 'scanner',
  children,
}: PropsWithChildren<{
  size?: number
  online?: boolean
  muted?: boolean
  variant?: 'home' | 'scanner'
}>) {
  const { colors, dark } = useTheme()
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const outer = `${id}-outer`,
    glass = `${id}-glass`,
    lamp = `${id}-lamp`
  const home = variant === 'home'
  const metalRadius = home ? (68 / 176) * 310 : 125
  const glassRadius = home ? (57 / 176) * 310 : 109
  const inset = ((155 - glassRadius) / 310) * size
  const lampRadius = home ? (5.5 / 176) * 310 : 6.5
  const lampX = home ? ((176 - 26 - 5.5) / 176) * 310 : 251.5
  const lampY = home ? ((22 + 5.5) / 176) * 310 : 40.5
  return (
    <View
      style={{
        width: size,
        height: size,
        position: 'relative',
        opacity: muted ? 0.62 : 1,
        borderRadius: size / 2,
        boxShadow: home
          ? '0 12px 24px rgba(110,52,32,0.22), 0 2px 4px rgba(80,40,24,0.2)'
          : size > 100
            ? '0 20px 40px rgba(0,0,0,0.5)'
            : '0 2px 4px rgba(100,50,30,0.25)',
      }}
    >
      <Svg width={size} height={size} viewBox="0 0 310 310">
        <Defs>
          <RadialGradient id={outer} cx="34%" cy="28%" rx="98%" ry="98%">
            <Stop offset="0" stopColor={muted ? '#C1BDB4' : '#D27A5C'} />
            <Stop offset={0.46} stopColor={muted ? '#A39D91' : colors.accent} />
            <Stop offset="1" stopColor={muted ? '#817B70' : '#8F3F2A'} />
          </RadialGradient>

          <RadialGradient
            id={glass}
            cx={home ? '40%' : '46%'}
            cy={home ? '32%' : '40%'}
            rx={home ? '91%' : '65%'}
            ry={home ? '91%' : '65%'}
          >
            <Stop offset="0" stopColor={home ? '#34322E' : '#4A4741'} />
            <Stop offset={0.7} stopColor={home ? '#1B1A18' : '#2B2925'} />
            <Stop offset="1" stopColor={home ? '#1B1A18' : '#191815'} />
          </RadialGradient>
          <RadialGradient id={lamp} cx="35%" cy="30%" rx="65%" ry="65%">
            <Stop
              offset="0"
              stopColor={online ? (home ? '#FFD38D' : '#D6E8A8') : '#CCC5B9'}
            />
            <Stop
              offset={0.6}
              stopColor={
                online ? (home ? colors.amber : colors.green) : '#A39B8D'
              }
            />
            <Stop
              offset="1"
              stopColor={online ? (home ? '#A76123' : '#5E6E33') : '#746D62'}
            />
          </RadialGradient>
        </Defs>
        <Circle
          cx="155"
          cy="155"
          r="154"
          fill={`url(#${outer})`}
          stroke="rgba(255,255,255,.18)"
          strokeWidth="2"
        />
        <Circle
          cx="155"
          cy="156"
          r={metalRadius + 1}
          fill="rgba(40,20,10,.35)"
        />
        {Array.from({ length: 180 }, (_, index) => {
          const palette =
            dark && home
              ? [
                  '#9A968E',
                  '#6E6A63',
                  '#B3AFA6',
                  '#64605A',
                  '#9C988F',
                  '#6F6B64',
                  '#9A968E',
                ]
              : [
                  '#EDEBE6',
                  '#C7C3BA',
                  '#F6F5F1',
                  '#BAB6AD',
                  '#EEECE7',
                  '#C9C5BD',
                  '#EDEBE6',
                ]
          const position = (index / 180) * (palette.length - 1)
          const from = palette[Math.floor(position)],
            to = palette[Math.min(palette.length - 1, Math.floor(position) + 1)]
          const progress = position % 1
          const color =
            '#' +
            [1, 3, 5]
              .map((offset) =>
                Math.round(
                  parseInt(from.slice(offset, offset + 2), 16) *
                    (1 - progress) +
                    parseInt(to.slice(offset, offset + 2), 16) * progress
                )
                  .toString(16)
                  .padStart(2, '0')
              )
              .join('')
          const a = ((210 + index * 2) * Math.PI) / 180,
            b = a + (2.15 * Math.PI) / 180
          const x1 = 155 + Math.sin(a) * metalRadius,
            y1 = 155 - Math.cos(a) * metalRadius
          const x2 = 155 + Math.sin(b) * metalRadius,
            y2 = 155 - Math.cos(b) * metalRadius
          return (
            <Path
              key={index}
              d={`M155 155 L${x1} ${y1} A${metalRadius} ${metalRadius} 0 0 1 ${x2} ${y2} Z`}
              fill={color}
              stroke={color}
              strokeWidth={0.6}
            />
          )
        })}
        <Circle
          cx="155"
          cy="155"
          r={metalRadius}
          fill="none"
          stroke="rgba(255,255,255,.7)"
          strokeWidth="1"
        />
        <Circle
          cx="155"
          cy="155"
          r={glassRadius}
          fill={`url(#${glass})`}
          stroke="#25231F"
          strokeWidth="2"
        />
        <Circle
          cx={lampX}
          cy={lampY}
          r={lampRadius + 1.5}
          fill="rgba(70,28,16,.3)"
        />
        <Circle cx={lampX} cy={lampY} r={lampRadius} fill={`url(#${lamp})`} />
      </Svg>
      {children && (
        <View
          style={{
            position: 'absolute',
            left: inset,
            top: inset,
            width: size - inset * 2,
            height: size - inset * 2,
            borderRadius: size / 2,
            overflow: 'hidden',
          }}
        >
          {children}
        </View>
      )}
    </View>
  )
}
