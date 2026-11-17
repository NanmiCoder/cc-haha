import { describe, expect, it } from 'vitest'
import {
  formatDuration,
  isNoOutputMarker,
  isShellTool,
  prepareShellOutput,
  resolveShellOutputKind,
  sanitizeShellOutput,
} from './ToolCallBlock'
import { toolCallDurationMs } from './ToolCallGroup'

describe('isShellTool', () => {
  it('covers both shell tools that carry a command input', () => {
    expect(isShellTool('Bash')).toBe(true)
    expect(isShellTool('PowerShell')).toBe(true)
  })

  it('excludes tools whose results are not command output', () => {
    for (const toolName of ['Read', 'Edit', 'Write', 'Grep', 'Agent']) {
      expect(isShellTool(toolName)).toBe(false)
    }
  })
})

describe('prepareShellOutput', () => {
  it('returns empty output for a command that printed nothing', () => {
    expect(prepareShellOutput('', false)).toEqual({
      visible: '',
      full: '',
      hiddenLines: 0,
      collapsible: false,
    })
  })

  it('treats whitespace-only output as empty', () => {
    expect(prepareShellOutput('\n\n   \n', false).visible).toBe('')
  })

  it('shows short output whole, with no toggle offered', () => {
    const result = prepareShellOutput('pypdf available\npdfplumber available', false)

    expect(result.visible).toBe('pypdf available\npdfplumber available')
    expect(result.hiddenLines).toBe(0)
    expect(result.collapsible).toBe(false)
  })

  it('keeps the head and reports the remainder when collapsed', () => {
    const text = Array.from({ length: 40 }, (_, index) => `line-${index + 1}`).join('\n')
    const result = prepareShellOutput(text, false)

    expect(result.visible).toBe(Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join('\n'))
    expect(result.hiddenLines).toBe(28)
    // `full` always carries everything so Copy yields the real output.
    expect(result.full).toBe(text)
  })

  it('reveals everything when expanded but STAYS collapsible', () => {
    const text = Array.from({ length: 40 }, (_, index) => `line-${index + 1}`).join('\n')
    const result = prepareShellOutput(text, true)

    expect(result.visible).toBe(text)
    expect(result.hiddenLines).toBe(0)
    // Regression guard: gating the toggle on hiddenLines alone made "Show less"
    // unreachable, because expanding unmounted the button that collapses it.
    expect(result.collapsible).toBe(true)
  })

  it('honours a custom collapsed window', () => {
    const text = 'a\nb\nc\nd\ne'

    expect(prepareShellOutput(text, false, 2)).toMatchObject({
      visible: 'a\nb',
      hiddenLines: 3,
    })
  })

  it('does not count a hidden line when output ends with a trailing newline', () => {
    // Shell output almost always ends in EOL; a naive split would report a
    // phantom extra line and offer a "1 more line" button revealing nothing.
    const result = prepareShellOutput('a\nb\n', false, 2)

    expect(result.visible).toBe('a\nb')
    expect(result.hiddenLines).toBe(0)
  })

  it('strips ANSI colour codes the desktop cannot render', () => {
    const result = prepareShellOutput('[32mpassed[0m', false)

    expect(result.visible).toBe('passed')
  })

})

describe('sanitizeShellOutput', () => {
  it('strips non-SGR CSI sequences, not just colours', () => {
    // Erase-line + cursor-up, as emitted by pip/npm progress rendering. Stripping
    // only the `m` colour codes left these to print as literal junk.
    expect(sanitizeShellOutput('[2K[1AReticulating')).toBe('Reticulating')
  })

  it('strips OSC window-title strings terminated by BEL or ST', () => {
    expect(sanitizeShellOutput(']0;my titledone')).toBe('done')
    expect(sanitizeShellOutput(']0;my title\\done')).toBe('done')
  })

  it('resolves carriage-return overwrites the way a terminal would', () => {
    // A progress line rewrites itself in place; only its final state is real.
    expect(sanitizeShellOutput('Downloading\r 10%\r100%')).toBe('100%')
  })

  it('normalises CRLF instead of leaving stray CRs', () => {
    expect(sanitizeShellOutput('line-1\r\nline-2\r\nline-3')).toBe('line-1\nline-2\nline-3')
  })

  it('leaves output without control characters untouched', () => {
    expect(sanitizeShellOutput('plain\noutput')).toBe('plain\noutput')
  })

  it('trims a long whitespace run in linear time', () => {
    // `.replace(/\s+$/, '')` backtracks catastrophically when the whitespace run
    // is NOT at the end — and BashTool's own "... [N lines truncated] ..." suffix
    // guarantees exactly that shape. Measured 318ms at the 30k Bash cap and 8.3s
    // at the 150k env ceiling; .trimEnd() is ~0.08ms.
    const pathological = ' '.repeat(30_000) + '... [12 lines truncated] ...'

    const started = performance.now()
    const result = sanitizeShellOutput(pathological)
    const elapsed = performance.now() - started

    expect(result).toBe(pathological.trimEnd())
    expect(elapsed).toBeLessThan(50)
  })

  it('trims thousands of blank lines in linear time', () => {
    // \s matches \n, so `yes '' | head -30000` hits the same path.
    const pathological = '\n'.repeat(30_000) + 'done'

    const started = performance.now()
    sanitizeShellOutput(pathological)

    expect(performance.now() - started).toBeLessThan(50)
  })
})

describe('prepareShellOutput on Windows line endings', () => {
  it('does not leave a dangling CR at the collapse boundary', () => {
    // Slicing to the nth \n kept the preceding \r, and CSS white-space:pre-wrap
    // treats a lone CR as a segment break — one extra blank line on Windows,
    // which is exactly the platform the #1149 reporter is on.
    const crlf = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join('\r\n')
    const result = prepareShellOutput(crlf, false, 3)

    expect(result.visible).toBe('line-1\nline-2\nline-3')
    expect(result.visible.endsWith('\r')).toBe(false)
    expect(result.hiddenLines).toBe(17)
  })
})

describe('isNoOutputMarker', () => {
  it('recognises the marker the CLI substitutes for empty results', () => {
    // src/utils/toolResultStorage.ts replaces empty content with this string, so
    // the desktop never actually receives '' (inc-4586).
    expect(isNoOutputMarker('(Bash completed with no output)', 'Bash')).toBe(true)
    expect(isNoOutputMarker('(PowerShell completed with no output)', 'PowerShell')).toBe(true)
  })

  it('tolerates surrounding whitespace', () => {
    expect(isNoOutputMarker('\n(Bash completed with no output)\n', 'Bash')).toBe(true)
  })

  it('does not match a different tool name', () => {
    expect(isNoOutputMarker('(Read completed with no output)', 'Bash')).toBe(false)
  })

  it('does not match real command output that merely mentions output', () => {
    expect(isNoOutputMarker('no output produced', 'Bash')).toBe(false)
  })
})

describe('resolveShellOutputKind', () => {
  it('reads the CLI no-output marker as empty', () => {
    expect(resolveShellOutputKind('(Bash completed with no output)', 'Bash')).toEqual({ kind: 'empty' })
  })

  it('treats a genuinely empty payload as empty', () => {
    expect(resolveShellOutputKind('', 'Bash')).toEqual({ kind: 'empty' })
    expect(resolveShellOutputKind(null, 'Bash')).toEqual({ kind: 'empty' })
    expect(resolveShellOutputKind([], 'Bash')).toEqual({ kind: 'empty' })
  })

  it('returns text for ordinary output', () => {
    expect(resolveShellOutputKind('pypdf available', 'Bash')).toEqual({
      kind: 'text',
      text: 'pypdf available',
    })
  })

  it('reads text blocks out of an array payload', () => {
    expect(resolveShellOutputKind([{ type: 'text', text: 'hello' }], 'Bash')).toEqual({
      kind: 'text',
      text: 'hello',
    })
  })

  it('marks an image-only result opaque rather than empty', () => {
    // extractTextContent flattens image blocks to '', which must NOT be reported
    // as "the command printed nothing".
    expect(resolveShellOutputKind([{ type: 'image', source: { data: 'x' } }], 'Bash')).toEqual({
      kind: 'opaque',
    })
  })

  it('treats output that sanitizes down to nothing as empty', () => {
    // A payload of pure control sequences leaves no renderable text.
    expect(resolveShellOutputKind('[2K[1A', 'Bash')).toEqual({ kind: 'empty' })
  })
})

describe('formatDuration', () => {
  it('renders sub-second durations in milliseconds', () => {
    expect(formatDuration(524)).toBe('524ms')
  })

  it('renders seconds with one decimal below ten seconds', () => {
    expect(formatDuration(1598)).toBe('1.6s')
  })

  it('drops the decimal once past ten seconds', () => {
    expect(formatDuration(27_000)).toBe('27s')
  })

  it('never emits an impossible seconds part', () => {
    // Math.floor(minutes) disagreed with Math.round(seconds % 60), printing
    // '1m60s' for 119.6s. Round once to whole seconds, then derive the parts.
    expect(formatDuration(119_600)).toBe('2m0s')
    expect(formatDuration(59_500)).toBe('1m0s')
  })

  it('does not keep a decimal after rounding up to ten seconds', () => {
    expect(formatDuration(9999)).toBe('10s')
  })

  it('promotes to hours instead of counting past sixty minutes', () => {
    expect(formatDuration(3_600_000)).toBe('1h0m')
  })

  it('switches to minutes for long commands', () => {
    expect(formatDuration(125_000)).toBe('2m5s')
  })
})

describe('toolCallDurationMs', () => {
  it('is undefined while the tool is still running', () => {
    expect(toolCallDurationMs({ timestamp: 1000 }, undefined)).toBeUndefined()
  })

  it('measures the gap between tool_use and tool_result', () => {
    expect(toolCallDurationMs({ timestamp: 1000 }, { timestamp: 1524 })).toBe(524)
  })

  it('discards a negative gap rather than rendering nonsense', () => {
    // Replayed / reordered transcripts can land a result before its call.
    expect(toolCallDurationMs({ timestamp: 2000 }, { timestamp: 1000 })).toBeUndefined()
  })

  it('prefers reported execution durationMs over batched streaming and serial queue timestamps (#1915)', () => {
    // 5 serial Edit calls emitted in one assistant turn: content_block_start was stamped at t=1000..1150,
    // StreamAssistantCommitBuffer held all blocks for ~1.6s, and results arrived 450ms apart,
    // while each Edit actually executed in ~220ms.
    const batchedEdits = [
      { callTs: 1000, resultTs: 2920, durationMs: 220 },
      { callTs: 1030, resultTs: 3370, durationMs: 215 },
      { callTs: 1060, resultTs: 3820, durationMs: 230 },
      { callTs: 1090, resultTs: 4270, durationMs: 205 },
      { callTs: 1120, resultTs: 4720, durationMs: 225 },
    ]
    expect(
      batchedEdits.map((item) =>
        toolCallDurationMs({ timestamp: item.callTs }, { timestamp: item.resultTs, durationMs: item.durationMs }),
      ),
    ).toEqual([220, 215, 230, 205, 225])

    // 0ms (e.g. fast validation or denied before execution) must not fall through to a multi-second dialog wait.
    expect(toolCallDurationMs({ timestamp: 1000 }, { timestamp: 15_000, durationMs: 0 })).toBe(0)

    // Invalid reported values fall back to legacy timestamp delta.
    expect(toolCallDurationMs({ timestamp: 1000 }, { timestamp: 1524, durationMs: Number.NaN })).toBe(524)
    expect(toolCallDurationMs({ timestamp: 1000 }, { timestamp: 1524, durationMs: -1 })).toBe(524)
  })
})
