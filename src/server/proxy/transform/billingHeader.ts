/**
 * Leading billing-attribution stripping for OpenAI-compatible transforms.
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

import { CLAUDE_CODE_BILLING_HEADER_PREFIX } from '../../../constants/claudeCodeCompatibility.js'

/**
 * Strip a leading Claude Code billing attribution line from system text.
 *
 * The CLI can prepend dynamic `x-anthropic-billing-header:` metadata to
 * `system`. Forwarding it into OpenAI Chat system messages or Responses
 * `instructions` rotates the prompt prefix on every request (the `cch=`
 * signature hashes the whole body), which defeats upstream prefix caching.
 * Only the leading occurrence is removed so user-authored prompt text that
 * happens to mention the header is kept.
 */
export function stripLeadingBillingHeader(text: string): string {
  if (!text.startsWith(CLAUDE_CODE_BILLING_HEADER_PREFIX)) return text

  const lineEnd = text.search(/[\r\n]/)
  if (lineEnd === -1) return ''

  let restStart = lineEnd + 1
  if (text[lineEnd] === '\r' && text[restStart] === '\n') restStart++

  // Also consume the blank separator line that usually follows the header.
  const rest = text.slice(restStart)
  if (rest.startsWith('\r\n')) return rest.slice(2)
  if (rest.startsWith('\n') || rest.startsWith('\r')) return rest.slice(1)
  return rest
}
