import { useEffect, useState } from 'react'
import { History, PlugZap, Trash2, Unplug } from 'lucide-react'

import {
  SettingsBlock,
  SettingsGroup,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsSection'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { Input } from '@/components/ui/Input'
import { useTranslation } from '@/i18n'
import { useRemoteWorkspaceStore } from '@/stores/remoteWorkspaceStore'
import { useUIStore } from '@/stores/uiStore'

/**
 * Settings ▸ Remote Workspace.
 *
 * The renderer is a thin client over one cc-haha server, and that server owns
 * each session's working directory, the agent process, every tool execution and
 * every permission check — so pointing the renderer at a server running on
 * another machine moves the whole workspace there. The expected transport is an
 * SSH tunnel, which `scripts/remote-workspace/deploy.ts` sets up and which is
 * why only a loopback URL is accepted here.
 *
 * Switching reloads the window so startup re-resolves every view — session list,
 * file browser, diffs — against the new server at once, rather than leaving half
 * the app pointing at one machine and half at another.
 */

const DEPLOY_COMMAND = 'bun run scripts/remote-workspace/deploy.ts --host <ssh-host>'

export function RemoteWorkspaceSettings() {
  const t = useTranslation()
  const { profile, history, status, error, load, verify, connect, disconnect, forgetMachine } = useRemoteWorkspaceStore()
  const [serverUrl, setServerUrl] = useState('')
  const [sshHost, setSshHost] = useState('')
  const [token, setToken] = useState('')

  useEffect(() => {
    load()
  }, [load])

  // Pre-fill from the remembered profile so reconnecting after a reboot is one
  // click, but never overwrite what the user is typing.
  useEffect(() => {
    if (!profile) return
    setServerUrl((current) => current || profile.url)
    setSshHost((current) => current || profile.sshHost)
    setToken((current) => current || profile.token || '')
  }, [profile])

  const connected = status === 'connected'
  const busy = status === 'connecting'

  async function handleVerify() {
    const ok = await verify(serverUrl.trim())
    useUIStore.getState().addToast({
      type: ok ? 'success' : 'error',
      message: ok ? t('settings.remoteWorkspace.verifyOk') : t('settings.remoteWorkspace.verifyFailed'),
    })
  }

  async function handleConnect() {
    try {
      await connect(serverUrl.trim(), sshHost.trim(), token.trim() || undefined)
    } catch (connectError) {
      useUIStore.getState().addToast({
        type: 'error',
        message: connectError instanceof Error && connectError.message
          ? connectError.message
          : t('settings.remoteWorkspace.connectFailed'),
      })
    }
  }

  return (
    <div className="w-full min-w-0">
      <SettingsPageHeader
        title={t('settings.tab.remoteWorkspace')}
        description={t('settings.remoteWorkspace.description')}
        className="mb-5"
        action={connected
          ? (
            <Badge tone="success" size="sm">
              {t('settings.remoteWorkspace.statusConnected', { host: profile?.sshHost ?? '' })}
            </Badge>
          )
          : <Badge tone="neutral" size="sm">{t('settings.remoteWorkspace.statusLocal')}</Badge>}
      />

      <SettingsSection
        title={t('settings.remoteWorkspace.deployTitle')}
        description={t('settings.remoteWorkspace.deployDescription')}
      >
        <SettingsGroup>
          <SettingsBlock>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2 font-mono text-xs text-[var(--color-text-secondary)]">
                {DEPLOY_COMMAND}
              </code>
              <CopyButton
                text={DEPLOY_COMMAND}
                label={t('common.copy')}
                copiedLabel={t('common.copied')}
                className="shrink-0 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
              />
            </div>
            <p className="mt-2 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
              {t('settings.remoteWorkspace.deployHint', { placeholder: '<ssh-host>' })}
            </p>
          </SettingsBlock>
        </SettingsGroup>
      </SettingsSection>

      {history.length > 0 && (
        <SettingsSection
          title={t('settings.remoteWorkspace.historyTitle')}
          description={t('settings.remoteWorkspace.historyHint')}
        >
          <SettingsGroup>
            {history.map((machine) => (
              <SettingsRow
                key={machine.url}
                title={machine.sshHost}
                description={machine.url}
                data-testid="remote-workspace-machine"
              >
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<History size={14} strokeWidth={1.75} aria-hidden="true" />}
                  disabled={busy || connected}
                  onClick={() => {
                    setServerUrl(machine.url)
                    setSshHost(machine.sshHost)
                    setToken(machine.token ?? '')
                  }}
                >
                  {t('settings.remoteWorkspace.useMachine')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />}
                  disabled={busy}
                  aria-label={t('settings.remoteWorkspace.removeMachine')}
                  onClick={() => forgetMachine(machine.url)}
                />
              </SettingsRow>
            ))}
          </SettingsGroup>
        </SettingsSection>
      )}

      <SettingsSection title={t('settings.remoteWorkspace.connectionTitle')}>
        <SettingsGroup>
          <SettingsRow
            title={t('settings.remoteWorkspace.serverUrl')}
            description={t('settings.remoteWorkspace.serverUrlHint')}
            htmlFor="remote-workspace-url"
            layout="stack"
          >
            <Input
              id="remote-workspace-url"
              size="md"
              value={serverUrl}
              placeholder={t('settings.remoteWorkspace.serverUrlPlaceholder')}
              disabled={busy || connected}
              autoComplete="off"
              onChange={(event) => setServerUrl(event.target.value)}
              containerClassName="w-full sm:w-[340px]"
              className="font-mono text-xs"
            />
          </SettingsRow>
          <SettingsRow
            title={t('settings.remoteWorkspace.sshHost')}
            description={t('settings.remoteWorkspace.sshHostHint')}
            htmlFor="remote-workspace-host"
            layout="stack"
          >
            <Input
              id="remote-workspace-host"
              size="md"
              value={sshHost}
              placeholder={t('settings.remoteWorkspace.sshHostPlaceholder')}
              disabled={busy || connected}
              autoComplete="off"
              onChange={(event) => setSshHost(event.target.value)}
              containerClassName="w-full sm:w-[340px]"
              className="font-mono text-xs"
            />
          </SettingsRow>
          <SettingsRow
            title={t('settings.remoteWorkspace.token')}
            description={t('settings.remoteWorkspace.tokenHint')}
            htmlFor="remote-workspace-token"
            layout="stack"
          >
            <Input
              id="remote-workspace-token"
              size="md"
              type="password"
              value={token}
              placeholder={t('settings.remoteWorkspace.tokenPlaceholder')}
              disabled={busy || connected}
              autoComplete="off"
              onChange={(event) => setToken(event.target.value)}
              containerClassName="w-full sm:w-[340px]"
              className="font-mono text-xs"
            />
          </SettingsRow>
          <SettingsRow title={t('settings.remoteWorkspace.actions')}>
            {connected ? (
              <Button
                variant="danger"
                size="sm"
                icon={<Unplug size={14} strokeWidth={1.75} aria-hidden="true" />}
                onClick={disconnect}
              >
                {t('settings.remoteWorkspace.disconnect')}
              </Button>
            ) : (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy}
                  disabled={!serverUrl.trim()}
                  onClick={() => void handleVerify()}
                >
                  {t('settings.remoteWorkspace.verify')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  icon={<PlugZap size={14} strokeWidth={1.75} aria-hidden="true" />}
                  loading={busy}
                  disabled={!serverUrl.trim() || !sshHost.trim()}
                  onClick={() => void handleConnect()}
                >
                  {t('settings.remoteWorkspace.connect')}
                </Button>
              </>
            )}
          </SettingsRow>
        </SettingsGroup>
        {status === 'error' && error && (
          <p role="alert" className="mt-2 text-xs text-[var(--color-error)]">
            {error === 'unreachable' ? t('settings.remoteWorkspace.verifyFailed') : error}
          </p>
        )}
      </SettingsSection>

      <SettingsSection title={t('settings.remoteWorkspace.limitationsTitle')}>
        <SettingsGroup>
          <SettingsBlock>
            <ul className="list-disc space-y-1 pl-4 text-xs leading-[1.6] text-[var(--color-text-tertiary)]">
              <li>{t('settings.remoteWorkspace.limitationTerminal')}</li>
              <li>{t('settings.remoteWorkspace.limitationTunnel')}</li>
            </ul>
          </SettingsBlock>
        </SettingsGroup>
      </SettingsSection>
    </div>
  )
}
