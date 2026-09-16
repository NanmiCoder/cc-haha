import type { DataCell, SqlQueryResult } from '../../api/dataConnectionsApi'
import { useTranslation } from '../../../../i18n'

function cellText(cell: DataCell): string {
  switch (cell.kind) {
    case 'null': return 'NULL'
    case 'string':
    case 'bigint':
    case 'decimal':
    case 'date': return cell.value
    case 'number': return String(cell.value)
    case 'boolean': return cell.value ? 'true' : 'false'
    case 'json': return cell.value
    case 'binary': return `base64:${cell.base64Preview}${cell.truncated ? '…' : ''} (${cell.byteLength} B)`
  }
}

export function QueryResultGrid({ result }: { result: SqlQueryResult | null }) {
  const t = useTranslation()
  if (!result) return null
  return (
    <div data-testid="sql-result-grid" className="mt-3 overflow-hidden rounded-md border border-[var(--color-border)]">
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-[var(--color-border)] bg-[var(--color-surface-container)] px-3 py-2 text-xs text-[var(--color-text-secondary)]">
        <span>{result.rowCount} {t('managedResources.dataBrowser.rows')}</span>
        <span>{result.byteCount} {t('managedResources.dataBrowser.bytes')}</span>
        <span>{result.durationMs} {t('managedResources.dataBrowser.milliseconds')}</span>
        {result.truncated && <span className="text-[var(--color-warning)]">{t('managedResources.dataBrowser.truncated')}</span>}
      </div>
      <div className="max-h-80 overflow-auto">
        <table className="min-w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-[var(--color-surface)]">
            <tr>
              {result.columns.map((column) => (
                <th scope="col" key={column.index} className="whitespace-nowrap border-b border-r border-[var(--color-border)] px-2 py-1.5 text-left font-medium">
                  {column.name}<span className="ml-1 text-[var(--color-text-tertiary)]">#{column.index + 1}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="max-w-80 whitespace-pre-wrap break-all border-b border-r border-[var(--color-border)] px-2 py-1.5 font-mono align-top">
                    {cellText(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
