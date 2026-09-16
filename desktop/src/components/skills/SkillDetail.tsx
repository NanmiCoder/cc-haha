import { useCallback, useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useSkillStore } from '../../stores/skillStore'
import { useTranslation } from '../../i18n'
import { useUIStore } from '../../stores/uiStore'
import { marketApi } from '../../api/market'
import { useMarketStore } from '../../stores/marketStore'
import { SkillDetailView, type SkillDetailMetaItem } from '../market/SkillDetailView'
import type { PreviewFileContent } from '../market/FilePreview'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { LoadingState } from '@/components/ui/LoadingState'

export function SkillDetail({ embedded = false }: { embedded?: boolean }) {
  const { selectedSkill, selectedSkillReturnTab, selectedSkillContext, isDetailLoading, clearSelection, fetchSkills } = useSkillStore()
  const t = useTranslation()
  const [confirmUninstall, setConfirmUninstall] = useState(false)
  const [uninstalling, setUninstalling] = useState(false)

  const handleBack = useCallback(() => {
    const returnTab = selectedSkillReturnTab
    clearSelection()
    if (!embedded && returnTab === 'plugins') {
      useUIStore.getState().setPendingSettingsTab('plugins')
    }
  }, [selectedSkillReturnTab, clearSelection, embedded])

  const files = selectedSkill?.files ?? []

  // The files tab shows the file as it is on disk — frontmatter included. The
  // preview splits the YAML block out and renders it as structured metadata.
  const loadFile = useCallback(
    (path: string): Promise<PreviewFileContent> => {
      const file = files.find((f) => f.path === path)
      if (!file) return Promise.reject(new Error(`File not found: ${path}`))
      return Promise.resolve({
        path: file.path,
        content: file.content,
        language: file.language,
        size: file.content.length,
        truncated: false,
      })
    },
    [files],
  )

  const meta = useMemo<SkillDetailMetaItem[]>(() => {
    if (!selectedSkill) return []
    const skillMeta = selectedSkill.meta
    const items: SkillDetailMetaItem[] = [
      { label: t('settings.skills.summary.source'), value: t(`settings.skills.source.${skillMeta.source}`) },
      { label: t('settings.skills.summary.totalFiles'), value: String(selectedSkill.files.length) },
      {
        label: t('settings.skills.summary.tokens'),
        value: t('settings.skills.tokenEstimateShort', {
          count: String(Math.ceil(skillMeta.contentLength / 4)),
        }),
      },
    ]
    if (selectedSkill.marketMeta?.installedAt) {
      items.push({
        label: t('market.install.state.installed'),
        value: new Date(selectedSkill.marketMeta.installedAt).toLocaleDateString(),
      })
    }
    // SKILL.md frontmatter used to be flattened into this sidebar, where long
    // values and list fields were unreadable. It now renders as a structured
    // panel in the overview tab instead.
    return items
  }, [selectedSkill, t])

  if (isDetailLoading) {
    return <LoadingState label={t('common.loading')} labelHidden />
  }

  if (!selectedSkill) return null

  const skillMeta = selectedSkill.meta
  const marketMeta = selectedSkill.marketMeta
  const entryFile = selectedSkill.files.find((f) => f.isEntry)
  const description = entryFile ? (entryFile.body ?? entryFile.content) : ''
  const descriptionFrontmatter = entryFile?.frontmatter

  const runUninstall = async () => {
    if (!marketMeta) return
    setUninstalling(true)
    try {
      await marketApi.uninstall(marketMeta.id)
      useUIStore.getState().addToast({
        type: 'success',
        message: t('market.uninstall.success', { name: skillMeta.displayName || skillMeta.name }),
      })
      setConfirmUninstall(false)
      clearSelection()
      void fetchSkills(selectedSkillContext || undefined)
      // Keep the market list in sync when it has this skill loaded.
      const market = useMarketStore.getState()
      const detailCache = new Map(market.detailCache)
      detailCache.delete(marketMeta.id)
      useMarketStore.setState({
        detailCache,
        items: market.items.map((item) =>
          item.id === marketMeta.id
            ? { ...item, installState: 'installable', installedInfo: undefined, notInstallableReason: undefined }
            : item,
        ),
      })
    } catch (err) {
      useUIStore.getState().addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setUninstalling(false)
    }
  }

  const actions = marketMeta ? (
    <Button
      variant="danger-outline"
      size="lg"
      data-testid="local-skill-uninstall-button"
      loading={uninstalling}
      icon={<Trash2 className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />}
      onClick={() => setConfirmUninstall(true)}
    >
      {uninstalling ? t('market.uninstall.uninstalling') : t('market.uninstall.action')}
    </Button>
  ) : undefined

  return (
    <>
      {embedded && !marketMeta && (
        <p className="mb-4 text-sm leading-6 text-[var(--color-text-secondary)]">
          {t('extensions.managedSkillHint')}
        </p>
      )}
      <SkillDetailView
        name={skillMeta.displayName || skillMeta.name}
        version={skillMeta.version}
        sourceLabel={t(`settings.skills.source.${skillMeta.source}`)}
        summary={skillMeta.description}
        installState={marketMeta ? 'installed' : undefined}
        actions={actions}
        meta={meta}
        description={description}
        descriptionFrontmatter={descriptionFrontmatter}
        files={selectedSkill.files.map((f) => ({
          path: f.path,
          size: f.content.length,
          language: f.language,
        }))}
        loadFile={loadFile}
        onBack={handleBack}
        backLabel={t('settings.skills.back')}
      />

      <ConfirmDialog
        open={confirmUninstall}
        onClose={() => setConfirmUninstall(false)}
        onConfirm={() => void runUninstall()}
        title={t('market.uninstall.confirmTitle')}
        body={t('market.uninstall.confirmMessage', {
          name: skillMeta.displayName || skillMeta.name,
          path: selectedSkill.skillRoot,
        })}
        confirmLabel={t('market.uninstall.action')}
        cancelLabel={t('market.installConfirm.cancel')}
        confirmVariant="danger"
        loading={uninstalling}
      />
    </>
  )
}
