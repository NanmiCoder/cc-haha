import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n'
import { PanelMessage } from '../PanelMessage'
import { CodeSurface } from '../CodeSurface'
import type { DocumentSourceActions } from './documentViewers'
import { decodeDelimitedText } from './spreadsheetEngine'

/**
 * The text of a `.csv` or `.tsv` as it is on disk, for the reader who wants the file
 * rather than the table. It is the panel's ordinary code view, so line comments and
 * "add selection to chat" work as they do for every other text file.
 */
export function DelimitedSource({ blob, source }: { blob: Blob; source: DocumentSourceActions }) {
  const t = useTranslation()
  const [text, setText] = useState<string | null>(null)

  useEffect(() => {
    let superseded = false
    void blob.arrayBuffer().then((buffer) => {
      if (!superseded) setText(decodeDelimitedText(new Uint8Array(buffer)))
    })
    return () => {
      superseded = true
    }
  }, [blob])

  if (text === null) return <PanelMessage busy message={t('workspace.document.loading')} />
  return (
    <CodeSurface
      value={text}
      language="text"
      reveal={source.reveal}
      revealScroll={source.revealScroll}
      onAddLineComment={source.onAddLineComment}
      onAddSelection={source.onAddSelection}
    />
  )
}
