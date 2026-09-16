import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { QueryResultGrid } from './QueryResultGrid'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { t } from '../../../../i18n'
import type { SqlQueryResult } from '../../api/dataConnectionsApi'

const result: SqlQueryResult = {
  columns: [{ index: 0, name: 'id', dataType: 'bigint' }, { index: 1, name: 'id', dataType: 'numeric' }],
  rows: [[{ kind: 'bigint', value: '9007199254740993' }, { kind: 'decimal', value: '0.000000000000001' }]],
  rowCount: 1, byteCount: 97, durationMs: 12, truncated: true,
}
afterEach(() => { cleanup(); useSettingsStore.setState({ locale: 'en' }) })

describe('M10 result grid localization', () => {
  it.each([
    ['en', 'rows', 'bytes', 'ms'],
    ['zh', '行', '字节', '毫秒'],
    ['zh-TW', '列', '位元組', '毫秒'],
    ['jp', '行', 'バイト', 'ミリ秒'],
    ['kr', '행', '바이트', '밀리초'],
  ] as const)('renders result metadata in %s while retaining lossless values', (locale, rows, bytes, milliseconds) => {
    useSettingsStore.setState({ locale })
    render(<QueryResultGrid result={result} />)
    const grid = screen.getByTestId('sql-result-grid')
    expect(grid).toHaveTextContent(`1 ${rows}`)
    expect(grid).toHaveTextContent(`97 ${bytes}`)
    expect(grid).toHaveTextContent(`12 ${milliseconds}`)
    expect(grid).toHaveTextContent(t('managedResources.dataBrowser.truncated'))
    expect(grid).not.toHaveTextContent('managedResources.')
    expect(screen.getAllByRole('columnheader')).toHaveLength(2)
    expect(grid).toHaveTextContent('9007199254740993')
    expect(grid).toHaveTextContent('0.000000000000001')
  })
  it('clears the grid when no result is present', () => {
    const view = render(<QueryResultGrid result={result} />)
    view.rerender(<QueryResultGrid result={null} />)
    expect(screen.queryByTestId('sql-result-grid')).toBeNull()
  })
})
