import Svg, { Circle, Line, Path, Polygon, Polyline, Rect } from 'react-native-svg'
import { useTheme } from './theme'

type Shape =
  | ['path', string]
  | ['circle', number, number, number]
  | ['rect', number, number, number, number, number]
  | ['line', number, number, number, number]
  | ['polyline', string]
  | ['polygon', string]

/** Lucide 线性图标（24 网格，圆角端点），与设计稿一致。 */
const icons = {
  search: [['circle', 11, 11, 8], ['path', 'm21 21-4.3-4.3']],
  settings: [
    [
      'path',
      'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
    ],
    ['circle', 12, 12, 3],
  ],
  'chevron-down': [['path', 'm6 9 6 6 6-6']],
  'chevron-up': [['path', 'm18 15-6-6-6 6']],
  'chevron-left': [['path', 'm15 18-6-6 6-6']],
  'chevron-right': [['path', 'm9 18 6-6-6-6']],
  compose: [
    ['path', 'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7'],
    [
      'path',
      'M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z',
    ],
  ],
  'list-filter': [['path', 'M3 6h18'], ['path', 'M7 12h10'], ['path', 'M10 18h4']],
  x: [['path', 'M18 6 6 18'], ['path', 'm6 6 12 12']],
  plus: [['path', 'M5 12h14'], ['path', 'M12 5v14']],
  'arrow-up': [['path', 'm5 12 7-7 7 7'], ['path', 'M12 19V5']],
  check: [['path', 'M20 6 9 17l-5-5']],
  pencil: [
    [
      'path',
      'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
    ],
  ],
  file: [
    ['path', 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'],
    ['path', 'M14 2v4a2 2 0 0 0 2 2h4'],
  ],
  folder: [
    [
      'path',
      'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
    ],
  ],
  'git-branch': [
    ['line', 6, 3, 6, 15],
    ['circle', 18, 6, 3],
    ['circle', 6, 18, 3],
    ['path', 'M18 9a9 9 0 0 1-9 9'],
  ],
  'git-fork': [
    ['circle', 12, 18, 3],
    ['circle', 6, 6, 3],
    ['circle', 18, 6, 3],
    ['path', 'M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9'],
    ['path', 'M12 12v3'],
  ],
  'rotate-ccw': [
    ['path', 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8'],
    ['path', 'M3 3v5h5'],
  ],
  'refresh-cw': [
    ['path', 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8'],
    ['path', 'M21 3v5h-5'],
    ['path', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16'],
    ['path', 'M8 16H3v5'],
  ],
  copy: [
    ['rect', 8, 8, 14, 14, 2],
    ['path', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
  ],
  'text-cursor': [
    ['path', 'M17 22h-1a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4h1'],
    ['path', 'M7 22h1a4 4 0 0 0 4-4v-1'],
    ['path', 'M7 2h1a4 4 0 0 1 4 4v1'],
  ],
  trash: [
    ['path', 'M3 6h18'],
    ['path', 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6'],
    ['path', 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2'],
  ],
  share: [
    ['path', 'M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8'],
    ['polyline', '16 6 12 2 8 6'],
    ['line', 12, 2, 12, 15],
  ],
  clock: [['circle', 12, 12, 9.5], ['path', 'M12 7v5l3 2']],
  laptop: [
    [
      'path',
      'M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16',
    ],
  ],
  image: [
    ['rect', 3, 3, 18, 18, 2],
    ['circle', 9, 9, 2],
    ['path', 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21'],
  ],
  camera: [
    [
      'path',
      'M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z',
    ],
    ['circle', 12, 13, 3],
  ],
  users: [
    ['path', 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'],
    ['circle', 9, 7, 4],
    ['path', 'M22 21v-2a4 4 0 0 0-3-3.87'],
    ['path', 'M16 3.13a4 4 0 0 1 0 7.75'],
  ],
  shield: [
    [
      'path',
      'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
    ],
  ],
  cpu: [
    ['rect', 4, 4, 16, 16, 2],
    ['rect', 9, 9, 6, 6, 1],
    ['path', 'M15 2v2'],
    ['path', 'M15 20v2'],
    ['path', 'M2 15h2'],
    ['path', 'M2 9h2'],
    ['path', 'M20 15h2'],
    ['path', 'M20 9h2'],
    ['path', 'M9 2v2'],
    ['path', 'M9 20v2'],
  ],
  activity: [
    [
      'path',
      'M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2',
    ],
  ],
  'list-checks': [
    ['path', 'm3 17 2 2 4-4'],
    ['path', 'm3 7 2 2 4-4'],
    ['path', 'M13 6h8'],
    ['path', 'M13 12h8'],
    ['path', 'M13 18h8'],
  ],
  'wifi-off': [
    ['path', 'M12 20h.01'],
    ['path', 'M8.5 16.43a5 5 0 0 1 7 0'],
    ['path', 'M5 12.86a10 10 0 0 1 5.17-2.69'],
    ['path', 'M19 12.86a10 10 0 0 0-2-1.54'],
    ['path', 'M2 8.82a15 15 0 0 1 4.18-2.65'],
    ['path', 'M22 8.82a15 15 0 0 0-11.29-3.76'],
    ['path', 'm2 2 20 20'],
  ],
  link: [
    ['path', 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'],
    ['path', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
  ],
  play: [['polygon', '6 3 20 12 6 21 6 3']],
  flashlight: [
    [
      'path',
      'M18 6c0 2-2 2-2 4v10a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V10c0-2-2-2-2-4V2h12z',
    ],
    ['line', 6, 6, 18, 6],
    ['line', 12, 12, 12, 12],
  ],
  'circle-alert': [
    ['circle', 12, 12, 9.5],
    ['path', 'M12 7.5v5.5'],
    ['path', 'M12 16.5h.01'],
  ],
  'circle-check': [['circle', 12, 12, 9.5], ['path', 'm8.5 12.2 2.4 2.4 4.6-4.8']],
  'external-link': [
    ['path', 'M15 3h6v6'],
    ['path', 'M10 14 21 3'],
    ['path', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  ],
  scan: [
    ['path', 'M3 7V5a2 2 0 0 1 2-2h2'],
    ['path', 'M17 3h2a2 2 0 0 1 2 2v2'],
    ['path', 'M21 17v2a2 2 0 0 1-2 2h-2'],
    ['path', 'M7 21H5a2 2 0 0 1-2-2v-2'],
  ],
  terminal: [['polyline', '4 17 10 11 4 5'], ['line', 12, 19, 20, 19]],
  globe: [
    ['circle', 12, 12, 10],
    ['path', 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20'],
    ['path', 'M2 12h20'],
  ],
  bell: [
    ['path', 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9'],
    ['path', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
  ],
  info: [['circle', 12, 12, 9.5], ['path', 'M12 16v-4'], ['path', 'M12 8h.01']],
  smartphone: [['rect', 5, 2, 14, 20, 2], ['path', 'M12 18h.01']],
  paperclip: [
    [
      'path',
      'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48',
    ],
  ],
  sparkle: [
    [
      'path',
      'M9.94 14.06 2 22m7.94-7.94L12 22l2.06-7.94L22 12l-7.94-2.06L12 2 9.94 9.94 2 12Z',
    ],
  ],
} satisfies Record<string, Shape[]>

export type IconName = keyof typeof icons | 'more' | 'stop'

export function Icon({
  name,
  size = 20,
  color,
  strokeWidth = 1.75,
}: {
  name: IconName
  size?: number
  color?: string
  strokeWidth?: number
}) {
  const { colors } = useTheme()
  const tint = color ?? colors.ink2
  if (name === 'more')
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill={tint}>
        <Circle cx={5} cy={12} r={1.8} />
        <Circle cx={12} cy={12} r={1.8} />
        <Circle cx={19} cy={12} r={1.8} />
      </Svg>
    )
  if (name === 'stop')
    return (
      <Svg width={size} height={size} viewBox="0 0 12 12">
        <Rect x={1} y={1} width={10} height={10} rx={2} fill={tint} />
      </Svg>
    )
  const filled = name === 'play'
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? tint : 'none'}
      stroke={filled ? 'none' : tint}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {(icons[name] as Shape[]).map((shape, index) => {
        switch (shape[0]) {
          case 'path':
            return <Path key={index} d={shape[1]} />
          case 'circle':
            return <Circle key={index} cx={shape[1]} cy={shape[2]} r={shape[3]} />
          case 'rect':
            return (
              <Rect
                key={index}
                x={shape[1]}
                y={shape[2]}
                width={shape[3]}
                height={shape[4]}
                rx={shape[5]}
              />
            )
          case 'line':
            return (
              <Line key={index} x1={shape[1]} y1={shape[2]} x2={shape[3]} y2={shape[4]} />
            )
          case 'polyline':
            return <Polyline key={index} points={shape[1]} />
          case 'polygon':
            return <Polygon key={index} points={shape[1]} />
        }
      })}
    </Svg>
  )
}
