import { Square } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Button } from '@/components/ui/Button'
import { useSessionStopOffer } from '../../hooks/useSessionStopOffer'
import { useChatStore } from '../../stores/chatStore'

/**
 * The composer's Stop, for while 轨迹 hides the composer. Watching the ledger is
 * exactly when someone spots a run going nowhere, so leaving for 对话 to stop it
 * would cost the moment it is needed most.
 */
export function TrajectoryStopButton({ sessionId }: { sessionId: string }) {
  const t = useTranslation()
  const offer = useSessionStopOffer(sessionId)
  const stopGeneration = useChatStore((state) => state.stopGeneration)
  if (!offer) return null
  return (
    <Button
      variant="primary"
      size="sm"
      onClick={() => stopGeneration(sessionId)}
      title={t('chat.stopTitle')}
      icon={<Square size={10} strokeWidth={2} fill="currentColor" aria-hidden />}
      className="shrink-0"
    >
      {t('common.stop')}
    </Button>
  )
}
