import { useState } from 'react'

import { Button } from '@/components/ui/Button'
import { useTranslation } from '../../i18n'
import { isMagpieProvider, useMagpieStore } from '../../stores/magpieStore'
import { useProviderStore } from '../../stores/providerStore'
import { useSessionRuntimeStore } from '../../stores/sessionRuntimeStore'

// What a refused or dropped loopback connection reads like by the time it reaches the chat.
const CONNECTION_FAILURE = /connection error|econnrefused|fetch failed|unable to connect|socket hang up|etimedout/i

export function isConnectionFailureText(text: string): boolean {
  return CONNECTION_FAILURE.test(text)
}

/**
 * A request failure the CLI recorded as its synthetic assistant reply (its
 * `API_ERROR_MESSAGE_PREFIX`). Live it arrives as an error event, but once the
 * turn's history reloads it is this plain assistant text.
 */
export function isCliApiErrorText(text: string): boolean {
  return text.startsWith('API Error')
}

/**
 * Under a request error of a session running on Magpie: the gateway lives in
 * another app, so a refused connection almost always means Magpie is closed.
 */
export function MagpieConnectionHint({ sessionId, errorText }: { sessionId?: string | null; errorText: string }) {
  const t = useTranslation()
  const selection = useSessionRuntimeStore((store) => (sessionId ? store.selections[sessionId] : undefined))
  const providers = useProviderStore((store) => store.providers)
  const activeId = useProviderStore((store) => store.activeId)
  const openApp = useMagpieStore((store) => store.open)
  const refresh = useMagpieStore((store) => store.refresh)
  const [openUnsupported, setOpenUnsupported] = useState(false)

  const providerId = selection ? selection.providerId : activeId
  const provider = providers.find((candidate) => candidate.id === providerId)
  if (!isMagpieProvider(provider) || !isConnectionFailureText(errorText)) return null

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="magpie-connection-hint">
      <span className="min-w-0 flex-1 text-xs">
        {t(openUnsupported ? 'settings.providers.magpie.openAppManually' : 'chat.magpieUnreachable')}
      </span>
      {!openUnsupported && (
        <Button
          variant="secondary"
          size="sm"
          onClick={async () => {
            const result = await openApp()
            if (result.unsupported) setOpenUnsupported(true)
            else void refresh({ force: true })
          }}
        >
          {t('settings.providers.magpie.openApp')}
        </Button>
      )}
    </div>
  )
}
