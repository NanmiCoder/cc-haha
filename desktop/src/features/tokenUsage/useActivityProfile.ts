import { useCallback, useEffect, useState, type ChangeEvent } from 'react'

import {
  desktopUiPreferencesApi,
  getProfileAvatarUrl,
  type DesktopProfilePreferences,
} from '../../api/desktopUiPreferences'
import { useTranslation } from '../../i18n'
import { publicAssetPath } from '../../lib/publicAsset'
import { isPublicAccessRuntime } from '../../lib/publicAccessRuntime'

type DisplayProfile = DesktopProfilePreferences & { avatarDataUrl?: string | null }

export const DEFAULT_PROFILE: DesktopProfilePreferences = {
  displayName: 'cc-haha',
  subtitle: 'github.com/NanmiCoder/cc-haha',
  avatarFile: null,
  avatarUpdatedAt: null,
}

export const DEFAULT_AVATAR_SRC = publicAssetPath('app-icon.png')

function withProfileDefaults(profile: Partial<DisplayProfile> | null | undefined): DisplayProfile {
  return { ...DEFAULT_PROFILE, ...profile }
}

/** A second line that looks like a URL (with or without a scheme) becomes a link. */
export function getProfileSubtitleHref(subtitle: string) {
  if (/^https?:\/\//i.test(subtitle)) return subtitle
  if (/^[\w.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(subtitle)) return `https://${subtitle}`
  return null
}

/** Where the profile's picture comes from; null means the page falls back to the app icon. */
export function getProfileAvatarSource(profile: DisplayProfile) {
  if (profile.avatarDataUrl) return profile.avatarDataUrl
  return profile.avatarFile ? getProfileAvatarUrl(profile.avatarUpdatedAt) : null
}

export type ActivityProfile = ReturnType<typeof useActivityProfile>

/** The identity shown on the usage page and its edit dialog: load, edit, save, avatar upload and removal. */
export function useActivityProfile(browserMode = false) {
  const t = useTranslation()
  const readOnly = browserMode || isPublicAccessRuntime()
  const [profile, setProfile] = useState<DisplayProfile>(DEFAULT_PROFILE)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [draftDisplayName, setDraftDisplayName] = useState(DEFAULT_PROFILE.displayName)
  const [draftSubtitle, setDraftSubtitle] = useState(DEFAULT_PROFILE.subtitle)

  const adopt = useCallback((next: DisplayProfile) => {
    setProfile(next)
    setDraftDisplayName(next.displayName)
    setDraftSubtitle(next.subtitle)
  }, [])

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError(null)
    const request = readOnly
      ? desktopUiPreferencesApi.getProfile().then((result) => withProfileDefaults(result.profile))
      : desktopUiPreferencesApi.getPreferences().then((result) => withProfileDefaults(result.preferences.profile))
    request
      .then((next) => {
        if (!cancelled) adopt(next)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [adopt, readOnly])

  const run = async (work: () => Promise<DesktopProfilePreferences>, afterSave?: () => void) => {
    if (readOnly) return
    setIsSaving(true)
    setError(null)
    setStatus(null)
    try {
      adopt(await work())
      afterSave?.()
      setStatus(t('settings.activity.profileSaved'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.activity.profileSaveFailed'))
    } finally {
      setIsSaving(false)
    }
  }

  return {
    profile,
    readOnly,
    error,
    status,
    isLoading,
    isEditing,
    isSaving,
    draftDisplayName,
    draftSubtitle,
    setDraftDisplayName,
    setDraftSubtitle,
    startEdit: () => {
      if (readOnly) return
      setIsEditing(true)
      setDraftDisplayName(profile.displayName)
      setDraftSubtitle(profile.subtitle)
    },
    cancelEdit: () => {
      setIsEditing(false)
      setDraftDisplayName(profile.displayName)
      setDraftSubtitle(profile.subtitle)
      setError(null)
    },
    save: () => run(
      async () => withProfileDefaults((await desktopUiPreferencesApi.updateProfilePreferences({
        displayName: draftDisplayName,
        subtitle: draftSubtitle,
      })).preferences.profile),
      () => setIsEditing(false),
    ),
    uploadAvatar: (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return Promise.resolve()
      return run(async () => withProfileDefaults((await desktopUiPreferencesApi.uploadProfileAvatar(file)).preferences.profile))
    },
    removeAvatar: () => run(async () => withProfileDefaults((await desktopUiPreferencesApi.deleteProfileAvatar()).preferences.profile)),
  }
}
