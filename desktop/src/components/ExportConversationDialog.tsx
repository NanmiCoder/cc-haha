import { useEffect, useState } from 'react'
import { useTranslation } from '../i18n'
import { sessionsApi } from '../api/sessions'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { SelectField } from '@/components/ui/SelectField'
import {
  collectExportNodes,
  downloadExport,
  formatExportFilename,
  renderMessagesToHtml,
  renderMessagesToMarkdown,
  renderMessagesToPlainText,
  type ExportFormat,
} from '../lib/sessionExport'

export type ExportConversationDialogProps = {
  sessionId: string
  sessionTitle: string
  open: boolean
  onClose: () => void
}

export function ExportConversationDialog({
  sessionId,
  sessionTitle,
  open,
  onClose,
}: ExportConversationDialogProps) {
  const t = useTranslation()
  const [format, setFormat] = useState<ExportFormat>('markdown')
  const [startNode, setStartNode] = useState<string>('latest')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleExport = async () => {
    setLoading(true)
    setError(null)
    try {
      const { messages } = await sessionsApi.getFullHistory(sessionId)
      const nodes = collectExportNodes(messages)
      const selectedIndex = startNode === 'all' ? 0 : startNode === 'latest'
        ? (nodes.length > 0 ? nodes[nodes.length - 1]!.index : 0)
        : Number(startNode)
      const range = messages.slice(selectedIndex)
      const base = sessionTitle || 'conversation'
      const filename = formatExportFilename(base, format)
      let content: string
      if (format === 'markdown') {
        content = renderMessagesToMarkdown(range)
      } else if (format === 'html') {
        content = renderMessagesToHtml(range, sessionTitle || 'Conversation Export')
      } else {
        content = renderMessagesToPlainText(range)
      }
      downloadExport(content, filename)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const formatOptions: Array<{ value: ExportFormat; label: string }> = [
    { value: 'markdown', label: 'Markdown (.md)' },
    { value: 'html', label: 'HTML (.html)' },
    { value: 'txt', label: 'Plain text (.txt)' },
  ]

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('session.export.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={() => void handleExport()} loading={loading}>{t('session.export.export')}</Button>
        </>
      }
    >
      <ExportRangePicker sessionId={sessionId} startNode={startNode} onChange={setStartNode} />
      <div className="mt-4">
        <SelectField<ExportFormat>
          label={t('session.export.format')}
          options={formatOptions}
          value={format}
          onChange={setFormat}
        />
      </div>
      {error ? <p className="mt-3 text-sm text-[var(--color-error)]">{error}</p> : null}
    </Modal>
  )
}

function ExportRangePicker({
  sessionId,
  startNode,
  onChange,
}: {
  sessionId: string
  startNode: string
  onChange: (value: string) => void
}) {
  const t = useTranslation()
  const [nodes, setNodes] = useState<{ value: string; label: string }[] | null>(null)

  useEffect(() => {
    let cancelled = false
    setNodes(null)
    void sessionsApi.getFullHistory(sessionId)
      .then(({ messages }) => {
        if (cancelled) return
        const collected = collectExportNodes(messages)
        const options = collected.map((node) => ({
          value: node.index === 0 ? 'first' : String(node.index),
          label: node.label,
        }))
        const opts = [
          { value: 'latest', label: t('session.export.range.latest') },
          ...options,
          { value: 'all', label: t('session.export.range.all') },
        ]
        setNodes(opts)
      })
      .catch(() => {
        if (cancelled) return
        setNodes([
          { value: 'latest', label: t('session.export.range.latest') },
          { value: 'all', label: t('session.export.range.all') },
        ])
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  if (!nodes) return <p className="text-sm text-[var(--color-text-tertiary)]">{t('common.loading')}</p>

  return (
    <div>
      <SelectField
        label={t('session.export.range')}
        options={nodes}
        value={startNode}
        onChange={onChange}
      />
    </div>
  )
}
