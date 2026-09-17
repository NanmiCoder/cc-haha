import { useRef, useState } from 'react'
import { AlertCircle, Eye, EyeOff, KeyRound } from 'lucide-react'
import { useHostManagementStore } from '../../stores/hostManagementStore'
import { useTranslation } from '../../../../i18n'
import { Modal } from '../../../../components/ui/Modal'
import { Input } from '../../../../components/ui/Input'
import { TextArea } from '../../../../components/ui/TextArea'
import { Button } from '../../../../components/ui/Button'
import type { HostCredentialWrite } from '../../api/credentialMutationContract'
import { resourceErrorMessage } from './resourceErrorMessage'
import type { HostAuthType } from '../../types/resourceTypes'

export type HostEditModalProps = {
  hostId: string | null
  onClose: () => void
}

export function HostEditModal({ hostId, onClose }: HostEditModalProps) {
  const t = useTranslation()
  const { hosts, tags, saveHost, saveTag, loading } = useHostManagementStore()
  // Keep the revision the user actually opened; a background refresh must not
  // silently authorize overwriting somebody else's newer changes.
  const [existingHost] = useState(() => hostId ? hosts.find((h) => h.id === hostId) ?? null : null)
  const submitting = useRef(false)

  const [name, setName] = useState(existingHost?.name || '')
  const [address, setAddress] = useState(existingHost?.address || '')
  const [port, setPort] = useState<number>(existingHost?.port ?? 22)
  const [username, setUsername] = useState(existingHost?.username || 'root')
  const [authType, setAuthType] = useState<HostAuthType>(existingHost?.auth.type || 'password')
  const [password, setPassword] = useState('')
  const [privateKeyPem, setPrivateKeyPem] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [storageMode, setStorageMode] = useState<'vault' | 'temporary'>('vault')
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(existingHost?.tagIds || [])
  const [initialDirectory, setInitialDirectory] = useState(existingHost?.initialDirectory || '')
  const [notes, setNotes] = useState(existingHost?.notes || '')
  const [replaceCredential, setReplaceCredential] = useState(!existingHost?.auth.credentialId)
  const [newTagName, setNewTagName] = useState('')
  const [isCreatingTag, setIsCreatingTag] = useState(false)
  const creatingTag = useRef(false)

  const [formError, setFormError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const isAuthTypeChanged = existingHost ? authType !== existingHost.auth.type : false

  const toggleTag = (tagId: string) => {
    if (selectedTagIds.includes(tagId)) {
      setSelectedTagIds(selectedTagIds.filter((id) => id !== tagId))
    } else {
      setSelectedTagIds([...selectedTagIds, tagId])
    }
  }

  const handleCreateInlineTag = async () => {
    if (!newTagName.trim() || creatingTag.current || submitting.current) return
    creatingTag.current = true
    setIsCreatingTag(true)
    const res = await saveTag({
      namespace: 'host',
      name: newTagName.trim(),
      colorToken: null,
    })
    setIsCreatingTag(false)
    creatingTag.current = false
    if (res.success && res.tag) {
      setSelectedTagIds((prev) => [...prev, res.tag.id])
      setNewTagName('')
    } else if (!res.success) {
      setFormError(resourceErrorMessage(t, res.error))
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (creatingTag.current) return
    setFormError(null)

    if (!name.trim() || !address.trim() || !username.trim()) {
      setFormError(t('managedResources.requiredFieldsError') || '请填写所有必填字段（主机名、IP/域名、SSH 用户名）')
      return
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setFormError(t('managedResources.portRangeError') || '端口范围必须在 1 到 65535 之间')
      return
    }

    if (initialDirectory.trim() && !initialDirectory.trim().startsWith('/')) {
      setFormError(t('managedResources.initialDirError') || '初始工作目录必须以 "/" 开头的绝对路径')
      return
    }

    const needsNewCredential = isAuthTypeChanged || replaceCredential || !existingHost

    if (needsNewCredential) {
      if (authType === 'password' && !password) {
        setFormError(t('managedResources.enterPasswordError') || '请输入 SSH 登录密码')
        return
      }
      if (authType === 'privateKey' && !privateKeyPem.trim()) {
        setFormError(t('managedResources.enterKeyError') || '请输入 SSH 私钥 PEM 内容')
        return
      }
    }

    if (submitting.current) return
    submitting.current = true
    setIsSubmitting(true)
    try {
      const credential: HostCredentialWrite | undefined = needsNewCredential ? {
        storage: storageMode,
        secret: authType === 'password'
          ? { kind: 'ssh-password', password }
          : { kind: 'ssh-private-key', privateKeyPem: privateKeyPem.trim(), ...(passphrase ? { passphrase } : {}) },
      } : undefined
      const metadata = {
        name: name.trim(), address: address.trim(), port, username: username.trim(),
        auth: { type: authType, credentialId: needsNewCredential ? null : existingHost?.auth.credentialId ?? null },
        tagIds: selectedTagIds, initialDirectory: initialDirectory.trim() || null, notes: notes.trim(),
      }
      const result = await saveHost(existingHost
        ? { id: existingHost.id, expectedRevision: existingHost.revision, changes: metadata, credential }
        : { ...metadata, applications: [], credential })
      if (!result.success) {
        setFormError(resourceErrorMessage(t, result.error))
        return
      }
      setPassword('')
      setPrivateKeyPem('')
      setPassphrase('')
      onClose()
    } catch {
      setFormError(resourceErrorMessage(t))
    } finally {
      submitting.current = false
      setIsSubmitting(false)
    }
  }

  const handleClose = () => {
    if (submitting.current || creatingTag.current) return
    setPassword('')
    setPrivateKeyPem('')
    setPassphrase('')
    onClose()
  }

  return (
    <Modal
      open={true}
      onClose={handleClose}
      closeLabel={t('common.close')}
      title={existingHost ? (t('managedResources.editHost') || '编辑主机') : (t('managedResources.newHost') || '添加 Linux 主机')}
      width={600}
    >
      <form onSubmit={handleSubmit} aria-busy={isSubmitting} aria-describedby={formError ? 'host-form-error' : undefined}>
        <fieldset disabled={isSubmitting} className="flex min-w-0 flex-col gap-4 text-xs">
        {formError && (
          <div id="host-form-error" role="alert" className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-error)] bg-[var(--color-error-container)] p-3 text-[var(--color-on-error-container)]">
            <AlertCircle size={16} className="shrink-0" />
            <span>{formError}</span>
          </div>
        )}

        {/* Name & Port */}
        <div className="flex gap-3">
          <div className="flex-1">
            <Input
              id="host-name-input"
              label={t('managedResources.hostName') || '主机显示名称'}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('managedResources.m2.hostNamePlaceholder')}
              size="sm"
            />
          </div>
          <div className="w-24">
            <Input
              id="host-port-input"
              label={t('managedResources.port') || '端口'}
              required
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              size="sm"
              className="font-mono"
            />
          </div>
        </div>

        {/* Address & Username */}
        <div className="flex gap-3">
          <div className="flex-1">
            <Input
              id="host-address-input"
              label={t('managedResources.ipOrDomain') || 'IP 地址或 DNS 主机名'}
              required
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={t('managedResources.m2.addressPlaceholder')}
              size="sm"
              className="font-mono"
            />
          </div>
          <div className="w-36">
            <Input
              id="host-username-input"
              label={t('managedResources.username') || 'SSH 用户名'}
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="root"
              size="sm"
              className="font-mono"
            />
          </div>
        </div>

        {/* Authentication Type & Credential Section */}
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-3">
          <label className="mb-2 block font-medium text-[var(--color-text-secondary)]">
            {t('managedResources.authMethod') || 'SSH 认证方式'} *
          </label>
          <div className="flex gap-6 mb-3">
            <label className="flex items-center gap-2 cursor-pointer text-xs text-[var(--color-text-primary)]">
              <input
                type="radio"
                name="authType"
                value="password"
                checked={authType === 'password'}
                onChange={() => setAuthType('password')}
              />
              <span>{t('managedResources.authPassword')}</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-xs text-[var(--color-text-primary)]">
              <input
                type="radio"
                name="authType"
                value="privateKey"
                checked={authType === 'privateKey'}
                onChange={() => setAuthType('privateKey')}
              />
              <span>{t('managedResources.authKey')}</span>
            </label>
          </div>

          {/* Existing Credential status */}
          {existingHost?.auth.credentialId && !replaceCredential && !isAuthTypeChanged && (
            <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container)] p-3 text-xs">
              <div className="flex items-center gap-2 text-[var(--color-text-secondary)]">
                <KeyRound size={16} className="text-[var(--color-brand)]" />
                <span>{t('managedResources.boundVaultCredential') || '已绑定安全凭据 (已加密保存在保险库)'}</span>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="xs"
                onClick={() => setReplaceCredential(true)}
              >
                {t('managedResources.changeCredential') || '更换凭据'}
              </Button>
            </div>
          )}

          {/* New Credential Inputs */}
          {(!existingHost?.auth.credentialId || replaceCredential || isAuthTypeChanged) && (
            <div className="flex flex-col gap-3 pt-2 border-t border-[var(--color-border)]">
              {existingHost?.auth.credentialId && !isAuthTypeChanged && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setReplaceCredential(false)}
                    className="text-xs text-[var(--color-text-tertiary)] hover:underline"
                  >
                    {t('managedResources.keepExistingCredential') || '取消更换，保留现有凭据'}
                  </button>
                </div>
              )}
              {isAuthTypeChanged && (
                <div className="rounded-[var(--radius-sm)] bg-[var(--color-surface-container)] p-2 text-xs text-[var(--color-brand)]">
                  {t('managedResources.authTypeChangedMustEnterNewCred') || '认证方式已变更，必须输入匹配种类的新凭据'}
                </div>
              )}

              {/* Password field */}
              {authType === 'password' && (
                <div className="relative">
                  <Input
                    id="host-password-input"
                    label={t('managedResources.sshPasswordRequired') || 'SSH 登录密码 *'}
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('managedResources.passwordPlaceholder') || '输入服务器 SSH 密码'}
                    size="sm"
                    required={!existingHost || replaceCredential || isAuthTypeChanged}
                    className="pr-8 font-mono"
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? (t('managedResources.hidePassword') || '隐藏密码') : (t('managedResources.showPassword') || '显示密码')}
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-7 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
                  >
                    {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              )}

              {/* Private Key fields */}
              {authType === 'privateKey' && (
                <div className="flex flex-col gap-2.5">
                  <TextArea
                    id="host-private-key-input"
                    label={t('managedResources.sshPrivateKeyRequired') || 'SSH 私钥 (PEM 格式) *'}
                    rows={4}
                    value={privateKeyPem}
                    onChange={(e) => setPrivateKeyPem(e.target.value)}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
                    required={!existingHost || replaceCredential || isAuthTypeChanged}
                    className="font-mono text-xs"
                  />
                  <Input
                    id="host-passphrase-input"
                    label={t('managedResources.keyPassphrase') || '私钥口令/Passphrase (可选)'}
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder={t('managedResources.keyPassphrasePlaceholder') || '若私钥有口令保护请输入'}
                    size="sm"
                    className="font-mono"
                  />
                </div>
              )}

              {/* Storage Mode Radio */}
              <div className="mt-1 flex flex-col gap-1.5">
                <span className="font-medium text-[var(--color-text-secondary)]">{t('managedResources.storageStrategy') || '凭据保存策略'}</span>
                <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-2.5">
                  <label className="flex cursor-pointer items-start gap-2 text-xs">
                    <input
                      type="radio"
                      name="storageMode"
                      value="vault"
                      checked={storageMode === 'vault'}
                      onChange={() => setStorageMode('vault')}
                      className="mt-0.5"
                    />
                    <div>
                      <span className="font-semibold text-[var(--color-text-primary)]">{t('managedResources.vaultStorage') || '保存到保险库 (持久加密)'}</span>
                      <p className="text-[var(--color-text-tertiary)]">
                        {t('managedResources.vaultStorageDesc') || '通过系统底层安全存储 (safeStorage) 加密保存，下次启动自动可用。'}
                      </p>
                    </div>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 text-xs">
                    <input
                      type="radio"
                      name="storageMode"
                      value="temporary"
                      checked={storageMode === 'temporary'}
                      onChange={() => setStorageMode('temporary')}
                      className="mt-0.5"
                    />
                    <div>
                      <span className="font-semibold text-[var(--color-text-primary)]">{t('managedResources.sessionOnlyStorage') || '仅本次使用 (内存保留)'}</span>
                      <p className="text-[var(--color-text-tertiary)]">
                        {t('managedResources.sessionOnlyStorageDesc') || '仅驻留内存，绝不写入磁盘，应用关闭或窗口退出后立即失效。'}
                      </p>
                    </div>
                  </label>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Tags */}
        <div>
          <label className="mb-1.5 block font-medium text-[var(--color-text-secondary)]">{t('managedResources.bindTags') || '绑定标签'}</label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {tags.length === 0 ? (
              <span className="text-xs text-[var(--color-text-tertiary)]">{t('managedResources.noTagsPlaceholder') || '暂无标签，可直接在下方新建'}</span>
            ) : (
              tags.map((tag) => {
                const checked = selectedTagIds.includes(tag.id)
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => toggleTag(tag.id)}
                    aria-pressed={checked}
                    className={`rounded-[var(--radius-sm)] border px-2.5 py-1 text-xs transition-colors ${
                      checked
                        ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-[var(--color-on-primary)]'
                        : 'border-[var(--color-border)] bg-[var(--color-surface-container)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                    }`}
                  >
                    {tag.name}
                  </button>
                )
              })
            )}
          </div>
          {/* Inline tag creation */}
          <div className="flex items-center gap-2">
            <Input
              id="host-new-tag"
              label={t('managedResources.m2.newTagLabel')}
              type="text"
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void handleCreateInlineTag()
                }
              }}
              placeholder={t('managedResources.newTagPlaceholder') || '新建标签名称...'}
              className="flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-border-focus)]"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleCreateInlineTag}
              disabled={!newTagName.trim() || isCreatingTag}
            >
              {t('managedResources.addTag') || '添加标签'}
            </Button>
          </div>
        </div>

        {/* Initial directory */}
        <div>
          <Input
            id="host-initial-dir-input"
            label={t('managedResources.initialDir') || '初始工作目录 (远端绝对路径)'}
            value={initialDirectory}
            onChange={(e) => setInitialDirectory(e.target.value)}
            placeholder={t('managedResources.m2.initialDirPlaceholder')}
            size="sm"
            className="font-mono"
          />
        </div>

        {/* Notes */}
        <div>
          <TextArea
            id="host-notes-input"
            label={t('managedResources.notes') || '备注 (禁止记录密码或私钥)'}
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('managedResources.m2.notesPlaceholder')}
            className="text-xs"
          />
        </div>

        {/* Buttons */}
        <div className="flex justify-end gap-2 pt-3 border-t border-[var(--color-border)]">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleClose}
          >
            {t('common.cancel') || '取消'}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={loading || isSubmitting || isCreatingTag}
          >
            {isSubmitting ? t('managedResources.m2.saving') : t('common.save')}
          </Button>
        </div>
        </fieldset>
      </form>
    </Modal>
  )
}
