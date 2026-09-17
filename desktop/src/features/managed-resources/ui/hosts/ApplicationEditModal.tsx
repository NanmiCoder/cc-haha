import { useRef, useState } from 'react'
import { Plus, Trash2, ShieldCheck, AlertCircle, UserCheck, Edit3 } from 'lucide-react'
import { useHostManagementStore } from '../../stores/hostManagementStore'
import { useTranslation } from '../../../../i18n'
import { Modal } from '../../../../components/ui/Modal'
import { Input } from '../../../../components/ui/Input'
import { TextArea } from '../../../../components/ui/TextArea'
import { Button } from '../../../../components/ui/Button'
import { IconButton } from '../../../../components/ui/IconButton'
import { ConfirmDialog } from '../../../../components/ui/ConfirmDialog'
import type { AccountPasswordWrite } from '../../api/credentialMutationContract'
import { resourceErrorMessage } from './resourceErrorMessage'
import type { HostApplication, HostApplicationAccount } from '../../types/resourceTypes'
import { ProtectedPasswordReveal } from '../ProtectedPasswordReveal'

export type ApplicationEditModalProps = {
  hostId: string
  expectedHostRevision: number
  initialApplication?: HostApplication
  onClose: () => void
}

export function ApplicationEditModal({
  hostId,
  expectedHostRevision,
  initialApplication,
  onClose,
}: ApplicationEditModalProps) {
  const t = useTranslation()
  const { saveApplication, loading } = useHostManagementStore()
  const originalRevision = useRef(expectedHostRevision).current
  const submitting = useRef(false)

  const [name, setName] = useState(initialApplication?.name || '')
  const [version, setVersion] = useState(initialApplication?.version || '')
  const [loginUrl, setLoginUrl] = useState(initialApplication?.loginUrl || '')
  const [installPathsText, setInstallPathsText] = useState(initialApplication?.installPaths.join('\n') || '')
  const [accessUrlsText, setAccessUrlsText] = useState(initialApplication?.accessUrls.join('\n') || '')
  const [accessDescription, setAccessDescription] = useState(initialApplication?.accessDescription || '')
  const [notes, setNotes] = useState(initialApplication?.notes || '')
  const [accounts, setAccounts] = useState<(HostApplicationAccount & AccountPasswordWrite)[]>(
    () => structuredClone(initialApplication?.accounts || []),
  )
  const [formError, setFormError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Account form state
  const [isAddingAccount, setIsAddingAccount] = useState(false)
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null)
  const [newAccountLabel, setNewAccountLabel] = useState('')
  const [newAccountUsername, setNewAccountUsername] = useState('')
  const [newAccountPassword, setNewAccountPassword] = useState('')
  const [accountError, setAccountError] = useState<string | null>(null)

  // Account deletion confirm state
  const [accountToDelete, setAccountToDelete] = useState<HostApplicationAccount | null>(null)
  const [isDeletingAccount, setIsDeletingAccount] = useState(false)

  const handleStartEditAccount = (account: HostApplicationAccount) => {
    setEditingAccountId(account.id)
    setNewAccountLabel(account.label)
    setNewAccountUsername(account.username)
    setNewAccountPassword('')
    setAccountError(null)
    setIsAddingAccount(true)
  }

  const handleSaveAccount = async () => {
    setAccountError(null)
    if (!newAccountLabel.trim() || !newAccountUsername.trim()) {
      setAccountError(t('managedResources.enterAccountDetails') || '请填写账号说明标签和用户名')
      return
    }

    // Keep unsaved passwords only in this form's ephemeral draft. The main
    // process commits the application and encrypted records in one transaction.
    const existingAccount = editingAccountId ? accounts.find((a) => a.id === editingAccountId) : null
    const account: HostApplicationAccount & AccountPasswordWrite = {
      ...existingAccount,
      id: existingAccount?.id ?? crypto.randomUUID(),
      label: newAccountLabel.trim(),
      username: newAccountUsername.trim(),
      credentialId: existingAccount?.credentialId ?? null,
      ...(newAccountPassword ? { password: newAccountPassword } : {}),
    }
    setAccounts(prev => existingAccount
      ? prev.map(item => item.id === account.id ? account : item)
      : [...prev, account])

    setEditingAccountId(null)
    setNewAccountLabel('')
    setNewAccountUsername('')
    setNewAccountPassword('')
    setIsAddingAccount(false)
  }

  const handleConfirmDeleteAccount = () => {
    if (!accountToDelete) return
    setIsDeletingAccount(true)
    // Removing a draft account does not mutate the vault. Unreferenced saved
    // credentials are removed atomically when the application is saved.
    setAccounts((prev) => prev.filter((a) => a.id !== accountToDelete.id))
    setIsDeletingAccount(false)
    setAccountToDelete(null)
  }

  const handleCancelModal = () => {
    if (submitting.current || accountToDelete) return
    setAccounts([])
    setNewAccountPassword('')
    onClose()
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting.current) return
    if (isAddingAccount) {
      await handleSaveAccount()
      return
    }
    setFormError(null)

    if (!name.trim()) {
      setFormError(t('managedResources.m2.applicationNameRequired'))
      return
    }

    const installPaths = installPathsText.split('\n').map((s) => s.trim()).filter(Boolean)
    const accessUrls = accessUrlsText.split('\n').map((s) => s.trim()).filter(Boolean)

    // Validate access URLs have no credentials
    for (const url of accessUrls) {
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          setFormError(t('managedResources.m2.invalidUrl'))
          return
        }
        if (parsed.username || parsed.password) {
          setFormError(t('managedResources.m2.invalidUrl'))
          return
        }
      } catch {
        setFormError(t('managedResources.m2.invalidUrl'))
        return
      }
    }

    // Validate loginUrl
    if (loginUrl.trim()) {
      try {
        const parsed = new URL(loginUrl.trim())
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          setFormError(t('managedResources.m2.invalidUrl'))
          return
        }
        if (parsed.username || parsed.password) {
          setFormError(t('managedResources.m2.invalidUrl'))
          return
        }
      } catch {
        setFormError(t('managedResources.m2.invalidUrl'))
        return
      }
    }

    setIsSubmitting(true)
    const appPayload = {
      name: name.trim(),
      version: version.trim() || null,
      installPaths,
      accessDescription: accessDescription.trim(),
      accessUrls,
      loginUrl: loginUrl.trim() || null,
      accounts: accounts.map((a) => ({
        id: a.id,
        label: a.label,
        username: a.username,
        credentialId: a.credentialId,
        ...(a.password === undefined ? {} : { password: a.password }),
      })),
      notes: notes.trim(),
    }

    submitting.current = true
    try {
      const saveRes = await saveApplication({
        hostId,
        expectedHostRevision: originalRevision,
        application: initialApplication ? { ...appPayload, id: initialApplication.id } : appPayload,
      })
      if (!saveRes.success) {
        setFormError(resourceErrorMessage(t, saveRes.error))
        return
      }
      setAccounts([])
      setNewAccountPassword('')
      onClose()
    } catch {
      setFormError(resourceErrorMessage(t))
    } finally {
      submitting.current = false
      setIsSubmitting(false)
    }
  }

  return (
    <>
      <Modal
        open={true}
        onClose={handleCancelModal}
        closeLabel={t('common.close')}
        title={initialApplication ? (t('managedResources.editApp') || '编辑受管应用') : (t('managedResources.newApplication') || '添加受管应用')}
        width={600}
      >
        <form onSubmit={handleSubmit} aria-busy={isSubmitting} aria-describedby={formError ? 'app-form-error' : undefined}>
          <fieldset disabled={isSubmitting} className="flex min-w-0 flex-col gap-4 text-xs">
          {formError && (
            <div id="app-form-error" role="alert" className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-error)] bg-[var(--color-error-container)] p-3 text-[var(--color-on-error-container)]">
              <AlertCircle size={16} className="shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          {/* Name & Version */}
          <div className="flex gap-3">
            <div className="flex-1">
              <Input
                id="app-name-input"
                label={t('managedResources.m2.applicationName')}
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('managedResources.m2.applicationPlaceholder')}
                size="sm"
              />
            </div>
            <div className="w-32">
              <Input
                id="app-version-input"
                label={t('managedResources.m2.version')}
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder={t('managedResources.m2.versionPlaceholder')}
                size="sm"
                className="font-mono"
              />
            </div>
          </div>

          {/* Login URL */}
          <div>
            <Input
              id="app-login-url-input"
              label={t('managedResources.m2.loginUrl')}
              value={loginUrl}
              onChange={(e) => setLoginUrl(e.target.value)}
              placeholder="http://192.168.1.10:8080/login"
              size="sm"
              className="font-mono"
            />
          </div>

          {/* Access URLs */}
          <div>
            <TextArea
              id="app-access-urls-input"
              label={t('managedResources.m2.accessUrls')}
              rows={2}
              value={accessUrlsText}
              onChange={(e) => setAccessUrlsText(e.target.value)}
              placeholder="http://192.168.1.10:8080"
              className="font-mono text-xs"
            />
          </div>

          {/* Install Paths */}
          <div>
            <TextArea
              id="app-install-paths-input"
              label={t('managedResources.m2.installPaths')}
              rows={2}
              value={installPathsText}
              onChange={(e) => setInstallPathsText(e.target.value)}
              placeholder="/etc/nginx/nginx.conf"
              className="font-mono text-xs"
            />
          </div>

          {/* Access Description */}
          <div>
            <Input
              id="app-desc-input"
              label={t('managedResources.m2.accessDescription')}
              value={accessDescription}
              onChange={(e) => setAccessDescription(e.target.value)}
              placeholder={t('managedResources.m2.applicationDescriptionPlaceholder')}
              size="sm"
            />
          </div>

          {/* Application Accounts Management */}
          <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="font-medium text-[var(--color-text-secondary)]">
                {t('managedResources.m2.accounts', { count: accounts.length })}
              </span>
              {!isAddingAccount && (
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  onClick={() => setIsAddingAccount(true)}
                  className="flex items-center gap-1"
                >
                  <Plus size={13} />
                  <span>{t('managedResources.m2.addAccount')}</span>
                </Button>
              )}
            </div>

            {accountError && (
              <div role="alert" className="mb-2 rounded-[var(--radius-sm)] border border-[var(--color-error)] bg-[var(--color-error-container)] p-2 text-[var(--color-on-error-container)]">
                {accountError}
              </div>
            )}

            {/* Form for adding an account */}
            {isAddingAccount && (
              <div className="mb-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 flex flex-col gap-2.5">
                <span className="font-semibold text-[var(--color-text-primary)]">{t('managedResources.m2.accountEditor')}</span>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    id="new-account-label"
                    label={t('managedResources.m2.accountLabel')}
                    value={newAccountLabel}
                    onChange={(e) => setNewAccountLabel(e.target.value)}
                    placeholder={t('managedResources.m2.accountLabelPlaceholder')}
                    size="sm"
                  />
                  <Input
                    id="new-account-username"
                    label={t('managedResources.m2.accountUsername')}
                    value={newAccountUsername}
                    onChange={(e) => setNewAccountUsername(e.target.value)}
                    placeholder={t('managedResources.m2.accountUsernamePlaceholder')}
                    size="sm"
                    className="font-mono"
                  />
                </div>
                <Input
                  id="new-account-password"
                  label={t('managedResources.m2.accountPassword')}
                  type="password"
                  value={newAccountPassword}
                  onChange={(e) => setNewAccountPassword(e.target.value)}
                  placeholder={t('managedResources.m2.accountPasswordPlaceholder')}
                  size="sm"
                  className="font-mono"
                />
                <div className="flex justify-end gap-2 pt-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      setIsAddingAccount(false)
                      setAccountError(null)
                      setEditingAccountId(null)
                      setNewAccountLabel('')
                      setNewAccountUsername('')
                      setNewAccountPassword('')
                    }}
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    size="xs"
                    onClick={handleSaveAccount}
                  >
                    {editingAccountId
                      ? (t('common.save') || '保存')
                      : (t('common.add') || '添加')}
                  </Button>
                </div>
              </div>
            )}

            {/* List of accounts */}
            {accounts.length === 0 && !isAddingAccount ? (
              <p className="text-[11px] text-[var(--color-text-tertiary)] italic py-1">
                {t('managedResources.noAccountsPlaceholder') || '暂无账号记录，点击上方“添加账号”可为应用配置后台登录账号与保险库密码。'}
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {accounts.map((account) => (
                  <div
                    key={account.id}
                    className="flex items-center justify-between rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5"
                  >
                    <div className="flex items-center gap-2">
                      <UserCheck size={14} className="text-[var(--color-text-secondary)]" />
                      <span className="font-medium text-[var(--color-text-primary)]">{account.label}</span>
                      <span className="font-mono text-[var(--color-text-tertiary)]">({account.username})</span>
                      {(account.password || account.credentialId) && (
                        <span className="flex items-center gap-1 text-[10px] text-[var(--color-brand)] bg-[var(--color-surface-container)] rounded px-1.5 py-0.2">
                          <ShieldCheck size={11} />
                          <span>{account.password ? t('managedResources.m2.pendingPassword') : t('managedResources.encrypted')}</span>
                        </span>
                      )}
                      {account.credentialId && !account.password && (
                        <ProtectedPasswordReveal
                          credentialId={account.credentialId}
                          label={t('managedResources.passwordReveal.accountLabel' as never) || 'Application account password'}
                          compact
                        />
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <IconButton
                        icon={<Edit3 size={13} />}
                        label={t('managedResources.editAccount') || `编辑账号 ${account.label}`}
                        size="sm"
                        onClick={() => handleStartEditAccount(account)}
                      />
                      <IconButton
                        icon={<Trash2 size={13} />}
                        label={t('managedResources.deleteAccount') || `删除账号 ${account.label}`}
                        size="sm"
                        tone="danger"
                        onClick={() => setAccountToDelete(account)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Notes */}
          <div>
            <TextArea
              id="app-notes-input"
              label={t('managedResources.notes') || '应用备注'}
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('managedResources.notesPlaceholder') || '应用配置说明、端口映射或维护注意事项...'}
              className="text-xs"
            />
          </div>

          {/* Buttons */}
          <div className="flex justify-end gap-2 pt-3 border-t border-[var(--color-border)]">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleCancelModal}
            >
              {t('common.cancel') || '取消'}
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={loading || isSubmitting || isAddingAccount}
            >
              {t('common.save') || '保存应用'}
            </Button>
          </div>
          </fieldset>
        </form>
      </Modal>

      {/* Account deletion confirm dialog */}
      {accountToDelete && (
        <ConfirmDialog
          open={true}
          onClose={() => setAccountToDelete(null)}
          onConfirm={handleConfirmDeleteAccount}
          closeLabel={t('common.close')}
          title={t('managedResources.deleteAccountConfirmTitle') || '删除应用账号'}
          body={
            <div className="text-xs text-[var(--color-text-secondary)]">
              <p>
                {t('managedResources.deleteAccountConfirmBody', { label: accountToDelete.label })}
              </p>
              {accountToDelete.credentialId && (
                <p className="mt-2 text-[var(--color-brand)]">
                  {t('managedResources.m2.credentialRemovalNote')}
                </p>
              )}
            </div>
          }
          confirmLabel={t('common.delete') || '确认删除'}
          cancelLabel={t('common.cancel') || '取消'}
          confirmVariant="danger"
          loading={isDeletingAccount}
        />
      )}
    </>
  )
}
