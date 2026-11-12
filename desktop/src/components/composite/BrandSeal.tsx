import { cx } from '@/lib/cx'

/**
 * The cc-haha mark — the double C of "Claude Code" with one vermilion stroke on it.
 *
 * Geometry is a vector rebuild of the original `app-icon.png`, measured off the
 * bitmap pixel by pixel (arc centers, radii, stroke widths and opening angles
 * were fitted, then rounded to symmetric values). Two things the raster could
 * not do:
 *
 * 1. Recolor. The PNG carried its own blue/cyan/orange under all six palettes
 *    while everything around it moved. Here the C's take `--color-text-primary`
 *    and the accents take `--color-brand`, so every theme repaints the mark.
 * 2. Shrink. Four ideas — the two C's, the bar, the cursor and two sparkles —
 *    collapse into noise below 24px. So the mark sheds parts as it gets
 *    smaller (see `SIZES`) instead of turning to mush.
 */
export type BrandSealSize = 'sm' | 'md' | 'lg' | 'xl'

/** Which elements survive at each size. */
type MarkParts = 'ccbar' | 'nostars' | 'full'

/**
 * The sizes the layout calls for — sidebar 32, collapsed rail 38, empty state
 * 80 — plus a 24px one for dense chrome.
 *
 * `viewBox` is cropped to the ink bounds of that part set (measured from a
 * render, not guessed) so the mark fills its box at every size; `w` follows
 * from the crop's aspect ratio, which is why the boxes are not square.
 *
 * The sparkles only appear at `xl`: at 38px they are under 2px across and read
 * as dirt. The cursor goes at `sm` for the same reason.
 */
const SIZES: Record<BrandSealSize, { box: string; viewBox: string; parts: MarkParts }> = {
  sm: { box: 'h-6 w-[31px]', viewBox: '252 403 415 326', parts: 'ccbar' },
  md: { box: 'h-8 w-[41px]', viewBox: '252 381 444 348', parts: 'nostars' },
  lg: { box: 'h-[38px] w-[48px]', viewBox: '252 381 444 348', parts: 'nostars' },
  xl: { box: 'h-20 w-[98px]', viewBox: '252 306 519 423', parts: 'full' },
}

const INK = 'var(--color-text-primary)'
const SEAL = 'var(--color-brand)'

/** Big C: open 160°, symmetric about the horizontal axis. */
const BIG_C = 'M437.75 695.01A131 131 0 1 1 437.75 436.99'
/** Second C, cut into two arcs of 68° each. */
const SMALL_C_UPPER = 'M505.06 535.98A117 117 0 0 1 610.92 459.07'
const SMALL_C_LOWER = 'M635.32 691.22A117 117 0 0 1 515.78 638.00'
/** The bar that runs through the second C's gap. */
const BAR = 'M441.5 576H517.5'
/** Cursor arrow: tip up-right, two tails and a notch. */
const CURSOR = 'M683.79 384.80Q698.00 380.00 692.43 393.93L665.57 461.07Q660.00 475.00 655.71 460.63L645.00 424.71Q643.00 418.00 636.59 415.18L629.25 411.95Q618.00 407.00 631.26 402.52L683.79 384.80Z'
const SPARKLE_LG = 'M717.00 308.00Q724.07 325.43 741.50 332.50Q724.07 339.57 717.00 357.00Q709.93 339.57 692.50 332.50Q709.93 325.43 717.00 308.00Z'
const SPARKLE_SM = 'M755.50 365.00Q759.04 374.96 769.00 378.50Q759.04 382.04 755.50 392.00Q751.96 382.04 742.00 378.50Q751.96 374.96 755.50 365.00Z'

export type BrandSealProps = {
  size?: BrandSealSize
  className?: string
}

export function BrandSeal({ size = 'md', className }: BrandSealProps) {
  const spec = SIZES[size]

  return (
    <svg
      // Decorative: the product name sits next to the mark in the sidebar and
      // above it on the empty state, so announcing the brand twice is noise.
      aria-hidden="true"
      focusable="false"
      viewBox={spec.viewBox}
      className={cx('flex-shrink-0', spec.box, className)}
    >
      <g fill="none" stroke={INK} strokeLinecap="round">
        <path d={BIG_C} strokeWidth={60} />
        <path d={SMALL_C_UPPER} strokeWidth={58} />
        <path d={SMALL_C_LOWER} strokeWidth={58} />
      </g>
      <path d={BAR} fill="none" stroke={SEAL} strokeWidth={35} strokeLinecap="round" />
      {spec.parts !== 'ccbar' && <path d={CURSOR} fill={SEAL} />}
      {spec.parts === 'full' && (
        <>
          <path d={SPARKLE_LG} fill={SEAL} />
          <path d={SPARKLE_SM} fill={SEAL} />
        </>
      )}
    </svg>
  )
}
