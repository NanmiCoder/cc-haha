import { useCallback, useRef, useState, type KeyboardEvent } from 'react'

/**
 * The roving-tabindex tree, shared by the file tree and the review change tree.
 *
 * Both shipped with `tabIndex={-1}` on every row and nothing ever setting `0`,
 * which put the whole tree outside the tab order: a keyboard could not reach a
 * single row, let alone move between them. One element of a tree is tabbable at
 * a time and the arrow keys move it, so the pattern has to live in one place
 * rather than being re-derived per tree.
 */
export type RovingTreeRow = {
  path: string
  /** 0 for a root-level row. Rendered as `aria-level={depth + 1}`. */
  depth: number
  isDirectory: boolean
  expanded?: boolean
}

export type RovingTreeOptions<Row extends RovingTreeRow> = {
  /** The row the content area is showing; it owns the tab stop until a key moves it. */
  selectedPath?: string | null
  onActivate: (row: Row) => void
  onToggleDirectory?: (row: Row) => void
  /** Called before focusing a row so a virtualized tree can scroll it into the DOM. */
  onEnsureVisible?: (index: number) => void
}

export function useRovingTree<Row extends RovingTreeRow>(
  rows: readonly Row[],
  { selectedPath, onActivate, onToggleDirectory, onEnsureVisible }: RovingTreeOptions<Row>,
) {
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const nodes = useRef(new Map<string, HTMLElement>())
  const pendingFocusPath = useRef<string | null>(null)

  // A path that scrolled out of the visible set (a collapsed parent, a filter)
  // must not take the tab stop with it, or the tree becomes unreachable again.
  const activePath = rows.some((row) => row.path === focusedPath)
    ? focusedPath
    : rows.find((row) => row.path === selectedPath)?.path ?? rows[0]?.path ?? null

  const registerRow = useCallback((path: string) => (node: HTMLElement | null) => {
    if (node) {
      nodes.current.set(path, node)
      if (pendingFocusPath.current === path) {
        pendingFocusPath.current = null
        node.focus()
      }
    } else {
      nodes.current.delete(path)
    }
  }, [])

  const focusRow = useCallback((path: string, index?: number) => {
    setFocusedPath(path)
    const existing = nodes.current.get(path)
    if (existing) {
      pendingFocusPath.current = null
      existing.focus()
      return
    }
    if (index !== undefined) {
      pendingFocusPath.current = path
      onEnsureVisible?.(index)
    }
  }, [onEnsureVisible])

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLElement>, row: Row) => {
    const index = rows.findIndex((candidate) => candidate.path === row.path)
    if (index < 0) return

    const moveTo = (next: number) => {
      const clamped = Math.max(0, Math.min(rows.length - 1, next))
      const target = rows[clamped]
      if (!target) return
      event.preventDefault()
      focusRow(target.path, clamped)
    }

    switch (event.key) {
      case 'ArrowDown':
        moveTo(index + 1)
        break
      case 'ArrowUp':
        moveTo(index - 1)
        break
      case 'ArrowRight':
        if (row.isDirectory && !row.expanded) {
          event.preventDefault()
          onToggleDirectory?.(row)
        } else if (row.isDirectory) {
          // Already open: the next row is its first child, so Right descends.
          moveTo(index + 1)
        }
        break
      case 'ArrowLeft':
        if (row.isDirectory && row.expanded) {
          event.preventDefault()
          onToggleDirectory?.(row)
        } else {
          // Ascend: the nearest row above that is shallower is the parent.
          for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
            const candidate = rows[cursor]
            if (candidate && candidate.depth < row.depth) {
              moveTo(cursor)
              break
            }
          }
        }
        break
      case 'Home':
        moveTo(0)
        break
      case 'End':
        moveTo(rows.length - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        onActivate(row)
        break
      default:
        break
    }
  }, [focusRow, onActivate, onToggleDirectory, rows])

  return { activePath, focusRow, handleKeyDown, registerRow, setFocusedPath }
}
