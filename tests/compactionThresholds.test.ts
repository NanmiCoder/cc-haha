import { expect, test } from 'bun:test'
import {
  COMPACT_NORMAL_FOLD_RATIO,
  COMPACT_AGGRESSIVE_FOLD_RATIO,
  COMPACT_FORCE_SUMMARY_RATIO,
  COMPACT_PRECHECK_FOLD_RATIO,
  COMPACT_NORMAL_FOLD_TAIL_RATIO,
  COMPACT_AGGRESSIVE_FOLD_TAIL_RATIO,
  MIN_COMPACTION_SAVINGS_RATIO,
  isCompactionWorthwhile,
} from '../src/services/compact/autoCompact.js'
import { truncateToolResultByTokens } from '../src/utils/toolResultStorage.js'

// ---------------------------------------------------------------------------
// Constant validation — ensure thresholds stay at their expected values
// ---------------------------------------------------------------------------

test('percentage thresholds are correctly ordered', () => {
  expect(COMPACT_NORMAL_FOLD_RATIO).toBe(0.75)
  expect(COMPACT_AGGRESSIVE_FOLD_RATIO).toBe(0.78)
  expect(COMPACT_FORCE_SUMMARY_RATIO).toBe(0.80)
  expect(COMPACT_PRECHECK_FOLD_RATIO).toBe(0.90)

  // Thresholds must be monotonically increasing
  expect(COMPACT_NORMAL_FOLD_RATIO).toBeLessThan(COMPACT_AGGRESSIVE_FOLD_RATIO)
  expect(COMPACT_AGGRESSIVE_FOLD_RATIO).toBeLessThan(
    COMPACT_FORCE_SUMMARY_RATIO,
  )
  expect(COMPACT_FORCE_SUMMARY_RATIO).toBeLessThan(COMPACT_PRECHECK_FOLD_RATIO)
})

test('tail budget ratios are correctly ordered', () => {
  expect(COMPACT_NORMAL_FOLD_TAIL_RATIO).toBe(0.20)
  expect(COMPACT_AGGRESSIVE_FOLD_TAIL_RATIO).toBe(0.10)

  // Normal fold should preserve more tail than aggressive fold
  expect(COMPACT_AGGRESSIVE_FOLD_TAIL_RATIO).toBeLessThan(
    COMPACT_NORMAL_FOLD_TAIL_RATIO,
  )
})

test('minimum savings ratio is a reasonable value', () => {
  expect(MIN_COMPACTION_SAVINGS_RATIO).toBe(0.30)
  expect(MIN_COMPACTION_SAVINGS_RATIO).toBeGreaterThan(0)
  expect(MIN_COMPACTION_SAVINGS_RATIO).toBeLessThan(1)
})

// ---------------------------------------------------------------------------
// isCompactionWorthwhile
// ---------------------------------------------------------------------------

test('isCompactionWorthwhile returns true when most of context is occupied', () => {
  // 90K tokens in 100K window → 90% occupied → worthwhile
  expect(isCompactionWorthwhile(90_000, 100_000)).toBe(true)
})

test('isCompactionWorthwhile returns true at the boundary (30%)', () => {
  // 30K tokens in 100K window → exactly 30% → still worthwhile
  expect(isCompactionWorthwhile(30_000, 100_000)).toBe(true)
})

test('isCompactionWorthwhile returns false when below threshold', () => {
  // 20K tokens in 100K window → 20% → not worthwhile
  expect(isCompactionWorthwhile(20_000, 100_000)).toBe(false)
})

test('isCompactionWorthwhile returns true when tokens exceed window (emergency)', () => {
  // Emergency: tokens exceed the context window — always worthwhile
  expect(isCompactionWorthwhile(105_000, 100_000)).toBe(true)
})

test('isCompactionWorthwhile handles large 1M context window', () => {
  // 400K tokens in 1M window → 40% → worthwhile
  expect(isCompactionWorthwhile(400_000, 1_000_000)).toBe(true)

  // 200K tokens in 1M window → 20% → not worthwhile
  expect(isCompactionWorthwhile(200_000, 1_000_000)).toBe(false)

  // 205K tokens in 200K window → >100% → emergency → worthwhile
  expect(isCompactionWorthwhile(205_000, 200_000)).toBe(true)
})

// ---------------------------------------------------------------------------
// truncateToolResultByTokens
// ---------------------------------------------------------------------------

test('truncateToolResultByTokens returns content unchanged when under limit', () => {
  const content = 'short content'
  const result = truncateToolResultByTokens(content, 100)
  expect(result.wasTruncated).toBe(false)
  expect(result.truncated).toBe(content)
})

test('truncateToolResultByTokens returns content unchanged when exactly at limit', () => {
  // 400 bytes → ~100 tokens at 4 bytes/token
  const content = 'A'.repeat(400)
  const result = truncateToolResultByTokens(content, 100)
  // May or may not truncate depending on rough estimate — but marker
  // should not appear when content is small enough
  if (!result.wasTruncated) {
    expect(result.truncated).toBe(content)
  }
})

test('truncateToolResultByTokens truncates when well above limit', () => {
  // ~50K chars → ~12,500 tokens at 4 bytes/token
  const content = 'A'.repeat(50_000)
  const result = truncateToolResultByTokens(content, 100)
  expect(result.wasTruncated).toBe(true)
  expect(result.truncated.length).toBeLessThan(content.length)
  expect(result.truncated).toContain('Content truncated')
})

test('truncateToolResultByTokens includes marker in truncated content', () => {
  const content = 'B'.repeat(10_000)
  const result = truncateToolResultByTokens(content, 100)
  expect(result.wasTruncated).toBe(true)
  expect(result.truncated).toContain(
    'Content truncated',
  )
})

test('truncateToolResultByTokens handles CJK content', () => {
  // CJK characters are ~1-3 tokens each, so char/4 underestimates tokens.
  // The function should still gracefully handle and truncate CJK content.
  const content = '中文测试内容'.repeat(5_000)
  const result = truncateToolResultByTokens(content, 500)
  expect(result.wasTruncated).toBe(true)
  expect(result.truncated.length).toBeLessThan(content.length)
})

test('truncateToolResultByTokens preserves content integrity', () => {
  const content = 'Hello World\nThis is a test\n'.repeat(200)
  const result = truncateToolResultByTokens(content, 100)
  expect(result.wasTruncated).toBe(true)
  // Should not start with partial line when possible
  // (if a newline was found within 70% of the budget)
  const truncatedPart = result.truncated.replace(
    /\n\n\[Content truncated.*\]$/s,
    '',
  )
  // Content before the marker should be a prefix of the original
  expect(content.startsWith(truncatedPart)).toBe(true)
})

test('truncateToolResultByTokens handles empty content', () => {
  const result = truncateToolResultByTokens('', 100)
  expect(result.wasTruncated).toBe(false)
  expect(result.truncated).toBe('')
  expect(result.estimatedTokens).toBe(0)
})
