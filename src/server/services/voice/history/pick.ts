/**
 * One model call that picks vocabulary terms from locally counted candidates.
 * The request carries only the candidate words and their session counts.
 * Prompt from the benchmark's `llm_pick.py`, extended to group and flag terms.
 */

import type { VoiceHistoryCategory, VoiceHistoryGroup } from '../types.js'
import type { HistoryCandidate } from './scan.js'

export const HISTORY_PICK_SYSTEM_PROMPT = [
  '你在帮一个中文程序员整理语音输入法的个人词库。下面是从他和 AI 编程助手的对话里统计出的英文/拼写词，每行是「词<TAB>出现过的会话数」。',
  '请挑出最值得放进语音词库的词：产品名、项目名、模型名、公司名、框架/库/工具名、命令和代码标识符，以及中文语音识别容易听错的专有名词。',
  '不要选普通英文单词（如 commit、review、message、start 这类常用词除非是专有名词）。',
  '只能从列表里选，拼写必须和列表一致，只可以改成该词的标准大小写写法。最多 100 个，按重要程度排序。',
  '按类别分组：project 是项目和产品，model 是模型和厂商，tool 是代码、命令和工具，other 是其他。',
  '拿不准是不是专有名词的词把 doubtful 设为 true。',
  '只输出 JSON：{"groups":[{"category":"project|model|tool|other","terms":[{"term":"…","doubtful":false}]}]}',
].join('\n')

/** Room for 100 grouped `{"term","doubtful"}` objects. */
export const HISTORY_PICK_MAX_TOKENS = 4096
export const HISTORY_PICK_MAX_TERMS = 100

const CATEGORIES: readonly VoiceHistoryCategory[] = ['project', 'model', 'tool', 'other']
/** Fragments the local counter produces that are rarely proper nouns. */
const DOUBTFUL_WORDS = new Set(['e.g', 'i.e', 'etc', 'll', 'don', 'whats', 'dont'])

export function buildPickUserMessage(candidates: readonly HistoryCandidate[]): string {
  return candidates.map(candidate => `${candidate.term}\t${candidate.sessions}`).join('\n')
}

/** Local second opinion: very short mixed-case words, contractions and known fragments. */
export function isLocallyDoubtful(term: string): boolean {
  return ([...term].length <= 2 && term !== term.toUpperCase()) ||
    term.includes("'") ||
    DOUBTFUL_WORDS.has(term.toLowerCase())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const candidates = new Set<string>()
  const trimmed = text.trim()
  candidates.add(trimmed)
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]
  if (fenced) candidates.add(fenced.trim())
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.add(trimmed.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (isRecord(parsed)) return parsed
    } catch {
      // Try the next shape.
    }
  }
  return null
}

type PickedTerm = { term: string; doubtful: boolean }

function readTerms(value: unknown): PickedTerm[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): PickedTerm[] => {
    if (typeof item === 'string') return [{ term: item, doubtful: false }]
    if (isRecord(item) && typeof item.term === 'string') return [{ term: item.term, doubtful: item.doubtful === true }]
    return []
  })
}

/**
 * Reads the model's answer into groups. Only terms that are one of the
 * candidates (case-insensitively; the model's casing wins) survive, each once,
 * at most 100. Returns null when the answer holds no usable JSON at all.
 */
export function parsePickResponse(
  text: string,
  candidates: readonly HistoryCandidate[],
  known: ReadonlySet<string>,
): VoiceHistoryGroup[] | null {
  const parsed = parseJsonObject(text)
  if (!parsed) return null

  const rawGroups: Array<{ category: unknown; terms: unknown }> = Array.isArray(parsed.groups)
    ? parsed.groups.filter(isRecord).map(group => ({ category: group.category, terms: group.terms }))
    : Array.isArray(parsed.terms)
      ? [{ category: 'other', terms: parsed.terms }]
      : []
  if (rawGroups.length === 0 && !Array.isArray(parsed.groups)) return null

  const byKey = new Map(candidates.map(candidate => [candidate.term.toLowerCase(), candidate]))
  const seen = new Set<string>()
  const grouped = new Map<VoiceHistoryCategory, VoiceHistoryGroup>()
  let total = 0
  for (const group of rawGroups) {
    const category = CATEGORIES.includes(group.category as VoiceHistoryCategory)
      ? group.category as VoiceHistoryCategory
      : 'other'
    for (const picked of readTerms(group.terms)) {
      if (total >= HISTORY_PICK_MAX_TERMS) break
      const term = picked.term.trim()
      const key = term.toLowerCase()
      const candidate = byKey.get(key)
      if (!candidate || seen.has(key)) continue
      seen.add(key)
      total += 1
      let target = grouped.get(category)
      if (!target) grouped.set(category, target = { category, terms: [] })
      target.terms.push({
        term,
        sessions: candidate.sessions,
        doubtful: picked.doubtful || isLocallyDoubtful(term),
        inVocabulary: known.has(key),
      })
    }
  }
  return CATEGORIES.flatMap(category => grouped.get(category) ?? [])
}
