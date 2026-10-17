import { useRef } from 'react'
import { CircleAlert, Upload } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useTranslation } from '../../i18n'
import type { ActivityProfile } from './useActivityProfile'

export function ProfileEditModal({ profile }: { profile: ActivityProfile }) {
  const t = useTranslation()
  const avatarInputRef = useRef<HTMLInputElement | null>(null)

  return (
    <Modal
      open={profile.isEditing}
      onClose={profile.cancelEdit}
      title={t('settings.activity.editProfile')}
      width={420}
      footer={
        <>
          <Button variant="ghost" size="base" onClick={profile.cancelEdit}>
            {t('settings.activity.cancelEdit')}
          </Button>
          <Button variant="primary" size="base" onClick={profile.save} disabled={profile.isSaving}>
            {t('settings.activity.saveProfile')}
          </Button>
        </>
      }
    >
      <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.activity.displayNameHelper')}</p>

      <div className="mt-5 grid gap-4">
        <Input
          label={t('settings.activity.displayName')}
          value={profile.draftDisplayName}
          onChange={(event) => profile.setDraftDisplayName(event.target.value)}
        />

        <Input
          label={t('settings.activity.subtitle')}
          value={profile.draftSubtitle}
          onChange={(event) => profile.setDraftSubtitle(event.target.value)}
        />

        <div className="grid gap-2">
          <div className="text-xs font-medium text-[var(--color-text-secondary)]">{t('settings.activity.avatar')}</div>
          <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.activity.avatarHelper')}</p>
          <div className="flex flex-wrap gap-2">
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={profile.uploadAvatar}
            />
            <Button
              variant="secondary"
              size="base"
              onClick={() => avatarInputRef.current?.click()}
              icon={<Upload size={14} strokeWidth={1.75} aria-hidden="true" />}
            >
              {t('settings.activity.changeAvatar')}
            </Button>
            {profile.profile.avatarFile && (
              <Button variant="ghost" size="base" onClick={profile.removeAvatar}>
                {t('settings.activity.removeAvatar')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {profile.error && (
        <div className="mt-4 flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--color-error-container)] px-3 py-2 text-xs text-[var(--color-on-error-container)]">
          <CircleAlert size={14} strokeWidth={1.75} aria-hidden="true" className="mt-px shrink-0" />
          <span className="min-w-0">{profile.error}</span>
        </div>
      )}
    </Modal>
  )
}
