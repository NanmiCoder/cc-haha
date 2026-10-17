import { Pencil } from 'lucide-react'

import { IconButton } from '@/components/ui/IconButton'
import { useTranslation, type Locale } from '../../i18n'
import { formatTokenAmount } from './formatTokenUnits'
import { tokenAmountTitle } from './TokenAmount'
import {
  DEFAULT_AVATAR_SRC,
  getProfileAvatarSource,
  getProfileSubtitleHref,
  type ActivityProfile,
} from './useActivityProfile'

const DEFAULT_AVATAR_CLASS = 'h-full w-full scale-[1.28] object-contain'

type Props = {
  profile: ActivityProfile
  totalTokens: number
  activeDays: number
  locale: Locale
}

/**
 * Who this is and how much they have run: the avatar and project link on the
 * left, the lifetime total as the page's one large figure on the right.
 */
export function TokenHero({ profile, totalTokens, activeDays, locale }: Props) {
  const t = useTranslation()
  const { displayName, subtitle, avatarFile } = profile.profile
  const avatarSrc = getProfileAvatarSource(profile.profile) ?? DEFAULT_AVATAR_SRC
  const href = getProfileSubtitleHref(subtitle)
  const total = formatTokenAmount(totalTokens, locale)
  const dayLabel = t(activeDays === 1 ? 'settings.activity.activeDaysOne' : 'settings.activity.activeDaysOther', { count: activeDays })

  return (
    <div className="group/activity-profile flex flex-wrap items-end justify-between gap-x-10 gap-y-8">
      <div className="flex min-w-0 items-center gap-6">
        <div className="h-32 w-32 shrink-0 overflow-hidden rounded-full bg-[var(--color-surface)] shadow-[0_0_0_6px_var(--color-surface),0_0_0_7px_var(--color-outline)]">
          <img
            src={avatarSrc}
            alt={t('settings.activity.avatarAlt', { name: displayName })}
            className={avatarFile ? 'h-full w-full object-cover' : DEFAULT_AVATAR_CLASS}
            onError={(event) => {
              event.currentTarget.src = DEFAULT_AVATAR_SRC
              event.currentTarget.className = DEFAULT_AVATAR_CLASS
            }}
          />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h3 className="min-w-0 break-words text-[22px] font-semibold leading-snug tracking-[-0.01em] text-[var(--color-text-primary)]">
              {displayName}
            </h3>
            <IconButton
              icon={<Pencil size={14} strokeWidth={1.75} aria-hidden="true" />}
              label={t('settings.activity.editProfile')}
              size="sm"
              tone="muted"
              disabledStyle="hide"
              className="opacity-0 group-hover/activity-profile:opacity-100 focus-visible:opacity-100"
              onClick={profile.startEdit}
              disabled={profile.isLoading}
            />
          </div>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block max-w-full truncate font-mono text-xs text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-accent)]"
            >
              {subtitle}
            </a>
          ) : (
            <div className="mt-1 max-w-full truncate font-mono text-xs text-[var(--color-text-tertiary)]">{subtitle}</div>
          )}
          {profile.status && <div className="mt-1 text-xs text-[var(--color-success)]">{profile.status}</div>}
          {profile.error && !profile.isEditing && <div className="mt-1 text-xs text-[var(--color-error)]">{profile.error}</div>}
        </div>
      </div>

      <div className="ml-auto text-right" title={tokenAmountTitle(totalTokens, locale)}>
        <div className="font-mono text-xs text-[var(--color-text-tertiary)]">
          {t('settings.activity.totalTokens')} · {dayLabel}
        </div>
        <div className="mt-1.5 flex items-baseline justify-end">
          <span data-testid="token-total-value" className="token-hero-number text-[var(--color-text-primary)]">{total.value}</span>
          {total.unit ? (
            <span data-testid="token-total-unit" className="token-hero-unit ml-2.5 text-[var(--color-brand)]">{total.unit}</span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
