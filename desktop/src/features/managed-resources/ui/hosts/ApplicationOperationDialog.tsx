import { useEffect, useRef, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import type { ApplicationOperation } from '../../api/applicationOperationsApi'

export function ApplicationOperationDialog({ operation, onClose }: { operation: ApplicationOperation; onClose: () => void }) {
  const t = useTranslation()
  const label = (key: string) => t(`managedResources.appOperations.${key}` as never)
  const [current, setCurrent] = useState(operation)
  const [error, setError] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)
  const output = useRef<HTMLPreElement>(null)
  const api = getDesktopHost().hostManagement
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      try {
        const result = await api.applicationOperation({ action: 'poll', operationId: operation.id })
        if (disposed) return
        if (!result.ok) { setError(result.error.code); return }
        if (result.data.kind !== 'operation') { setError('INVALID_RESPONSE'); return }
        setCurrent(result.data.operation)
        if (['starting', 'running'].includes(result.data.operation.state)) timer = setTimeout(() => void poll(), 500)
      } catch { if (!disposed) setError('DISCONNECTED') }
    }
    void poll()
    return () => { disposed = true; if (timer) clearTimeout(timer) }
  }, [api, operation.id])
  useEffect(() => {
    if (follow && output.current) output.current.scrollTop = output.current.scrollHeight
  }, [follow, current.text])
  const running = ['starting', 'running'].includes(current.state)
  const stop = async () => {
    try {
      const result = await api.applicationOperation({ action: 'stop', operationId: operation.id })
      if (result.ok && result.data.kind === 'operation') setCurrent(result.data.operation)
      else if (!result.ok) setError(result.error.code)
    } catch { setError('DISCONNECTED') }
  }
  return <Modal open title={current.mode === 'tail' ? label('tailTitle') : label('executionTitle')} closeLabel={t('common.close')} onClose={onClose} width={1000}
    footer={<div className="flex items-center justify-between gap-3">
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />{label('follow')}</label>
      <div className="flex gap-2">{running && <Button size="sm" variant="danger-outline" onClick={() => void stop()}>{label('stop')}</Button>}<Button size="sm" variant="secondary" onClick={onClose}>{t('common.close')}</Button></div>
    </div>}>
    <p className="break-all font-mono text-xs">{current.absolutePath || operation.absolutePath}</p>
    {current.mode === 'script' && <p className="mt-1 break-all text-xs">{label('cwd')}: {current.cwd || operation.cwd}</p>}
    <div role="status" className="my-2 text-xs">{label(current.state)}{current.exitCode !== null ? ` · ${label('exitCode')}: ${current.exitCode}` : ''}{current.signal ? ` · ${current.signal}` : ''}</div>
    {(error || current.errorCode) && <p role="alert" className="mb-2 text-xs text-[var(--color-error)]">{error || current.errorCode}</p>}
    {current.truncated && <p className="text-xs text-[var(--color-text-tertiary)]">{label('outputLimit')}</p>}
    <pre ref={output} tabIndex={0} aria-label={label('output')} className="h-[48vh] min-h-48 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-md)] bg-[var(--color-terminal-bg)] p-3 font-mono text-xs text-[var(--color-terminal-fg)]">{current.text || label('waiting')}</pre>
    <p className="mt-2 text-xs text-[var(--color-text-tertiary)]">{current.mode === 'tail' ? label('tailHelp') : label('executionHelp')}</p>
  </Modal>
}
