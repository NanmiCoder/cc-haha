export const VCC_RECALL_TOOL_NAME = 'vcc_recall'

export const DESCRIPTION = `Recall earlier parts of the current session — decisions made, files touched, commands run, including anything dropped by context compaction. Reach for this before telling the user you no longer have the context. Plain keywords work best; a regex pattern is also accepted. Results are paged (page); pass expand with entry indices to read full untruncated content. Use mode:'touched' to list files worked on in this session with their entry indices, and #N:path to drill into a file's content from an entry (#N:path:full for all lines, #N:path:offset:limit to page). Note: apply_patch-style multi-file edits and bash redirects do not appear in the touched index. Only the current session is searchable — earlier sessions are not.`

export const PROMPT =
  'vcc_recall: recall earlier parts of this session before saying the context is gone. ' +
  "Plain keywords work best. mode:'touched' lists files worked on with their #N indices; " +
  "#N:path drills into a file's content from an entry (#N:path:full for all lines, " +
  '#N:path:offset:limit to page); page advances through search results; ' +
  'expand reads a specific #N in full.'