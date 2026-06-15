const HTML_EXT = /\.(html?|xhtml)$/i
const INDEX_HTML_RE = /(^|\/)index\.html?$/i
const GENERATED_STATIC_FILES_DIR_RE = /(^|\/)[^/]+_files\/index\.html?$/i

const STATIC_OUTPUT_DIRS = new Set([
  'build',
  'coverage',
  'dist',
  'docs',
  'lcov-report',
  'out',
  'public',
  'site',
  'storybook-static',
])

/**
 * Files whose presence in the SAME change-set marks a buildable source project
 * (a framework scaffold). For such a project a root `index.html` is almost
 * always a build-tool template (`<script type="module" src="/src/main.tsx">`)
 * that renders blank when served statically — it needs a dev server — so we
 * route it to the workspace source view instead of a static browser preview.
 *
 * A hand-authored single-page `index.html` (the common "make me a todo page"
 * output) ships with no manifest alongside it, so it stays statically
 * previewable. This is the signal that lets us tell the two apart without
 * reading file contents.
 */
const PROJECT_MANIFEST_RE =
  /^(?:package\.json|(?:vite|next|nuxt|svelte|astro|remix|rollup|webpack|rsbuild|rspack|parcel|gatsby)\.config\.[cm]?[jt]s|angular\.json|deno\.jsonc?)$/i

function normalizePathForPolicy(filePath: string): string {
  return filePath
    .split(/[?#]/, 1)[0]!
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}

export function isHtmlFilePath(filePath: string): boolean {
  return HTML_EXT.test(normalizePathForPolicy(filePath))
}

function dirOfNormalized(normalizedPath: string): string {
  const slash = normalizedPath.lastIndexOf('/')
  return slash < 0 ? '' : normalizedPath.slice(0, slash)
}

/** True when `ancestorDir` is the same as, or a parent of, `dir`. */
function isAtOrAbove(ancestorDir: string, dir: string): boolean {
  if (ancestorDir === dir) return true
  return ancestorDir === '' || dir.startsWith(`${ancestorDir}/`)
}

/**
 * True when the change-set contains a project manifest sitting at or above the
 * `index.html`'s own directory — i.e. the html is the entry template of a real
 * buildable project rather than a standalone static page.
 */
function hasProjectManifestSibling(indexNormalizedPath: string, siblingFiles: string[]): boolean {
  const indexDir = dirOfNormalized(indexNormalizedPath)
  return siblingFiles.some((raw) => {
    const sibling = normalizePathForPolicy(raw)
    const name = sibling.slice(sibling.lastIndexOf('/') + 1)
    if (!PROJECT_MANIFEST_RE.test(name)) return false
    return isAtOrAbove(dirOfNormalized(sibling), indexDir)
  })
}

/**
 * Decide whether an html file should be offered as a static browser preview
 * (served as-is via `/preview-fs` or `/local-file`) versus the workspace source
 * view.
 *
 * Everything that is clearly a finished static artifact previews statically:
 * non-`index` pages (`todo.html`), generated `*_files/index.html` exports, and
 * anything under a build-output dir (`dist/`, `build/`, `out/`, …).
 *
 * A bare `index.html` is ambiguous from its path alone. When the caller can
 * supply the rest of the change-set via `opts.siblingFiles`, we treat the html
 * as a framework template (→ source view, not static preview) ONLY when a
 * project manifest (`package.json`, `vite.config.*`, …) accompanies it. Without
 * that signal we default to offering the static preview, so a hand-authored
 * single-page `index.html` is no longer mis-classified as a build template.
 */
export function shouldOfferStaticHtmlPreview(
  filePath: string,
  opts?: { siblingFiles?: string[] },
): boolean {
  const normalized = normalizePathForPolicy(filePath)
  if (!HTML_EXT.test(normalized)) return false
  if (GENERATED_STATIC_FILES_DIR_RE.test(normalized)) return true
  if (normalized.split('/').filter(Boolean).some((segment) => STATIC_OUTPUT_DIRS.has(segment.toLowerCase()))) {
    return true
  }
  if (!INDEX_HTML_RE.test(normalized)) return true
  if (opts?.siblingFiles && hasProjectManifestSibling(normalized, opts.siblingFiles)) {
    return false
  }
  return true
}
