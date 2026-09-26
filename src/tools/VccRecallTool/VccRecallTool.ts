import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getTranscriptPath } from '../../utils/sessionStorage.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { loadCcSessionFile } from '../../services/compact/vcc/recallLoader.js'
import { expandCcEntryFile } from '../../services/compact/vcc/recallDrillDown.js'
import { parseDrillDown } from '../../services/compact/vcc/vendor/core/drill-down.js'
import {
  getTouchedFiles,
  searchEntriesDetailed,
  type SearchHit,
} from '../../services/compact/vcc/vendor/core/search-entries.js'
import {
  formatRecallOutput,
  formatTouchedOutput,
} from '../../services/compact/vcc/vendor/core/format-recall.js'
import { normalizeRecallMode } from '../../services/compact/vcc/vendor/core/recall-scope.js'
import {
  DESCRIPTION,
  PROMPT,
  VCC_RECALL_TOOL_NAME,
} from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z
      .string()
      .optional()
      .describe(
        "What to recall, in plain keywords (e.g. 'redis cache decision'). Multi-word queries are ranked by relevance. A regex pattern also works. A #N:path query drills into a file's content from an entry.",
      ),
    expand: z
      .array(z.number())
      .optional()
      .describe('Entry indices (#N) to return full untruncated content for'),
    page: z
      .number()
      .optional()
      .describe('Page number (1-based) for paginated results. Default: 1.'),
    mode: z
      .enum(['hybrid', 'touched'])
      .optional()
      .describe(
        "What to show. hybrid (default) = normal search; touched = aggregated files-by-path with entry indices.",
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    text: z.string().describe('The recall result text'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

const DEFAULT_RECENT = 25
const PAGE_SIZE = 5

export const VccRecallTool = buildTool({
  name: VCC_RECALL_TOOL_NAME,
  searchHint: 'recall earlier parts of this session dropped by compaction',
  maxResultSizeChars: 100_000,
  userFacingName() {
    return 'VCC Recall'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.query ?? ''
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.text,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call({ query, expand, page, mode }) {
    const sessionFile = getTranscriptPath()
    const loaded = loadCcSessionFile(sessionFile, false)
    if (!loaded) {
      return { data: { text: 'No session file available.' } }
    }
    const { rendered, rawMessages, byIndex } = loaded

    // Drill-down: #N:path resolves to file-scoped tool content. Anchored so
    // inline mentions like "see #42:auth.ts" are never treated as drill-down.
    const q = query?.trim()
    if (q && parseDrillDown(q)) {
      const parsed = parseDrillDown(q)!
      const text = expandCcEntryFile(
        byIndex,
        parsed.index,
        parsed.pathPattern,
        parsed.full,
        parsed.offset,
        parsed.limit,
      )
      return { data: { text } }
    }

    // touched mode: aggregate file operations across the session.
    if (normalizeRecallMode(mode) === 'touched') {
      const touched = getTouchedFiles(rawMessages, rendered)
      return { data: { text: formatTouchedOutput(touched, page) } }
    }

    // expand: return full untruncated content for the requested #N.
    if (expand && expand.length > 0) {
      const fullLoaded = loadCcSessionFile(sessionFile, true)
      const byN = new Map<number, SearchHit>()
      if (fullLoaded)
        for (const e of fullLoaded.rendered) byN.set(e.index, e)
      const invalid = expand.filter(
        (i) => !Number.isInteger(i) || !byN.has(i),
      )
      if (invalid.length > 0) {
        return {
          data: {
            text: `Cannot expand indices outside session history: ${invalid.join(', ')}`,
          },
        }
      }
      const expanded = expand
        .map((i) => byN.get(i))
        .filter((m): m is SearchHit => Boolean(m))
      return { data: { text: formatRecallOutput(expanded) } }
    }

    // query search with pagination.
    if (q) {
      const { hits, totalBeforeCap, truncated } = searchEntriesDetailed(
        rendered,
        rawMessages,
        q,
      )
      const pageNum = Math.max(1, page ?? 1)
      const totalPages = Math.ceil(hits.length / PAGE_SIZE)
      const truncationNote = truncated
        ? ` — showing ${hits.length} of ${totalBeforeCap} matches, refine your query for more precise results`
        : ''

      if (hits.length > 0 && pageNum > totalPages) {
        const guidance = truncated
          ? `Use a page between 1 and ${totalPages}.`
          : `Use a page between 1 and ${totalPages}, or refine your query.`
        return {
          data: {
            text:
              `Page ${pageNum} is outside the available range 1-${totalPages} ` +
              `(${hits.length} matches${truncationNote}). ${guidance}`,
          },
        }
      }

      const start = (pageNum - 1) * PAGE_SIZE
      const pageResults = hits.slice(start, start + PAGE_SIZE)
      const header =
        totalPages > 1
          ? `Page ${pageNum}/${totalPages} (${hits.length} total matches${truncationNote})`
          : `${hits.length} matches${truncationNote}`
      const footer =
        pageNum < totalPages ? `\n--- Use page:${pageNum + 1} for more results ---` : ''
      const text = formatRecallOutput(pageResults, q, header) + footer
      return { data: { text } }
    }

    // No query: most recent entries.
    return {
      data: {
        text: formatRecallOutput(
          rendered.slice(-DEFAULT_RECENT),
          undefined,
        ),
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
