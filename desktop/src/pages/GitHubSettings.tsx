import { useState, useCallback, useEffect } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { useTaskStore } from '../stores/taskStore'
import { useTranslation } from '../i18n'
import { Input } from '../components/shared/Input'
import { Button } from '../components/shared/Button'
import { Spinner } from '../components/shared/Spinner'

const REPO_FORMAT_REGEX = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/

function isValidRepoFormat(input: string): boolean {
  return REPO_FORMAT_REGEX.test(input.trim())
}

function parseRepo(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim()
  if (!isValidRepoFormat(trimmed)) return null
  const parts = trimmed.split('/')
  return { owner: parts[0]!, repo: parts[1]! }
}

export function GitHubSettings() {
  const t = useTranslation()
  const {
    githubStatus,
    githubMonitoredRepos,
    saveGitHubToken,
    deleteGitHubToken,
    updateGitHubRepos,
  } = useSettingsStore()
  const { tasks, fetchTasks, runTask } = useTaskStore()

  const [tokenInput, setTokenInput] = useState('')
  const [tokenVerifying, setTokenVerifying] = useState(false)
  const [tokenError, setTokenError] = useState<string | null>(null)

  const [repoInput, setRepoInput] = useState('')
  const [repoError, setRepoError] = useState<string | null>(null)

  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  const monitorTask = tasks.find((t) => t.name === 'GitHub Issue Monitor')
  const monitorEnabled = monitorTask?.enabled !== false
  const monitorLastRun = monitorTask?.lastFiredAt

  const handleSaveToken = useCallback(async () => {
    const token = tokenInput.trim()
    if (!token) {
      setTokenError(t('settings.github.tokenRequired') || 'Token is required')
      return
    }
    setTokenVerifying(true)
    setTokenError(null)
    try {
      await saveGitHubToken(token)
      setTokenInput('')
    } catch (err) {
      const message = err instanceof Error ? err.message : t('settings.github.tokenVerifyFailed')
      setTokenError(message)
    } finally {
      setTokenVerifying(false)
    }
  }, [tokenInput, saveGitHubToken, t])

  const handleDisconnect = useCallback(async () => {
    try {
      await deleteGitHubToken()
    } catch {
      // ignore
    }
  }, [deleteGitHubToken])

  const handleAddRepo = useCallback(() => {
    const parsed = parseRepo(repoInput)
    if (!parsed) {
      setRepoError(t('settings.github.invalidRepoFormat'))
      return
    }
    const exists = githubMonitoredRepos.some(
      (r) => r.owner === parsed.owner && r.repo === parsed.repo
    )
    if (exists) {
      setRepoError(t('settings.github.repoExists') || 'Repository already exists')
      return
    }
    const newRepos = [...githubMonitoredRepos, { ...parsed, autoReply: false }]
    updateGitHubRepos(newRepos)
    setRepoInput('')
    setRepoError(null)
  }, [repoInput, githubMonitoredRepos, updateGitHubRepos, t])

  const handleRemoveRepo = useCallback(
    (index: number) => {
      const newRepos = githubMonitoredRepos.filter((_, i) => i !== index)
      updateGitHubRepos(newRepos)
    },
    [githubMonitoredRepos, updateGitHubRepos]
  )

  const handleToggleAutoReply = useCallback(
    (index: number) => {
      const newRepos = githubMonitoredRepos.map((r, i) =>
        i === index ? { ...r, autoReply: !r.autoReply } : r
      )
      updateGitHubRepos(newRepos)
    },
    [githubMonitoredRepos, updateGitHubRepos]
  )

  return (
    <div className="max-w-2xl space-y-6">
      {/* Title */}
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
          {t('settings.github.title')}
        </h2>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          {t('settings.github.description')}
        </p>
      </div>

      {/* Connection status card */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4 space-y-4">
        {githubStatus?.connected ? (
          <div className="flex items-center gap-4">
            {githubStatus.avatar ? (
              <img
                src={githubStatus.avatar}
                alt={githubStatus.username}
                className="w-10 h-10 rounded-full"
              />
            ) : (
              <div className="w-10 h-10 rounded-full bg-[var(--color-brand)] flex items-center justify-center text-white font-semibold">
                {githubStatus.username?.charAt(0).toUpperCase() ?? 'G'}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-[var(--color-text-primary)]">
                {t('settings.github.connectedAs', { username: githubStatus.username ?? '' })}
              </p>
              <p className="text-xs text-[var(--color-text-tertiary)]">
                {t('settings.github.connectedDesc') || 'Your GitHub account is linked.'}
              </p>
            </div>
            <Button variant="danger" size="sm" onClick={handleDisconnect}>
              {t('settings.github.disconnect')}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Input
              label={t('settings.github.tokenLabel')}
              type="password"
              placeholder={t('settings.github.tokenPlaceholder')}
              value={tokenInput}
              onChange={(e) => {
                setTokenInput(e.target.value)
                if (tokenError) setTokenError(null)
              }}
              error={tokenError ?? undefined}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveToken()
              }}
            />
            <div className="flex items-center gap-2">
              <Button
                onClick={handleSaveToken}
                loading={tokenVerifying}
                disabled={!tokenInput.trim()}
              >
                {tokenVerifying ? (
                  <span className="flex items-center gap-1.5">
                    <Spinner size={16} />
                    {t('settings.github.verifying') || 'Verifying...'}
                  </span>
                ) : (
                  t('settings.github.verifyAndSave')
                )}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Repository list */}
      <div className="space-y-3">
        <div>
          <h3 className="text-base font-semibold text-[var(--color-text-primary)]">
            {t('settings.github.reposTitle')}
          </h3>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            {t('settings.github.reposDescription')}
          </p>
        </div>

        {githubStatus?.connected && (
          <div className="flex gap-2">
            <div className="flex-1">
              <Input
                placeholder={t('settings.github.repoPlaceholder')}
                value={repoInput}
                onChange={(e) => {
                  setRepoInput(e.target.value)
                  if (repoError) setRepoError(null)
                }}
                error={repoError ?? undefined}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddRepo()
                }}
              />
            </div>
            <Button variant="secondary" onClick={handleAddRepo} disabled={!repoInput.trim()}>
              {t('settings.github.addRepo')}
            </Button>
          </div>
        )}

        {!githubStatus?.connected && (
          <div className="py-6 text-center text-sm text-[var(--color-text-tertiary)] rounded-lg border border-dashed border-[var(--color-border)]">
            {t('settings.github.connectFirst') || 'Connect your GitHub account to add repositories.'}
          </div>
        )}

        {githubStatus?.connected && githubMonitoredRepos.length === 0 && (
          <div className="py-6 text-center text-sm text-[var(--color-text-tertiary)] rounded-lg border border-dashed border-[var(--color-border)]">
            {t('settings.github.noRepos')}
          </div>
        )}

        {githubMonitoredRepos.length > 0 && (
          <div className="rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
            {githubMonitoredRepos.map((repo, index) => (
              <div
                key={`${repo.owner}/${repo.repo}`}
                className="flex items-center gap-3 px-4 py-3"
              >
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-[var(--color-text-primary)]">
                    {repo.owner}/{repo.repo}
                  </span>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={repo.autoReply}
                    onChange={() => handleToggleAutoReply(index)}
                    className="rounded border-[var(--color-border)] accent-[var(--color-brand)]"
                  />
                  {t('settings.github.autoReply')}
                </label>
                <button
                  onClick={() => handleRemoveRepo(index)}
                  className="p-1.5 text-[var(--color-text-tertiary)] hover:text-red-400 transition-colors shrink-0"
                  title={t('common.delete')}
                >
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Monitor status */}
        {githubStatus?.connected && (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${monitorEnabled ? 'bg-green-500' : 'bg-gray-400'}`} />
                <span className="text-sm font-medium text-[var(--color-text-primary)]">
                  {t('settings.github.monitorStatus') || 'Issue Monitor'}
                </span>
              </div>
              {monitorTask && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => runTask(monitorTask.id)}
                >
                  {t('settings.github.runNow') || 'Run Now'}
                </Button>
              )}
            </div>
            <div className="text-xs text-[var(--color-text-secondary)]">
              {monitorEnabled
                ? (monitorLastRun
                  ? t('settings.github.monitorLastRun', { time: monitorLastRun }) || `Last run: ${monitorLastRun}`
                  : t('settings.github.monitorWaiting') || 'Waiting for first run...')
                : t('settings.github.monitorDisabled') || 'Monitor is disabled (no active repositories)'
              }
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
