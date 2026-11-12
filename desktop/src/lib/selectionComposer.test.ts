import { expect, it } from 'vitest'
import { buildSelectionBatchMessage, buildSelectionComposerText, buildSelectionDirectMessage } from './selectionComposer'

it('renders only the user instruction + concrete changes (no selector/DOM/page noise)', () => {
  const text = buildSelectionComposerText({
    pageUrl: 'http://127.0.0.1:4321/preview-fs/s1/index.html',
    sourceHint: 'index.html',
    element: { selector: '#title', tag: 'h1', text: 'Model not tuned yet', classes: [] } as never,
    change: { text: { from: 'Model not tuned yet', to: 'Model is tuned' }, description: 'Make the title more upbeat' } as never,
  })
  // The user's words and the concrete change are present
  expect(text).toContain('Make the title more upbeat')
  expect(text).toContain('Model is tuned')
  // DOM noise such as the selector or page URL is absent (the screenshot is the reference)
  expect(text).not.toContain('#title')
  expect(text).not.toContain('index.html')
})

it('returns empty text when there is no description or change (image alone is the reference)', () => {
  const text = buildSelectionComposerText({
    pageUrl: 'http://x/',
    element: { selector: '#t', tag: 'div', classes: [] } as never,
  })
  expect(text).toBe('')
})

it('builds a model prompt while keeping the visible selection label compact', () => {
  const message = buildSelectionDirectMessage({
    pageUrl: 'http://localhost:5174/',
    sourceHint: 'Todo preview',
    element: {
      selector: '#todo-title',
      tag: 'h1',
      text: 'Todo manager',
      classes: ['title'],
      boundingBox: { x: 10, y: 20, w: 300, h: 80 },
    } as never,
    change: { description: 'Make this title lighter' } as never,
  })

  expect(message.modelText).toContain('annotation numbered 1')
  expect(message.modelText).toContain('<h1>')
  expect(message.modelText).toContain('#todo-title')
  expect(message.modelText).toContain('Make this title lighter')
  expect(message.displayName).toBe('<h1>')
  expect(message.note).toBe('Make this title lighter')
})

it('builds one numbered model prompt for a batch of selections', () => {
  const message = buildSelectionBatchMessage([
    {
      id: 'one',
      number: 1,
      payload: {
        pageUrl: 'http://localhost:5174/',
        element: { selector: '#title', tag: 'h1', classes: [] } as never,
        change: { description: 'Lighter title' } as never,
      },
    },
    {
      id: 'three',
      number: 3,
      payload: {
        pageUrl: 'http://localhost:5174/',
        element: { selector: '#cta', tag: 'button', classes: [] } as never,
        change: { description: 'More prominent button' } as never,
      },
    },
  ])

  expect(message.modelText).toContain('[Element 1]')
  expect(message.modelText).toContain('[Element 3]')
  expect(message.modelText).not.toContain('[Element 2]')
  expect(message.modelText).toContain('Lighter title')
  expect(message.modelText).toContain('More prominent button')
  expect(message.items.map((item) => item.displayName)).toEqual(['<h1>', '<button>'])
})
