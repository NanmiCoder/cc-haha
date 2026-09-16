import { useState } from 'react'
import { Plus, Tag as TagIcon, ArrowDownUp, RefreshCw, ChevronDown, ChevronRight, Server, Layers } from 'lucide-react'
import { useHostManagementStore } from '../../stores/hostManagementStore'
import { useTranslation } from '../../../../i18n'
import { SearchField } from '../../../../components/ui/SearchField'
import { IconButton } from '../../../../components/ui/IconButton'
import { Button } from '../../../../components/ui/Button'
import type { Host } from '../../types/resourceTypes'

export type HostListProps = {
  onOpenTagModal?: () => void
  onOpenImportExport?: () => void
}

export function HostList({ onOpenTagModal, onOpenImportExport }: HostListProps) {
  const t = useTranslation()
  const {
    hosts: allHosts,
    tags,
    selectedHostId,
    searchQuery,
    selectedTagId,
    loading,
    setSearchQuery,
    setSelectedTagId,
    setSelectedHostId,
    setIsCreatingHost,
    fetchHosts,
    filteredHosts,
  } = useHostManagementStore()

  const hosts = filteredHosts()
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((prev) => ({
      ...prev,
      [groupId]: !prev[groupId],
    }))
  }

  const renderHostCard = (host: Host) => {
    const isSelected = selectedHostId === host.id
    const hostTags = tags.filter((tg) => host.tagIds.includes(tg.id))

    return (
      <div
        key={host.id}
        role="button"
        tabIndex={0}
        aria-pressed={isSelected}
        onClick={() => setSelectedHostId(host.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setSelectedHostId(host.id)
          }
        }}
        className={`flex cursor-pointer flex-col gap-1 rounded-[var(--radius-md)] border p-2.5 transition-[background-color,border-color] outline-none focus-visible:border-[var(--color-border-focus)] focus-visible:shadow-[var(--shadow-focus-ring)] ${
          isSelected
            ? 'border-[var(--color-brand)] bg-[var(--color-surface-selected)]'
            : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]'
        }`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 truncate">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-text-tertiary)]" />
            <span className="truncate text-xs font-semibold text-[var(--color-text-primary)]">
              {host.name}
            </span>
          </div>
          <span className="text-[11px] font-mono text-[var(--color-text-tertiary)]">
            :{host.port}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] font-mono text-[var(--color-text-secondary)]">
          <span className="truncate">{host.username}@{host.address}</span>
        </div>
        {hostTags.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {hostTags.map((tg) => (
              <span
                key={tg.id}
                className="rounded-[var(--radius-sm)] bg-[var(--color-surface-container)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]"
              >
                {tg.name}
              </span>
            ))}
          </div>
        )}
      </div>
    )
  }

  // Group hosts by tag
  const taggedGroups = tags.map((tag) => {
    const matchingHosts = hosts.filter((h) => h.tagIds.includes(tag.id))
    return {
      tag,
      hosts: matchingHosts,
    }
  })

  // Untagged hosts
  const untaggedHosts = hosts.filter((h) => h.tagIds.length === 0)

  return (
    <div className="flex h-full flex-col select-none">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <Server size={18} className="text-[var(--color-brand)]" />
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            {t('managedResources.title') || '主机管理'}
          </h2>
        </div>
        <div className="flex items-center gap-1">
          <IconButton
            icon={<TagIcon size={14} />}
            label={t('managedResources.manageTags') || '管理标签'}
            size="sm"
            onClick={onOpenTagModal}
          />
          <IconButton
            icon={<ArrowDownUp size={14} />}
            label={t('managedResources.importExport') || '导入/导出'}
            size="sm"
            onClick={onOpenImportExport}
          />
          <IconButton
            icon={<RefreshCw size={14} className={loading ? 'animate-spin' : ''} />}
            label={t('managedResources.refresh') || '刷新'}
            size="sm"
            onClick={() => fetchHosts()}
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => setIsCreatingHost(true)}
            className="flex items-center gap-1"
          >
            <Plus size={14} />
            <span>{t('common.add') || '新建'}</span>
          </Button>
        </div>
      </div>

      {/* Search & Tag Filter */}
      <div className="flex flex-col gap-2 border-b border-[var(--color-border)] p-3">
        <SearchField
          value={searchQuery}
          onChange={setSearchQuery}
          label={t('managedResources.subtitle') || '搜索主机名、IP、标签、备注...'}
          clearLabel={t('managedResources.m2.clearSearch')}
          size="sm"
        />

        {/* Tag pills */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            <button
              type="button"
              onClick={() => setSelectedTagId(null)}
              aria-pressed={selectedTagId === null}
              className={`rounded-[var(--radius-sm)] px-2 py-0.5 text-[11px] font-medium transition-colors ${
                selectedTagId === null
                  ? 'bg-[var(--color-brand)] text-[var(--color-on-primary)]'
                  : 'bg-[var(--color-surface-container)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
              }`}
            >
              {t('managedResources.allTagFilter', { count: allHosts.length }) || `全部 (${allHosts.length})`}
            </button>
            {tags.map((tag) => {
              const count = allHosts.filter((h) => h.tagIds.includes(tag.id)).length
              return (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => setSelectedTagId(selectedTagId === tag.id ? null : tag.id)}
                  aria-pressed={selectedTagId === tag.id}
                  className={`rounded-[var(--radius-sm)] px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    selectedTagId === tag.id
                      ? 'bg-[var(--color-brand)] text-[var(--color-on-primary)]'
                      : 'bg-[var(--color-surface-container)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                  }`}
                >
                  {tag.name} ({count})
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Grouped Tree & List */}
      <div className="flex-1 overflow-y-auto p-2">
        {hosts.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center text-center text-xs text-[var(--color-text-tertiary)]">
            <Layers size={24} className="mb-2 opacity-50" />
            <p>{t('managedResources.noHostsFound') || '未找到匹配的主机'}</p>
          </div>
        ) : selectedTagId !== null ? (
          // Flat list when single tag is filtered
          <div className="flex flex-col gap-1.5">
            {hosts.map(renderHostCard)}
          </div>
        ) : (
          // Full Tree / Grouped View
          <div className="flex flex-col gap-3">
            {/* Top overview bar: 全部主机 */}
            <div className="flex items-center justify-between px-2 py-1 text-xs font-semibold text-[var(--color-text-secondary)]">
              <span className="flex items-center gap-1.5">
                <Server size={13} />
                <span>{t('managedResources.allHosts') || '全部主机'}</span>
              </span>
              <span className="rounded-full bg-[var(--color-surface-container)] px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-tertiary)]">
                {t('managedResources.hostCountSummary', { count: hosts.length }) || `共 ${hosts.length} 台`}
              </span>
            </div>

            {/* Tag Groups */}
            {taggedGroups.map(({ tag, hosts: groupHosts }) => {
              if (groupHosts.length === 0 && searchQuery) return null
              const isCollapsed = !!collapsedGroups[tag.id]

              return (
                <div key={tag.id} className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => toggleGroup(tag.id)}
                    aria-expanded={!isCollapsed}
                    className="flex items-center justify-between rounded px-2 py-1 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
                  >
                    <div className="flex items-center gap-1.5">
                      {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                      <TagIcon size={12} className="text-[var(--color-brand)]" />
                      <span>{tag.name}</span>
                    </div>
                    <span className="rounded-full bg-[var(--color-surface-container)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--color-text-tertiary)]">
                      {groupHosts.length}
                    </span>
                  </button>

                  {!isCollapsed && groupHosts.length > 0 && (
                    <div className="flex flex-col gap-1.5 pl-4">
                      {groupHosts.map(renderHostCard)}
                    </div>
                  )}
                  {!isCollapsed && groupHosts.length === 0 && (
                    <div className="pl-6 text-[11px] text-[var(--color-text-tertiary)] italic">
                      {t('managedResources.noHostsInTag') || '该标签下暂无匹配主机'}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Untagged Hosts Group */}
            {untaggedHosts.length > 0 && (
              <div className="flex flex-col gap-1 border-t border-[var(--color-border)] pt-2">
                <button
                  type="button"
                  onClick={() => toggleGroup('__untagged__')}
                  aria-expanded={!collapsedGroups['__untagged__']}
                  className="flex items-center justify-between rounded px-2 py-1 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
                >
                  <div className="flex items-center gap-1.5">
                    {collapsedGroups['__untagged__'] ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    <span>{t('managedResources.untaggedHosts') || '未分组主机'}</span>
                  </div>
                  <span className="rounded-full bg-[var(--color-surface-container)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--color-text-tertiary)]">
                    {untaggedHosts.length}
                  </span>
                </button>

                {!collapsedGroups['__untagged__'] && (
                  <div className="flex flex-col gap-1.5 pl-4">
                    {untaggedHosts.map(renderHostCard)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
