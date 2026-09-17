import { Fragment, useEffect, useRef, useState } from 'react'
import type { WorkspaceCodeHighlightResult } from '@/components/workspace/workspaceDiffHighlighter'
import './remoteFileEditor.css'

export type RemoteSourceEditorProps = {
  value: string
  language: string
  onChange: (value: string) => void
  disabled?: boolean
  label: string
  describedBy?: string
}

/** Native textarea editing (including IME/undo) over a tokenized, non-editable layer. */
export function RemoteSourceEditor({ value, language, onChange, disabled, label, describedBy }: RemoteSourceEditorProps) {
  const layer = useRef<HTMLPreElement>(null)
  const [highlight, setHighlight] = useState<{ source: string; language: string; result: WorkspaceCodeHighlightResult } | null>(null)
  useEffect(() => {
    let disposed = false
    // Editing remains available at the server's text limit; avoid tokenizing a huge document on every key.
    if (language === 'text' || value.length > 256 * 1024 || value.split('\n').length > 5000) {
      setHighlight(null)
      return
    }
    const timer = setTimeout(() => {
      void import('@/components/workspace/workspaceDiffHighlighter').then(module => module.highlightWorkspaceCode({ value, language })).then(result => {
        if (!disposed) setHighlight({ source: value, language, result })
      }).catch(() => { if (!disposed) setHighlight(null) })
    }, 50)
    return () => { disposed = true; clearTimeout(timer) }
  }, [value, language])
  const tokens = highlight?.source === value && highlight.language === language && highlight.result.engine === 'shiki'
    ? highlight.result.tokensByLine : null
  return (
    <div className="remote-source-editor min-h-0 flex-1" data-language={language} data-highlight-engine={tokens ? 'shiki' : 'plain'}>
      <pre className="remote-source-layer" ref={layer} aria-hidden="true">{tokens ? tokens.map((line, index) => (
        <Fragment key={index}>{line.map((token, tokenIndex) => (
          <span key={tokenIndex} data-remote-code-token="" style={{ color: token.color }}>{token.content}</span>
        ))}{'\n'}</Fragment>
      )) : value + '\n'}</pre>
      <textarea
        className="remote-source-input"
        aria-label={label}
        aria-describedby={describedBy}
        value={value}
        disabled={disabled}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        wrap="off"
        onScroll={event => {
          if (!layer.current) return
          layer.current.scrollTop = event.currentTarget.scrollTop
          layer.current.scrollLeft = event.currentTarget.scrollLeft
        }}
        onChange={event => onChange(event.currentTarget.value)}
      />
    </div>
  )
}
