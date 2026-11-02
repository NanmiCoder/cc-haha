import Svg, { Path } from 'react-native-svg'
import { useColors } from './kit'

/**
 * cc-haha 的 CC 标志（取自 docs/images/logo-horizontal.svg，去掉底色）。
 * 笔画跟随文字色，所以深色模式自动变浅；陶土色只出现在这里。
 */
export function Logo({ size = 34, label = 'cc-haha 标志' }: { size?: number; label?: string }) {
  const colors = useColors()
  // viewBox 只裁出标志本身，宽高比 524:434。
  const height = (size * 434) / 524
  return (
    <Svg
      width={size}
      height={height}
      viewBox="250 300 524 434"
      accessibilityRole="image"
      accessibilityLabel={label}
    >
      <Path d="M437.75 695.01A131 131 0 1 1 437.75 436.99" fill="none" stroke={colors.ink} strokeWidth={60} strokeLinecap="round" />
      <Path d="M505.06 535.98A117 117 0 0 1 610.92 459.07" fill="none" stroke={colors.ink} strokeWidth={58} strokeLinecap="round" />
      <Path d="M635.32 691.22A117 117 0 0 1 515.78 638.00" fill="none" stroke={colors.ink} strokeWidth={58} strokeLinecap="round" />
      <Path d="M441.5 576H517.5" fill="none" stroke={colors.brand} strokeWidth={35} strokeLinecap="round" />
      <Path d="M683.79 384.80Q698.00 380.00 692.43 393.93L665.57 461.07Q660.00 475.00 655.71 460.63L645.00 424.71Q643.00 418.00 636.59 415.18L629.25 411.95Q618.00 407.00 631.26 402.52L683.79 384.80Z" fill={colors.brand} />
      <Path d="M717.00 308.00Q724.07 325.43 741.50 332.50Q724.07 339.57 717.00 357.00Q709.93 339.57 692.50 332.50Q709.93 325.43 717.00 308.00Z" fill={colors.brand} />
      <Path d="M755.50 365.00Q759.04 374.96 769.00 378.50Q759.04 382.04 755.50 392.00Q751.96 382.04 742.00 378.50Q751.96 374.96 755.50 365.00Z" fill={colors.brand} />
    </Svg>
  )
}
