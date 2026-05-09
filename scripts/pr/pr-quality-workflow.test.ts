import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('PR quality workflow', () => {
  test('routes policy outputs into conditional check jobs', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')

    expect(workflow).toContain("if: needs.change-policy.outputs.desktop_checks == 'true'")
    expect(workflow).toContain("if: needs.change-policy.outputs.server_checks == 'true'")
    expect(workflow).toContain("if: needs.change-policy.outputs.adapter_checks == 'true'")
    expect(workflow).toContain("if: needs.change-policy.outputs.desktop_native_checks == 'true'")
    expect(workflow).toContain("if: needs.change-policy.outputs.docs_checks == 'true'")
    expect(workflow).toContain("if: needs.change-policy.outputs.coverage_checks == 'true'")
  })

  test('keeps coverage artifacts observable in CI', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')

    expect(workflow).toContain('COVERAGE_BASE_REF: origin/${{ github.base_ref }}')
    expect(workflow).toContain('cat "$latest_report" >> "$GITHUB_STEP_SUMMARY"')
    expect(workflow).toContain('uses: actions/upload-artifact@v4')
    expect(workflow).toContain('path: artifacts/coverage/')
    expect(workflow).toContain('retention-days: 14')
  })

  test('exposes a single required gate job for branch protection', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')

    expect(workflow).toContain('pr-quality-gate:')
    expect(workflow).toContain('name: pr-quality-gate')
    expect(workflow).toContain('if: always()')
    expect(workflow).toContain('require_success "change-policy" "${{ needs.change-policy.result }}"')
    expect(workflow).toContain('allow_skip_or_success "coverage-checks" "${{ needs.coverage-checks.result }}"')
  })
})
