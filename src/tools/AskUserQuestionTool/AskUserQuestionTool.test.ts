import { describe, expect, test } from 'bun:test'
import { AskUserQuestionTool, type Output } from './AskUserQuestionTool.js'

const question = {
  question: 'What should I do next?',
  header: 'Next step',
  options: [
    { label: 'Continue', description: 'Proceed with the task' },
    { label: 'Pause', description: 'Stop and wait' },
  ],
  multiSelect: false,
}

describe('AskUserQuestion tool result guidance', () => {
  test('removes model-supplied automatic provenance before permission review', async () => {
    const parsed = AskUserQuestionTool.inputSchema.parse({
      questions: [question],
      metadata: { source: 'remember', autoAnswered: true },
    })
    const permission = await AskUserQuestionTool.checkPermissions(parsed, {} as never)
    expect(permission.updatedInput?.metadata).toEqual({ source: 'remember' })
  })

  test('records automatic selection provenance from the permission input', async () => {
    const result = await AskUserQuestionTool.call({
      questions: [question],
      answers: { [question.question]: 'Continue' },
      metadata: { source: 'remember', autoAnswered: true },
    } as never, {} as never)

    expect(result.data.selectionSource).toBe('automatic')
  })

  test('keeps the concise continuation guidance for a predefined option', () => {
    const result = mapResult({
      questions: [question],
      answers: { [question.question]: 'Continue' },
    })

    expect(result.content).toContain('You can now continue')
  })

  test('uses neutral guidance when the user gives a free-text instruction', () => {
    const result = mapResult({
      questions: [question],
      answers: {
        [question.question]: 'Wait. Explain the risks before doing anything.',
      },
    })

    expect(result.content).not.toContain('You can now continue')
    expect(result.content).toContain('may require that you pause')
  })

  test('uses neutral guidance when a predefined option has user notes', () => {
    const result = mapResult({
      questions: [question],
      answers: { [question.question]: 'Continue' },
      annotations: {
        [question.question]: {
          notes: 'Explain the risks first.',
        },
      },
    })

    expect(result.content).not.toContain('You can now continue')
    expect(result.content).toContain('may require that you pause')
  })

  test('uses neutral guidance when not every question was answered', () => {
    const secondQuestion = {
      ...question,
      question: 'Where should I continue?',
      header: 'Scope',
    }
    const result = mapResult({
      questions: [question, secondQuestion],
      answers: { [question.question]: 'Continue' },
    })

    expect(result.content).not.toContain('You can now continue')
    expect(result.content).toContain('may require that you pause')
  })

  test('identifies timeout choices as automatic rather than user answers', () => {
    const result = mapResult({
      questions: [question],
      answers: { [question.question]: 'Continue' },
      selectionSource: 'automatic',
    })

    expect(result.content).toContain('selected automatically after the timeout')
    expect(result.content).toContain('not direct user input')
    expect(result.content).not.toContain('User has answered')
  })
})

function mapResult(output: Output) {
  return AskUserQuestionTool.mapToolResultToToolResultBlockParam(
    output,
    'tool-use-id',
  )
}
