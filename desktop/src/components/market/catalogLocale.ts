import type { Locale } from '../../i18n/locale'
import { useSettingsStore } from '../../stores/settingsStore'
import type { MarketCategory, NormalizedSkill } from '../../types/market'

/**
 * Which copy of the curated catalog a reader sees.
 *
 * Curated entries carry an English summary and category name alongside the
 * originals; those are shown. Curated tags are not, since they are not
 * translated. Live (non-curated) results carry the upstream's own text, which
 * is shown as it is.
 */
export function skillSummary(skill: Pick<NormalizedSkill, 'summary' | 'summaryEn'>, _locale: Locale): string {
  return skill.summaryEn || skill.summary
}

export function visibleTags(skill: Pick<NormalizedSkill, 'tags' | 'curated'>, _locale: Locale): string[] {
  if (skill.curated) return []
  return skill.tags
}

export function categoryLabel(category: Pick<MarketCategory, 'name' | 'nameEn'>, _locale: Locale): string {
  return category.nameEn || category.name
}

/**
 * Display name of a skill's category. On a curated skill `category` is a
 * catalog key, resolved through the category list; on anything else it is the
 * upstream's raw string and is shown as is. An unknown key resolves to nothing
 * rather than leaking the key.
 */
export function resolveCategory(
  skill: Pick<NormalizedSkill, 'category' | 'curated'>,
  categories: readonly MarketCategory[],
  locale: Locale,
): string | undefined {
  if (!skill.category) return undefined
  if (!skill.curated) return skill.category
  const match = categories.find((category) => category.key === skill.category)
  return match ? categoryLabel(match, locale) : undefined
}

export function useMarketLocale(): Locale {
  return useSettingsStore((state) => state.locale)
}
