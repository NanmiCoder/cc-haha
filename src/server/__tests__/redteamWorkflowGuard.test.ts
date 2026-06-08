import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  clearRedteamWorkflowSession,
  formatRedteamConfirmationGate,
  prepareRedteamWorkflowPrompt,
  recordRedteamWorkflowCliMessage,
  validateRedteamWorkflowForSession,
} from '../services/redteamWorkflowGuard.js'

async function tempWorkDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'redteam-guard-'))
}

const modelMeta = {
  author_model: 'unit-test-model',
  provider: 'unit-test-provider',
  session_id: 'unit-test-session',
  source: 'model_generated',
}

async function writeJson(root: string, relPath: string, data: unknown) {
  const output = path.join(root, relPath)
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, JSON.stringify(data, null, 2), 'utf8')
}

async function writeJsonl(root: string, relPath: string, rows: unknown[]) {
  const output = path.join(root, relPath)
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
}

async function writeValidatorRequiredArtifacts(root: string, target: string) {
  const packetRel = 'report/http_packets/H-001.request.http'
  await fs.mkdir(path.dirname(path.join(root, packetRel)), { recursive: true })
  await fs.writeFile(
    path.join(root, packetRel),
    'GET /socket.io/?EIO=4&transport=polling HTTP/1.1\nHost: 43.143.205.232\n',
    'utf8',
  )

  await writeJson(root, 'model_provenance.json', {
    schema: 'cc-haha.redteam.model_provenance/v1',
    author_model: modelMeta.author_model,
    provider: modelMeta.provider,
    session_id: modelMeta.session_id,
    run_mode: 'single_model',
    created_at: '2026-06-08T00:00:00.000Z',
  })
  await writeJson(root, 'hypotheses.json', {
    meta: modelMeta,
    hypotheses: [{
      id: 'H-001',
      hypothesis: 'Socket.IO handshake metadata may be reachable without authentication.',
      rationale: 'The endpoint is exposed on the tested host.',
      priority: 'high',
      expected_impact: 'metadata exposure',
      test_strategy: 'Replay a bounded read-only handshake request.',
      mutation_strategy: 'No mutation; request-only validation.',
      why_priority: 'Potential unauthenticated service metadata exposure.',
    }],
  })
  await writeJson(root, 'tool_plan.json', {
    meta: modelMeta,
    actions: [{
      hypothesis_id: 'H-001',
      tool: 'curl',
      input: '/socket.io/?EIO=4&transport=polling',
      expected_evidence: packetRel,
      expected_signal: 'HTTP response proves reachability.',
      fallback_if_negative: 'Record false positive and close the hypothesis.',
      safety_limit: 'Read-only single request.',
    }],
  })
  await writeJson(root, 'coverage_ledger.json', {
    meta: modelMeta,
    rows: [{
      surface: 'Socket.IO handshake',
      status: 'CONFIRMED',
      evidence_paths: [packetRel],
    }],
  })
  await writeJson(root, 'findings.json', {
    meta: modelMeta,
    confirmed: [{
      id: 'F-001',
      hypothesis_id: 'H-001',
      evidence_paths: [packetRel],
      model_risk_description: 'The handshake endpoint is reachable without authentication.',
      model_impact_analysis: 'An attacker can observe service metadata and use it for follow-up targeting.',
      model_attack_chain_reasoning: 'The endpoint is a reconnaissance foothold, not destructive proof.',
      meta: modelMeta,
    }],
    informational: [],
    false_positives: [],
    unverified: [],
  })
  await writeJsonl(root, 'hypotheses.jsonl', [{
    ...modelMeta,
    id: 'H-001',
    hypothesis: 'Socket.IO handshake metadata may be reachable without authentication.',
    rationale: 'The endpoint is exposed on the tested host.',
    test_strategy: 'Replay a bounded read-only handshake request.',
    expected_impact: 'metadata exposure',
    mutation_strategy: 'No mutation.',
    why_priority: 'Potential unauthenticated metadata exposure.',
  }])
  await writeJsonl(root, 'tool_plan.jsonl', [{
    ...modelMeta,
    hypothesis_id: 'H-001',
    tool: 'curl',
    input: '/socket.io/?EIO=4&transport=polling',
    expected_evidence: packetRel,
    expected_signal: 'HTTP response proves reachability.',
    fallback_if_negative: 'Record false positive and close the hypothesis.',
    safety_limit: 'Read-only single request.',
  }])
  await writeJsonl(root, 'observations.jsonl', [{
    ...modelMeta,
    hypothesis_id: 'H-001',
    observation: 'The endpoint response was captured for validation.',
    evidence_paths: [packetRel],
    effect_on_hypothesis: 'supports confirmation',
  }])
  await writeJsonl(root, 'reasoning_updates.jsonl', [{
    ...modelMeta,
    hypothesis_id: 'H-001',
    evidence_that_changed_my_mind: packetRel,
    decision: 'confirmed',
    next_action: 'package finding in report',
  }])
  for (const relPath of [
    'phase1/recon_results.json',
    'phase2/vulnscan_results.json',
    'phase3/verify_results.json',
  ]) {
    await writeJson(root, relPath, { target, evidence_paths: [packetRel] })
  }
  await writeJson(root, 'report/model_report_lineage.json', {
    schema: 'cc-haha.redteam.report_lineage/v1',
    report: 'report/final.md',
    model: {
      author_model: modelMeta.author_model,
      provider: modelMeta.provider,
      session_id: modelMeta.session_id,
      run_mode: 'single_model',
    },
    artifacts: [
      'model_provenance.json',
      'hypotheses.jsonl',
      'tool_plan.jsonl',
      'observations.jsonl',
      'reasoning_updates.jsonl',
      'findings.json',
    ].map((artifactPath) => ({ path: artifactPath, exists: true })),
    finding_text_sources: [{ finding_id: 'F-001', source: 'model_owned' }],
  })
}

describe('redteam workflow guard', () => {
  it('does not inject ordinary prompts, URLs, IPs, or domains without redteam intent', async () => {
    const workDir = await tempWorkDir()

    for (const [sessionId, prompt] of [
      ['plain-session', 'hello'],
      ['url-session', '帮我总结 https://example.com 这篇文章'],
      ['ip-session', '记录一下 43.143.205.232 是我的服务器'],
      ['domain-session', '分析一下 example.com 的产品文案'],
    ] as const) {
      const result = prepareRedteamWorkflowPrompt(sessionId, prompt, workDir)
      expect(result.injected).toBe(false)
      expect(result.content).toBe(prompt)
      expect(result.run).toBeNull()
    }
  })

  it('arms a pending gate only when redteam intent and target are both present', async () => {
    const workDir = await tempWorkDir()
    const result = prepareRedteamWorkflowPrompt(
      'gate-session',
      '对 https://43.143.205.232/ 进行红队测试',
      workDir,
    )

    expect(result.injected).toBe(true)
    expect(result.run?.target).toBe('https://43.143.205.232/')
    expect(result.run?.awaitingGate).toBe(true)
    expect(result.run?.validationRequired).toBe(false)
    expect(result.content).toContain('CC_HAHA_REDTEAM_WORKFLOW_CONTRACT')
    expect(result.content).toContain('Gate state: pending confirmation')
    const gate = formatRedteamConfirmationGate(result.run!)
    expect(gate).toContain('报告模板：')
    expect(gate).toContain('截图留证：')
    expect(result.run?.reportTemplate).toBe('default')
    expect(result.run?.screenshotProfile).toBe('packet-only')

    clearRedteamWorkflowSession('gate-session')

    const noSpaceResult = prepareRedteamWorkflowPrompt(
      'gate-nospace-session',
      '对https://demo.owasp-juice.shop/进行红队测试',
      workDir,
    )
    expect(noSpaceResult.run?.target).toBe('https://demo.owasp-juice.shop/')
    clearRedteamWorkflowSession('gate-nospace-session')
  })

  it('does not treat ambiguous partial gate replies as confirmed', async () => {
    const workDir = await tempWorkDir()
    prepareRedteamWorkflowPrompt(
      'partial-gate-session',
      '对 https://43.143.205.232/ 进行红队测试',
      workDir,
    )

    for (const reply of ['继续', 'Markdown', 'Phase 1', '全自动']) {
      const result = prepareRedteamWorkflowPrompt('partial-gate-session', reply, workDir)
      expect(result.injected).toBe(true)
      expect(result.run?.awaitingGate).toBe(true)
      expect(result.run?.validationRequired).toBe(false)
      expect(result.content).toContain('Gate state: pending confirmation')
    }

    clearRedteamWorkflowSession('partial-gate-session')
  })

  it('turns an explicit short gate confirmation into a source-level validation requirement', async () => {
    const workDir = await tempWorkDir()
    prepareRedteamWorkflowPrompt(
      'confirmed-session',
      '对 https://43.143.205.232/ 进行红队测试',
      workDir,
    )

    const confirmed = prepareRedteamWorkflowPrompt(
      'confirmed-session',
      '确认',
      workDir,
    )
    const validation = await validateRedteamWorkflowForSession('confirmed-session')

    expect(confirmed.run?.awaitingGate).toBe(false)
    expect(confirmed.run?.validationRequired).toBe(true)
    expect(confirmed.content).toContain('redteam-report')
    expect(validation?.ok).toBe(false)
    expect(validation?.errors.join('\n')).toContain('redteam_workflow_state.json')

    clearRedteamWorkflowSession('confirmed-session')
  })

  it('records failed redteam skill results as validation errors', async () => {
    const workDir = await tempWorkDir()
    prepareRedteamWorkflowPrompt(
      'failed-skill-session',
      'red team test https://43.143.205.232/',
      workDir,
    )

    prepareRedteamWorkflowPrompt('failed-skill-session', 'OK', workDir)
    recordRedteamWorkflowCliMessage('failed-skill-session', {
      toolUseResult: {
        commandName: 'redteam-commander',
        result: 'API Error: Unable to connect to API. Check your internet connection',
      },
    })

    const validation = await validateRedteamWorkflowForSession('failed-skill-session')
    expect(validation?.ok).toBe(false)
    expect(validation?.errors.join('\n')).toContain(
      'redteam-commander failed before workflow completion',
    )

    clearRedteamWorkflowSession('failed-skill-session')
  })

  it('injects command-safety guidance for cc-haha WSL redteam runs', async () => {
    const workDir = await tempWorkDir()
    prepareRedteamWorkflowPrompt(
      'contract-session',
      'red team test https://43.143.205.232/',
      workDir,
    )

    const confirmed = prepareRedteamWorkflowPrompt(
      'contract-session',
      'OK',
      workDir,
    )
    expect(confirmed.content).toContain('quick port-state scan first')
    expect(confirmed.content).toContain('Do not rely on transient shell variables')
    expect(confirmed.content).toContain('Do not continue by manually composing a substitute workflow')
    expect(confirmed.content).toContain('Report template: default')
    expect(confirmed.content).toContain('Screenshot profile: packet-only')
    expect(confirmed.content).toContain('Public report prose and finding titles must be Chinese')

    clearRedteamWorkflowSession('contract-session')
  })

  it('injects coverage oracle bridge guidance for routed redteam runs', async () => {
    const workDir = await tempWorkDir()
    prepareRedteamWorkflowPrompt(
      'coverage-bridge-session',
      'red team test https://example.com/',
      workDir,
    )

    const confirmed = prepareRedteamWorkflowPrompt(
      'coverage-bridge-session',
      'OK',
      workDir,
    )
    expect(confirmed.run?.coverageProfile).toBe('web_app')
    expect(confirmed.content).toContain('Coverage oracle bridge')
    expect(confirmed.content).toContain('coverage_oracle.py')
    expect(confirmed.content).toContain('--init-ledgers')
    expect(confirmed.content).toContain('--write --validate')
    expect(confirmed.content).toContain('--validate --strict')
    expect(confirmed.content).toContain('breakthrough_focus.md')
    expect(confirmed.content).toContain('operator_action_router.md')
    expect(confirmed.content).toContain('fingerprint_tool_lanes.md')
    expect(confirmed.content).toContain('dirsearch')
    expect(confirmed.content).toContain('Do not embed large path dictionaries')
    expect(confirmed.content).toContain('Use xray passive listen')
    expect(confirmed.content).toContain('late-stage authenticated traffic observation')
    expect(confirmed.content).toContain('Do not run xray passive/OAST as first-pass discovery')

    clearRedteamWorkflowSession('coverage-bridge-session')
  })

  it('accepts a complete ledger and report as a valid source-level workflow', async () => {
    const workDir = await tempWorkDir()
    prepareRedteamWorkflowPrompt(
      'valid-session',
      '对 https://43.143.205.232/ 进行红队测试',
      workDir,
    )

    const confirmed = prepareRedteamWorkflowPrompt(
      'valid-session',
      '确认',
      workDir,
    )
    recordRedteamWorkflowCliMessage('valid-session', {
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Skill',
            input: { skill: 'redteam-commander' },
          },
        ],
      },
    })
    const evidenceRoot = confirmed.run?.evidenceRoot
    expect(evidenceRoot).toBeTruthy()

    const reportDir = path.join(evidenceRoot!, 'report')
    const reportPath = path.join(reportDir, 'final.md')
    await fs.mkdir(reportDir, { recursive: true })
    await fs.writeFile(
      reportPath,
      [
        '# Redteam Report',
        '## 1. 概要',
        'CONFIRMED finding summary.',
        '## 2. 目标信息',
        'Target details.',
        '## 3. 信息收集结果',
        'Recon evidence.',
        '## 4. 漏洞发现',
        'Confirmed and false-positive split.',
        '## 5. 风险汇总',
        'Risk table.',
        '## 6. 修复建议优先级',
        'Fix order.',
        '## 7. 测试方法论',
        'Methodology.',
      ].join('\n'),
      'utf8',
    )
    await writeValidatorRequiredArtifacts(evidenceRoot!, 'https://43.143.205.232/')
    await fs.writeFile(
      path.join(evidenceRoot!, 'redteam_workflow_state.json'),
      JSON.stringify(
        {
          target: 'https://43.143.205.232/',
          skills_invoked: [
            'redteam-recon',
            'redteam-vulnscan',
            'redteam-verify',
            'redteam-report',
          ],
          phases: {
            phase1: { skill: 'redteam-recon', status: 'complete' },
            phase2: { skill: 'redteam-vulnscan', status: 'complete' },
            phase3: { skill: 'redteam-verify', status: 'complete' },
            phase5: { skill: 'redteam-report', status: 'complete' },
          },
          coverage_ledger: [
            {
              surface: 'Socket.IO handshake',
              evidence: '/socket.io/?EIO=4&transport=polling',
              status: 'CONFIRMED',
            },
          ],
          report: {
            skill: 'redteam-report',
            path: 'report/final.md',
            format: 'markdown',
            lineage: 'report/model_report_lineage.json',
          },
          model_intelligence: {
            schema: 'cc-haha.redteam.model_intelligence/v1',
            validator_role: 'quality_floor_only',
            report_policy: 'model_fields_first_fallback_marked',
          },
        },
        null,
        2,
      ),
      'utf8',
    )

    const validation = await validateRedteamWorkflowForSession('valid-session')
    expect(validation?.ok).toBe(true)
    expect(validation?.errors).toEqual([])
    expect(await validateRedteamWorkflowForSession('valid-session')).toBeNull()

    clearRedteamWorkflowSession('valid-session')
  })
})
