import { useState } from 'react'
import { ArrowLeft, PackageCheck } from 'lucide-react'
import { useTranslation } from '@/i18n'
import { cx } from '@/lib/cx'
import { Button } from '@/components/ui/Button'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { EXTENSION_PAGE_COLUMN } from '@/components/market/pageLayout'
import { Connectors } from '@/pages/Connectors'
import { Market } from '@/pages/Market'
import { InstalledSkills } from '@/pages/InstalledSkills'

export function ExtensionMarket() {
  const t = useTranslation()
  const [section, setSection] = useState<'plugins' | 'skills'>('plugins')
  const [managing, setManaging] = useState(false)
  const myLabel = t(section === 'plugins' ? 'extensions.myPlugins' : 'extensions.mySkills')
  const description = section === 'plugins'
    ? t('extensions.pluginsSubtitle')
    : t(managing ? 'settings.skills.description' : 'market.subtitle')
  return <section className="flex h-full min-h-0 flex-col bg-[var(--color-surface)]">
    {/* The only page head on this surface: the market and the installed lists
        below render straight into the column, without a title of their own. */}
    <header className="shrink-0 border-b border-[var(--color-border)]">
      <div className={cx(EXTENSION_PAGE_COLUMN, 'flex flex-wrap items-end gap-x-6 gap-y-3 pb-4 pt-7')}>
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-semibold leading-[30px] text-[var(--color-text-primary)]">{managing ? myLabel : t('sidebar.extensions')}</h1>
          <p className="mt-1.5 text-[13px] leading-5 text-[var(--color-text-tertiary)]">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SegmentedControl label={t('extensions.sections')} value={section} onChange={setSection} items={[{ value: 'plugins', label: t('extensions.plugins') }, { value: 'skills', label: t('extensions.skills') }]} />
          <Button size="base" variant="secondary" icon={managing ? <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" /> : <PackageCheck size={14} strokeWidth={1.75} aria-hidden="true" />} onClick={() => setManaging(value => !value)}>
            {managing ? t('extensions.browse') : myLabel}
          </Button>
        </div>
      </div>
    </header>
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Curated skill packages are not offered for now. Their catalog, lock
          file and installer stay in src/services/connectors, so restoring the
          previous featured row is a change to the skills branch below. */}
      {managing
        ? section === 'plugins' ? <Connectors key="installed" management /> : <InstalledSkills />
        : section === 'plugins' ? <Connectors key="catalog" mode="plugins" /> : <Market />}
    </div>
  </section>
}
