import Svg, { Line, Path, Rect } from 'react-native-svg'

/**
 * icons.tsx 里还没有的几个 Lucide 线性图标（24 网格）。
 * 只在输入框和两张底单里用，所以放在这里，不去动共用图标表。
 */
type Name = 'plug' | 'bot' | 'workflow' | 'lock' | 'monitor' | 'shield-alert'

export function Glyph({
  name,
  size = 20,
  color,
  strokeWidth = 1.75,
}: {
  name: Name
  size?: number
  color: string
  strokeWidth?: number
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === 'plug' ? (
        <>
          <Path d="M12 22v-5" />
          <Path d="M9 8V2" />
          <Path d="M15 8V2" />
          <Path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
        </>
      ) : name === 'bot' ? (
        <>
          <Path d="M12 8V4H8" />
          <Rect x={4} y={8} width={16} height={12} rx={2} />
          <Path d="M2 14h2" />
          <Path d="M20 14h2" />
          <Path d="M15 13v2" />
          <Path d="M9 13v2" />
        </>
      ) : name === 'workflow' ? (
        <>
          <Rect x={3} y={3} width={8} height={8} rx={2} />
          <Path d="M7 11v4a2 2 0 0 0 2 2h4" />
          <Rect x={13} y={13} width={8} height={8} rx={2} />
        </>
      ) : name === 'lock' ? (
        <>
          <Rect x={3} y={11} width={18} height={11} rx={2} />
          <Path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </>
      ) : name === 'monitor' ? (
        <>
          <Rect x={2} y={3} width={20} height={14} rx={2} />
          <Line x1={8} x2={16} y1={21} y2={21} />
          <Line x1={12} x2={12} y1={17} y2={21} />
        </>
      ) : name === 'shield-alert' ? (
        <>
          <Path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
          <Path d="M12 8v4" />
          <Path d="M12 16h.01" />
        </>
      ) : null}
    </Svg>
  )
}
