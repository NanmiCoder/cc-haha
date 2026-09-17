import { useId, useState, type KeyboardEvent } from 'react'
import { Edit3, Trash2, Layers, Plus, ShieldAlert, TerminalSquare, FolderOpen } from 'lucide-react'
import { useHostManagementStore } from '../../stores/hostManagementStore'
import { useTranslation } from '../../../../i18n'
import type { HostApplication, Host } from '../../types/resourceTypes'
import type { HostManagementErrorReference } from '../../api/hostManagementApi'
import { Modal } from '../../../../components/ui/Modal'
import { Button } from '../../../../components/ui/Button'
import { IconButton } from '../../../../components/ui/IconButton'
import { ConfirmDialog } from '../../../../components/ui/ConfirmDialog'
import { SshConsole } from './SshConsole'
import { RemoteFilesPanel } from './RemoteFilesPanel'
import { resourceErrorMessage } from './resourceErrorMessage'
import { ApplicationEditModal } from './ApplicationEditModal'
import { ApplicationFilesPanel } from './ApplicationFilesPanel'
import { JavaProcessesPanel } from './JavaProcessesPanel'
import { ProtectedPasswordReveal } from '../ProtectedPasswordReveal'

export type HostDetailProps = {
  onOpenTagModal?: () => void
  onOpenImportExport?: () => void
}

export function HostDetail(_props: HostDetailProps) {
  const t = useTranslation()
  const {
    selectedHost,
    tags,
    setEditingHostId,
    deleteHost,
    deleteApplication,
  } = useHostManagementStore()

  const host = selectedHost()
  const [isDeleting, setIsDeleting] = useState(false)
  const [showDeleteHostConfirm, setShowDeleteHostConfirm] = useState(false)
  const [appToDelete, setAppToDelete] = useState<HostApplication | null>(null)
  const [referencingErrors, setReferencingErrors] = useState<HostManagementErrorReference[] | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [editingApp, setEditingApp] = useState<{ isNew: boolean; app?: HostApplication } | null>(null)
  const [connectionView, setConnectionView] = useState<'terminal' | 'files' | 'applications' | 'java'>('terminal')
  const [filesVisited, setFilesVisited] = useState(false)
  const workspaceId = useId()
  const handleTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    const index = tabs.indexOf(event.target as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    tabs[next]?.focus()
    tabs[next]?.click()
  }

  if (!host) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center p-8 text-[var(--color-text-tertiary)]">
        <Layers size={40} strokeWidth={1.5} className="mb-3 opacity-60" />
        <p className="text-sm font-medium text-[var(--color-text-secondary)]">
          {t('managedResources.subtitle') || '选择一台主机以查看配置与应用详情'}
        </p>
        <p className="mt-1 text-xs">
          {t('managedResources.newHost') || '或者点击左侧“新建”按钮录入受管 Linux 主机'}
        </p>
      </div>
    )
  }

  const hostTags = tags.filter((t) => host.tagIds.includes(t.id))

  const handleDeleteHostConfirm = async () => {
    setIsDeleting(true)
    setDeleteError(null)
    const res = await deleteHost(host.id, host.revision)
    setIsDeleting(false)
    setShowDeleteHostConfirm(false)
    if (!res.success && res.error) {
      if (res.error.references && res.error.references.length > 0) {
        setReferencingErrors(res.error.references)
      } else if (res.error.code === 'REVISION_CONFLICT') {
        setDeleteError(t('managedResources.revisionConflict') || '资源已被修改（版本冲突），请刷新后重试。')
      } else {
        setDeleteError(resourceErrorMessage(t, res.error))
      }
    }
  }

  const handleDeleteAppConfirm = async () => {
    if (!appToDelete) return
    setIsDeleting(true)
    setDeleteError(null)
    const targetApp = appToDelete
    const res = await deleteApplication({
      hostId: host.id,
      expectedHostRevision: host.revision,
      applicationId: targetApp.id,
    })
    setIsDeleting(false)
    setAppToDelete(null)
    if (!res.success) {
      if (res.error?.code === 'REVISION_CONFLICT') {
        setDeleteError(t('managedResources.revisionConflict') || '资源已被修改（版本冲突），请刷新后重试。')
      } else {
        setDeleteError(resourceErrorMessage(t, res.error))
      }
    }
    // Application references and unused credentials were updated atomically by
    // the main process; never issue a second, revision-1 credential deletion.
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Top Header */}
      <div className="flex items-start justify-between border-b border-[var(--color-border)] pb-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-[var(--color-text-primary)]">{host.name}</h1>
            <span className="rounded-[var(--radius-sm)] bg-[var(--color-surface-container)] px-2 py-0.5 text-xs font-mono text-[var(--color-text-secondary)]">
              {host.username}@{host.address}:{host.port}
            </span>
          </div>
          {host.notes && (
            <p className="mt-1.5 text-xs text-[var(--color-text-secondary)]">{host.notes}</p>
          )}
          {hostTags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {hostTags.map((t) => (
                <span
                  key={t.id}
                  className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-container)] px-2 py-0.5 text-[11px] text-[var(--color-text-primary)]"
                >
                  {t.name}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setEditingHostId(host.id)}
            icon={<Edit3 size={14} />}
          >
            {t('managedResources.editHost') || '编辑'}
          </Button>
          <Button
            type="button"
            variant="danger-outline"
            size="sm"
            onClick={() => setShowDeleteHostConfirm(true)}
            disabled={isDeleting}
            icon={<Trash2 size={14} />}
          >
            {t('managedResources.deleteHost') || '删除'}
          </Button>
        </div>
      </div>

      {deleteError && (
        <div role="alert" className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-error)] bg-[var(--color-error-container)] p-3 text-xs text-[var(--color-on-error-container)]">
          <ShieldAlert size={16} />
          <span>{deleteError}</span>
        </div>
      )}

      {/* Connection & Auth Section */}
      <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)] mb-3">
          {t('managedResources.authMethod') || 'SSH 与凭据配置'}
        </h3>
        <div className="grid grid-cols-2 gap-4 text-xs">
          <div>
            <span className="text-[var(--color-text-tertiary)]">{t('managedResources.authMethod') || '认证方式'}: </span>
            <span className="font-medium text-[var(--color-text-primary)]">
              {host.auth.type === 'password'
                ? (t('managedResources.authPassword') || '密码认证 (Password)')
                : (t('managedResources.authKey') || '私钥认证 (Private Key)')}
            </span>
          </div>
          <div>
            <span className="text-[var(--color-text-tertiary)]">{t('managedResources.initialDir') || '初始工作目录'}: </span>
            <span className="font-mono text-[var(--color-text-primary)]">
              {host.initialDirectory || '/'}
            </span>
          </div>
        </div>

        {host.auth.type === 'password' && host.auth.credentialId && (
          <div className="mt-4">
            <ProtectedPasswordReveal
              credentialId={host.auth.credentialId}
              label={t('managedResources.passwordReveal.sshLabel' as never) || 'SSH login password'}
            />
          </div>
        )}

        <div className="mt-4 flex items-center gap-1 border-b border-[var(--color-border)]" role="tablist" onKeyDown={handleTabKey} aria-label={t('managedResources.title')}>
          <button
            type="button"
            role="tab"
            aria-selected={connectionView === 'terminal'}
            data-testid="host-terminal-tab"
            id={`${workspaceId}-terminal-tab`}
            aria-controls={`${workspaceId}-terminal-panel`}
            tabIndex={connectionView === 'terminal' ? 0 : -1}
            onClick={() => setConnectionView('terminal')}
            className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${connectionView === 'terminal' ? 'border-[var(--color-brand)] text-[var(--color-brand)]' : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}
          >
            <TerminalSquare size={14} />
            {t('managedResources.ssh.tabTerminal' as never) || 'Terminal'}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={connectionView === 'files'}
            data-testid="host-files-tab"
            id={`${workspaceId}-files-tab`}
            aria-controls={`${workspaceId}-files-panel`}
            tabIndex={connectionView === 'files' ? 0 : -1}
            onClick={() => { setFilesVisited(true); setConnectionView('files') }}
            className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${connectionView === 'files' ? 'border-[var(--color-brand)] text-[var(--color-brand)]' : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}
          >
            <FolderOpen size={14} />
            {t('managedResources.ssh.tabFiles' as never) || 'Remote files'}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={connectionView === 'applications'}
            data-testid="host-applications-tab"
            id={`${workspaceId}-applications-tab`}
            aria-controls={`${workspaceId}-applications-panel`}
            tabIndex={connectionView === 'applications' ? 0 : -1}
            onClick={() => setConnectionView('applications')}
            className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${connectionView === 'applications' ? 'border-[var(--color-brand)] text-[var(--color-brand)]' : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}
          >
            <Layers size={14} />
            {t('managedResources.applications') || 'Applications'} ({host.applications.length})
          </button>
          <button type="button" role="tab" aria-selected={connectionView === 'java'} data-testid="host-java-tab"
            id={`${workspaceId}-java-tab`} aria-controls={`${workspaceId}-java-panel`} tabIndex={connectionView === 'java' ? 0 : -1}
            onClick={() => setConnectionView('java')}
            className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${connectionView === 'java' ? 'border-[var(--color-brand)] text-[var(--color-brand)]' : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}>
            <Layers size={14} />{t('managedResources.hostTools.javaProcesses')}
          </button>
        </div>
        <div className="min-w-0 pt-3">
          {/* Keep the active host's terminal buffer and edit draft across tabs. */}
          <div role="tabpanel" id={`${workspaceId}-terminal-panel`} aria-labelledby={`${workspaceId}-terminal-tab`} hidden={connectionView !== 'terminal'}>
            <SshConsole key={host.id} host={host as Host} />
          </div>
          <div role="tabpanel" id={`${workspaceId}-files-panel`} aria-labelledby={`${workspaceId}-files-tab`} hidden={connectionView !== 'files'}>
            {filesVisited && <RemoteFilesPanel key={host.id} host={host as Host} />}
          </div>
          {connectionView === 'java' && <div role="tabpanel" id={`${workspaceId}-java-panel`} aria-labelledby={`${workspaceId}-java-tab`}>
            <JavaProcessesPanel key={host.id} host={host} onConnect={() => setConnectionView('terminal')} />
          </div>}
          {connectionView === 'applications' && (
            <div data-testid="host-applications-panel" role="tabpanel" id={`${workspaceId}-applications-panel`} aria-labelledby={`${workspaceId}-applications-tab`}>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                  {t('managedResources.applications') || '受管应用与服务'} ({host.applications.length})
                </h3>
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  onClick={() => setEditingApp({ isNew: true })}
                  icon={<Plus size={13} />}
                >
                  {t('managedResources.newApplication') || '添加应用'}
                </Button>
              </div>

              {host.applications.length === 0 ? (
                <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] p-4 text-center text-xs text-[var(--color-text-tertiary)]">
                  {t('managedResources.noApplications') || '暂无应用，点击上方“添加应用”录入 Web/DB/中间件配置'}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {host.applications.map((app) => (
                    <div
                      key={app.id}
                      className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <span className="text-xs font-semibold text-[var(--color-text-primary)]">{app.name}</span>
                          {app.version && (
                            <span className="ml-2 text-[11px] font-mono text-[var(--color-text-tertiary)]">
                              v{app.version}
                            </span>
                          )}
                          {app.accessDescription && (
                            <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">{app.accessDescription}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <IconButton
                            icon={<Edit3 size={13} />}
                            label={t('managedResources.editApp') || '编辑应用'}
                            size="xs"
                            onClick={() => setEditingApp({ isNew: false, app })}
                          />
                          <IconButton
                            icon={<Trash2 size={13} />}
                            label={t('managedResources.deleteApp') || '删除应用'}
                            size="xs"
                            tone="danger"
                            onClick={() => setAppToDelete(app)}
                          />
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-4 text-[11px]">
                        {app.accessUrls.length > 0 && (
                          <div>
                            <span className="text-[var(--color-text-tertiary)]">{t('managedResources.appAccessUrls') || '访问 URL'}: </span>
                            {app.accessUrls.map((u, i) => (
                              <span key={i} className="font-mono text-[var(--color-brand)] mr-2">{u}</span>
                            ))}
                          </div>
                        )}
                        {app.installPaths.length > 0 && (
                          <div>
                            <span className="text-[var(--color-text-tertiary)]">{t('managedResources.appInstallPaths') || '路径'}: </span>
                            {app.installPaths.map((p, i) => (
                              <span key={i} className="font-mono text-[var(--color-text-secondary)] mr-2">{p}</span>
                            ))}
                          </div>
                        )}
                      </div>

                      {app.accounts.length > 0 && (
                        <div className="mt-1 border-t border-[var(--color-border)] pt-1.5 text-[11px]">
                          <span className="text-[var(--color-text-tertiary)]">{t('managedResources.appAccounts') || '账号'}: </span>
                          <div className="mt-1.5 flex flex-col gap-1.5">
                            {app.accounts.map((acc) => (
                              <div key={acc.id} className="flex flex-wrap items-center gap-2">
                                <span className="mr-1 font-medium text-[var(--color-text-secondary)]">
                                  {acc.label} ({acc.username})
                                </span>
                                {acc.credentialId && (
                                  <ProtectedPasswordReveal
                                    credentialId={acc.credentialId}
                                    label={t('managedResources.passwordReveal.accountLabel' as never) || 'Application account password'}
                                    compact
                                  />
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <ApplicationFilesPanel key={`${host.id}:${app.id}`} host={host} application={app} onConnect={() => setConnectionView('terminal')} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {editingApp && (
        <ApplicationEditModal
          hostId={host.id}
          expectedHostRevision={host.revision}
          initialApplication={editingApp.app}
          onClose={() => setEditingApp(null)}
        />
      )}

      {/* Host Deletion Confirm Dialog */}
      <ConfirmDialog
        open={showDeleteHostConfirm}
        onClose={() => setShowDeleteHostConfirm(false)}
        onConfirm={handleDeleteHostConfirm}
        closeLabel={t('common.close')}
        title={t('managedResources.deleteHostConfirmTitle') || '删除主机'}
        body={
          t('managedResources.deleteHostConfirmBody', { name: host.name }) ||
          `确定要删除主机 "${host.name}" 吗？此操作无法撤销。`
        }
        confirmLabel={t('common.delete') || '删除'}
        cancelLabel={t('common.cancel') || '取消'}
        confirmVariant="danger"
        loading={isDeleting}
      />

      {/* Application Deletion Confirm Dialog */}
      <ConfirmDialog
        open={Boolean(appToDelete)}
        onClose={() => setAppToDelete(null)}
        onConfirm={handleDeleteAppConfirm}
        closeLabel={t('common.close')}
        title={t('managedResources.deleteApplicationConfirmTitle') || '删除应用'}
        body={
          t('managedResources.deleteApplicationConfirmBody', { name: appToDelete?.name || '' }) ||
          `确定要删除应用 "${appToDelete?.name}" 吗？此操作无法撤销。`
        }
        confirmLabel={t('common.delete') || '删除'}
        cancelLabel={t('common.cancel') || '取消'}
        confirmVariant="danger"
        loading={isDeleting}
      />

      {/* Referencing Entities Modal */}
      {referencingErrors && (
        <Modal
          open={Boolean(referencingErrors)}
          onClose={() => setReferencingErrors(null)}
          closeLabel={t('common.close')}
          title={t('managedResources.deleteBlockedTitle') || '无法删除主机'}
          width={480}
          footer={(
            <Button
              type="button"
              variant="secondary"
              onClick={() => setReferencingErrors(null)}
            >
              {t('common.close') || '关闭'}
            </Button>
          )}
        >
          <div className="flex flex-col gap-3 py-2">
            <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] p-3 text-xs text-[var(--color-on-warning-container)]">
              <ShieldAlert size={16} className="mt-0.5 shrink-0" />
              <span>
                {t('managedResources.deleteBlockedDesc') ||
                  '该主机正被以下受管资源引用，请先解除关联后再进行删除：'}
              </span>
            </div>

            <div className="flex flex-col gap-2 max-h-60 overflow-y-auto pr-1">
              {referencingErrors.map((ref) => (
                <div
                  key={ref.id}
                  className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container)] p-2.5 text-xs"
                >
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-brand)] border border-[var(--color-border)]">
                        {ref.type === 'data-connection' || ref.type === 'dataConnection'
                          ? (t('managedResources.typeDataConnection') || '数据连接')
                          : ref.type === 'concept'
                          ? (t('managedResources.typeConcept') || '概念知识')
                          : ref.type}
                      </span>
                      <span className="font-medium text-[var(--color-text-primary)]">
                        {ref.name || ref.id}
                      </span>
                    </div>
                    {ref.description && (
                      <span className="text-[11px] text-[var(--color-text-secondary)]">
                        {ref.description}
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-[10px] text-[var(--color-text-tertiary)]">
                    {ref.id.slice(0, 8)}...
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
