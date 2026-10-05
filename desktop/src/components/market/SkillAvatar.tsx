import type { NormalizedSkill } from '../../types/market'

/** First visible character of the name, uppercased (handles CJK and multi-byte chars). */
function initialOf(name: string): string {
  const first = Array.from(name.trim())[0]
  return first ? first.toUpperCase() : '?'
}

/**
 * Up to 48px is a list tile and takes the control corner; anything larger is a
 * page-head mark and takes the card corner. The letter follows the same split.
 */
function tileClasses(size: number) {
  return size > 48
    ? 'rounded-[var(--radius-lg)] text-[22px]'
    : size >= 40
      ? 'rounded-[var(--radius-md)] text-[15px]'
      : 'rounded-[var(--radius-sm)] text-[13px]'
}

/**
 * Skill icon with a letter fallback.
 *
 * The fallback used to be one of six hand-mixed gradients picked by a hash of
 * the name, in raw hex that ignored the theme. It is now the sunken tile every
 * other icon slot uses, with the initial in secondary ink: a catalog of
 * community skills reads as one product, and the tile follows all three themes.
 */
export function SkillAvatar({
  skill,
  size = 40,
  className = '',
}: {
  skill: Pick<NormalizedSkill, 'name' | 'iconUrl'>
  size?: number
  className?: string
}) {
  const tile = tileClasses(size)

  if (skill.iconUrl) {
    return (
      <img
        src={skill.iconUrl}
        alt=""
        loading="lazy"
        style={{ width: size, height: size }}
        className={`flex-shrink-0 border border-[var(--color-border)] bg-[var(--color-surface-container)] object-cover ${tile} ${className}`}
      />
    )
  }
  return (
    <span
      aria-hidden
      data-testid="skill-avatar-fallback"
      style={{ width: size, height: size }}
      className={`inline-flex flex-shrink-0 select-none items-center justify-center bg-[var(--color-surface-container)] font-semibold text-[var(--color-text-secondary)] ${tile} ${className}`}
    >
      {initialOf(skill.name)}
    </span>
  )
}
