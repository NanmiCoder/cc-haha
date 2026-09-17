import { useState } from 'react'
import { Plus, Edit2, Trash2, Tag as TagIcon, ShieldAlert } from 'lucide-react'
import { useHostManagementStore } from '../../stores/hostManagementStore'
import { useTranslation } from '../../../../i18n'
import type { ResourceTag } from '../../types/resourceTypes'
import { Modal } from '../../../../components/ui/Modal'
import { Input } from '../../../../components/ui/Input'
import { Button } from '../../../../components/ui/Button'
import { IconButton } from '../../../../components/ui/IconButton'
import { ConfirmDialog } from '../../../../components/ui/ConfirmDialog'
import { resourceErrorMessage } from './resourceErrorMessage'

export type TagManagementModalProps = {
  onClose: () => void
}

export function TagManagementModal({ onClose }: TagManagementModalProps) {
  const t = useTranslation()
  const { tags, saveTag, deleteTag } = useHostManagementStore()

  const [newTagName, setNewTagName] = useState('')
  const [editingTag, setEditingTag] = useState<ResourceTag | null>(null)
  const [editName, setEditName] = useState('')
  const [tagToDelete, setTagToDelete] = useState<ResourceTag | null>(null)
  const [isDeletingTag, setIsDeletingTag] = useState(false)
  const [modalError, setModalError] = useState<string | null>(null)

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setModalError(null)
    if (!newTagName.trim()) return

    const res = await saveTag({
      namespace: 'host',
      name: newTagName.trim(),
      colorToken: null,
    })

    if (res.success) {
      setNewTagName('')
    } else {
      setModalError(resourceErrorMessage(t, res.error))
    }
  }

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editingTag || !editName.trim()) return
    setModalError(null)

    const res = await saveTag({
      id: editingTag.id,
      expectedRevision: editingTag.revision,
      name: editName.trim(),
      colorToken: editingTag.colorToken,
    })

    if (res.success) {
      setEditingTag(null)
      setEditName('')
    } else {
      setModalError(resourceErrorMessage(t, res.error))
    }
  }

  const handleDeleteConfirm = async () => {
    if (!tagToDelete) return
    setIsDeletingTag(true)
    const res = await deleteTag(tagToDelete.id, tagToDelete.revision)
    setIsDeletingTag(false)
    setTagToDelete(null)
    if (!res.success && res.error) {
      if (res.error.code === 'REVISION_CONFLICT') {
        setModalError(t('managedResources.revisionConflict') || '资源已被修改（版本冲突），请刷新后重试。')
      } else {
        setModalError(resourceErrorMessage(t, res.error))
      }
    }
  }

  return (
    <>
      <Modal
        open
        onClose={() => { if (!tagToDelete && !isDeletingTag) onClose() }}
        closeLabel={t('common.close')}
        title={t('managedResources.manageTags') || '标签管理 (Host Tags)'}
        width={480}
        footer={(
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.close') || '关闭'}
          </Button>
        )}
      >
        <div className="flex flex-col gap-4">
          {modalError && (
            <div role="alert" id="tag-form-error" className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-error)] bg-[var(--color-error-container)] p-3 text-xs text-[var(--color-on-error-container)]">
              <ShieldAlert size={16} className="shrink-0" />
              <span>{modalError}</span>
            </div>
          )}

          {/* Create Form */}
          <form onSubmit={handleCreate} className="flex items-end gap-2">
            <div className="flex-1">
              <Input
                size="md"
                label={t('managedResources.m2.newTagLabel')}
                placeholder={t('managedResources.m2.tagNamePlaceholder')}
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              disabled={!newTagName.trim()}
              className="h-8 mb-[1px]"
            >
              <Plus size={14} className="mr-1" />
              <span>{t('common.add')}</span>
            </Button>
          </form>

          {/* Tag List */}
          <div className="flex flex-col gap-2 max-h-[50vh] overflow-y-auto">
            {tags.length === 0 ? (
              <div className="py-8 text-center text-xs text-[var(--color-text-tertiary)]">
                {t('managedResources.m2.noTags')}
              </div>
            ) : (
              tags.map((tag) => {
                const isEditing = editingTag?.id === tag.id
                return (
                  <div
                    key={tag.id}
                    className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container)] p-2.5 text-xs"
                  >
                    {isEditing ? (
                      <form onSubmit={handleUpdate} className="flex flex-1 items-center gap-2">
                        <Input
                          label={t('managedResources.editTag')}
                          type="text"
                          autoFocus
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="flex-1 rounded border border-[var(--color-border-focus)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-primary)] focus:outline-none"
                        />
                        <Button type="submit" variant="primary" className="h-7 text-xs px-2">
                          {t('common.save')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => setEditingTag(null)}
                          className="h-7 text-xs px-2"
                        >
                          {t('common.cancel')}
                        </Button>
                      </form>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <TagIcon size={14} className="text-[var(--color-brand)]" />
                          <span className="font-medium text-[var(--color-text-primary)]">
                            {tag.name}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <IconButton
                            icon={<Edit2 size={13} />}
                            label={t('managedResources.editTag') || '编辑标签'}
                            size="xs"
                            onClick={() => {
                              setEditingTag(tag)
                              setEditName(tag.name)
                            }}
                          />
                          <IconButton
                            icon={<Trash2 size={13} />}
                            label={t('managedResources.deleteTag') || '删除标签'}
                            size="xs"
                            tone="danger"
                            onClick={() => setTagToDelete(tag)}
                          />
                        </div>
                      </>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
      </Modal>

      {/* Delete Tag Confirm Dialog */}
      <ConfirmDialog
        open={Boolean(tagToDelete)}
        onClose={() => setTagToDelete(null)}
        onConfirm={handleDeleteConfirm}
        closeLabel={t('common.close')}
        title={t('managedResources.deleteTagConfirmTitle') || '删除标签'}
        body={
          t('managedResources.deleteTagConfirmBody', { name: tagToDelete?.name || '' }) ||
          `确定要删除标签 "${tagToDelete?.name}" 吗？这将从关联的主机中移除此标签。`
        }
        confirmLabel={t('common.delete') || '删除'}
        cancelLabel={t('common.cancel') || '取消'}
        confirmVariant="danger"
        loading={isDeletingTag}
      />
    </>
  )
}
