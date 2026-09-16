import { describe, expect, test } from 'bun:test'

import { buildPlatformComputerUseTools } from './mcpServer.js'
import { buildComputerUseTools } from './tools.js'

/**
 * Cross-provider portability rules for the Computer Use tool schemas.
 *
 * These tools are handed verbatim to whichever model the user configured, and
 * providers validate tool schemas with wildly different strictness. A schema
 * that is valid JSON Schema but unusual can be rejected outright — and the
 * failure is a hard HTTP 400 that kills every Computer Use call on that
 * provider, while other providers accept the exact same schema. That asymmetry
 * makes it very easy to ship and only find out from one user on one model.
 *
 * So: keep the schemas boring.
 */

const PLATFORMS = ['darwin', 'win32'] as const

function allTools() {
  return PLATFORMS.flatMap(platform =>
    buildPlatformComputerUseTools(
      { screenshotFiltering: 'native', platform },
      'pixels',
    ).map(tool => ({ platform, tool })),
  )
}

describe('computer use tool schema portability', () => {
  test('no tool puts anyOf/oneOf at the schema root', () => {
    // Regression, observed in production against Grok 4.5:
    //   Grok upstream returned HTTP 400:
    //   "mcp__computer-use__click: tool parameter root must be an object type
    //    (root schema is an anyOf/oneOf union with a non-object branch)"
    //
    // `click`, `scroll` and `drag` expressed "element_index OR (x, y)" as
    // `anyOf: [{required:[…]}, {required:[…]}]`. That IS valid JSON Schema —
    // a branch with only `required` constrains objects — but Grok requires each
    // branch to spell out `type: "object"` and refuses the tool otherwise.
    // Anthropic and Kimi accepted it, which is exactly why this needs a test
    // rather than a code review.
    //
    // The argument rules are enforced at call time instead (toolCalls.ts), so
    // dropping the union costs nothing: the runtime still fails closed.
    const offenders = allTools()
      .filter(({ tool }) => {
        const schema = tool.inputSchema as Record<string, unknown>
        return 'anyOf' in schema || 'oneOf' in schema || 'allOf' in schema
      })
      .map(({ platform, tool }) => `${platform}:${tool.name}`)

    expect(offenders).toEqual([])
  })

  test('every tool root is a plain object schema', () => {
    for (const { platform, tool } of allTools()) {
      const schema = tool.inputSchema as Record<string, unknown>
      expect(`${platform}:${tool.name}:${String(schema.type)}`).toBe(
        `${platform}:${tool.name}:object`,
      )
      expect(typeof schema.properties).toBe('object')
    }
  })

  test('nested property schemas stay free of root-style unions too', () => {
    // A union one level down (e.g. inside `drag.from`) is likelier to be
    // tolerated, but the same strictness gradient applies, and we have no
    // reason to need one.
    const offenders: string[] = []
    for (const { platform, tool } of allTools()) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
      for (const [name, raw] of Object.entries(properties)) {
        const property = raw as Record<string, unknown>
        if ('anyOf' in property || 'oneOf' in property || 'allOf' in property) {
          offenders.push(`${platform}:${tool.name}.${name}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('the documented argument rules survive losing the schema union', () => {
    // Deleting `anyOf` only stays safe while the description still tells the
    // model what the alternatives are — that text is now the ONLY hint it gets
    // before the call, so it must not be silently trimmed later.
    //
    // darwin only: `element_index` is the AX engine's vocabulary. The Windows
    // path still ships the legacy pixel tools, which share these tool NAMES but
    // take coordinates alone — so keying by name across both platforms would
    // silently assert against whichever came last.
    const darwinTools = new Map(
      buildComputerUseTools(
        { screenshotFiltering: 'native', platform: 'darwin' },
        'pixels',
      ).map(tool => [tool.name, tool]),
    )

    expect(darwinTools.get('click')?.description).toContain('element_index OR both x and y')
    expect(darwinTools.get('scroll')?.description).toContain('element_index')
    expect(darwinTools.get('drag')?.description?.length ?? 0).toBeGreaterThan(0)
  })
})
