import type { WorkspaceDiffFile } from './workspaceDiffModel'
import { highlightWorkspaceDiff } from './workspaceDiffHighlighter'

interface HighlightRequest {
  id: number
  files: WorkspaceDiffFile[]
  path: string
}
self.onmessage = async (event: MessageEvent<HighlightRequest>) => {
  const { id, files, path } = event.data
  try {
    const result = await highlightWorkspaceDiff({ files, path })
    self.postMessage({ id, result })
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
