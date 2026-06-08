import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export type RedteamReportFormat = 'markdown' | 'docx'
export type RedteamReportTemplate = 'default' | 'provided-docx'
export type RedteamScreenshotProfile =
  | 'packet-only'
  | 'browser-urlbar'
  | 'terminal'
  | 'burp-yakit'
export type RedteamCoverageProfile =
  | 'comprehensive'
  | 'web_app'
  | 'zhihu_web'
  | 'llm_app'
  | 'agent_supply_chain'
  | 'mobile_wechat'
  | 'ai_infra'

export type RedteamWorkflowRun = {
  sessionId: string
  target: string
  evidenceRoot: string
  evidenceRootWsl: string
  reportFormat: RedteamReportFormat
  reportTemplate: RedteamReportTemplate
  screenshotProfile: RedteamScreenshotProfile
  coverageProfile: RedteamCoverageProfile
  coverageOraclePath: string
  coverageOracleAvailable: boolean
  awaitingGate: boolean
  validationRequired: boolean
  needsRepair?: boolean
  observedSkills: string[]
  failedSkills: RedteamSkillFailure[]
  startedAt: string
}

export type RedteamSkillFailure = {
  skill: string
  reason: string
  observedAt: string
}

export type RedteamGuardResult = {
  content: string
  run: RedteamWorkflowRun | null
  injected: boolean
}

export type RedteamValidationResult = {
  ok: boolean
  errors: string[]
  statePath?: string
  evidenceRoot: string
  validatorOutput?: string
  validatorError?: string
  coverageOracleOutput?: string
  coverageOracleError?: string
}

const REDTEAM_CONTRACT_MARKER = 'CC_HAHA_REDTEAM_WORKFLOW_CONTRACT'
const activeRuns = new Map<string, RedteamWorkflowRun>()

export function prepareRedteamWorkflowPrompt(
  sessionId: string,
  content: string,
  workDir: string,
): RedteamGuardResult {
  if (content.includes(REDTEAM_CONTRACT_MARKER)) {
    return { content, run: activeRuns.get(sessionId) ?? null, injected: false }
  }

  const existingRun = activeRuns.get(sessionId)
  const detectedTarget = extractRedteamTarget(content)
  const hasRedteamIntent = looksLikeRedteamRequest(content)
  const isRedteamRequest = detectedTarget !== null && hasRedteamIntent
  const isPendingGateReply = existingRun?.awaitingGate === true
  const isGateFollowup =
    isPendingGateReply && isCompleteGateConfirmation(content)
  const isRepairFollowup =
    existingRun?.needsRepair === true && looksLikeWorkflowRepair(content)

  if (!isRedteamRequest && !isPendingGateReply && !isRepairFollowup) {
    return { content, run: existingRun ?? null, injected: false }
  }

  const target = detectedTarget ?? existingRun?.target ?? 'unknown-target'
  const reportFormat = inferReportFormat(content, existingRun?.reportFormat)
  const reportTemplate = inferReportTemplate(content, existingRun?.reportTemplate)
  const screenshotProfile = inferScreenshotProfile(content, existingRun?.screenshotProfile)
  const coverageProfile = inferCoverageProfile(content, target, existingRun?.coverageProfile)
  const coverageOraclePath = getCoverageOraclePath()
  const coverageOracleAvailable = fs.existsSync(coverageOraclePath)
  const gateComplete =
    isRepairFollowup ||
    (isPendingGateReply
      ? isGateFollowup
      : hasRequiredGateFields(content))
  const run =
    existingRun && existingRun.target === target
      ? {
          ...existingRun,
          reportFormat,
          reportTemplate,
          screenshotProfile,
          coverageProfile,
          coverageOraclePath,
          coverageOracleAvailable,
          awaitingGate: !gateComplete,
          validationRequired: gateComplete,
          needsRepair: false,
        }
      : createRun(
          sessionId,
          target,
          reportFormat,
          reportTemplate,
          screenshotProfile,
          coverageProfile,
          coverageOraclePath,
          coverageOracleAvailable,
          workDir,
          gateComplete,
        )

  activeRuns.set(sessionId, run)

  return {
    content: `${content.trim()}\n\n${buildContract(run)}`.trim(),
    run,
    injected: true,
  }
}

export async function validateRedteamWorkflowForSession(
  sessionId: string,
): Promise<RedteamValidationResult | null> {
  const run = activeRuns.get(sessionId)
  if (!run?.validationRequired) return null

  const root = run.evidenceRoot
  const preflightErrors: string[] = []
  if (!run.observedSkills.includes('redteam-commander')) {
    preflightErrors.push('redteam-commander tool call was not observed in the CLI stream')
  }
  for (const failure of run.failedSkills) {
    preflightErrors.push(`${failure.skill} failed before workflow completion: ${failure.reason}`)
  }
  if (!fs.existsSync(root)) {
    markRunNeedsRepair(sessionId, run)
    return {
      ok: false,
      evidenceRoot: root,
      errors: [
        ...preflightErrors,
        `evidence root was not created: ${root}`,
        'redteam-report was not proven to run because redteam_workflow_state.json is missing',
      ],
    }
  }

  const validator = getValidatorPath()
  if (!fs.existsSync(validator)) {
    markRunNeedsRepair(sessionId, run)
    return {
      ok: false,
      evidenceRoot: root,
      errors: [
        ...preflightErrors,
        `validator script does not exist: ${validator}`,
      ],
    }
  }

  const validation = await runValidator(validator, root, run.reportFormat)
  validation.errors = [...preflightErrors, ...validation.errors]
  validation.ok = validation.ok && preflightErrors.length === 0
  if (validation.ok) {
    const coverageValidation = await runCoverageOracleStrict(run)
    validation.errors = [...validation.errors, ...coverageValidation.errors]
    validation.ok = validation.ok && coverageValidation.ok
    validation.coverageOracleOutput = coverageValidation.output
    validation.coverageOracleError = coverageValidation.error
  }
  if (validation.ok) {
    activeRuns.set(sessionId, {
      ...run,
      validationRequired: false,
      awaitingGate: false,
      needsRepair: false,
    })
  } else {
    activeRuns.set(sessionId, {
      ...run,
      validationRequired: false,
      awaitingGate: false,
      needsRepair: true,
    })
  }
  return validation
}

export function formatRedteamConfirmationGate(run: RedteamWorkflowRun): string {
  return [
    '请确认执行选项：',
    '',
    `目标：${run.target}`,
    '',
    '执行模式：',
    '- 全自动 - 全程不停，完成后报告',
    '- 继续 - 每阶段暂停确认',
    '',
    '起始阶段：',
    '- 继续利用 - 从 Phase 4 开始（基于已有情报）',
    '- 重新扫描 - 从 Phase 1 重新开始全面测试',
    '',
    '报告格式：',
    '- Markdown - 快速报告',
    '- DOCX - 专业报告（可含真实截图；未采集时不伪造）',
    '',
    '报告模板：',
    '- 默认模板 - 使用内置红队报告结构',
    '- 参考DOCX模板 - 按用户提供的 Word 模板字段和章节适配',
    '',
    '报告出具公司：',
    '- 可选 - 未提供时使用“报告出具单位”占位，不继承参考模板旧公司名',
    '',
    '截图留证：',
    '- 暂不采集 - 默认，仅保留完整可复现数据包',
    '- 网页地址栏截图 - 浏览器页面截图需包含 URL 地址栏',
    '- 终端截图 - CMD/WSL 命令窗口截图',
    '- Burp/Yakit 发包截图 - 实验模式，优先保留原始数据包',
    '',
    '范围确认：',
    `- 授权范围：${run.target}`,
    '- 排除范围：未提供',
    '',
    '前置条件预检：',
    '- WSL/工具链：待检测（未执行命令前不能写“可用”）',
    '- Python/DOCX：待检测（未 import 检查前不能写“已安装”）',
    '- 浏览器截图：待检测（未实际调用前不能写“可用”）',
    '- 外部 API：待检测（未读取配置并连通前不能写“已配置”）',
    '',
    '如果以上无误，回复“确认/开始/OK”即可；如需修改，直接写修改项。',
  ].join('\n')
}

export function clearRedteamWorkflowSession(sessionId: string): void {
  activeRuns.delete(sessionId)
}

export function recordRedteamWorkflowCliMessage(sessionId: string, cliMsg: any): void {
  const record = (toolName: unknown, input?: unknown) => {
    const run = activeRuns.get(sessionId)
    if (!run) return
    const skillName = extractSkillName(toolName, input)
    if (!skillName) return
    if (run.observedSkills.includes(skillName)) return
    activeRuns.set(sessionId, {
      ...run,
      observedSkills: [...run.observedSkills, skillName],
    })
  }
  const recordFailure = (toolName: unknown, reasonText: unknown) => {
    const run = activeRuns.get(sessionId)
    if (!run) return
    const skillName = extractSkillName(toolName)
    if (!skillName) return
    const reason = extractRedteamFailureReason(reasonText)
    if (!reason) return
    const existing = run.failedSkills.some(
      (failure) => failure.skill === skillName && failure.reason === reason,
    )
    if (existing) return
    activeRuns.set(sessionId, {
      ...run,
      failedSkills: [
        ...run.failedSkills,
        { skill: skillName, reason, observedAt: new Date().toISOString() },
      ],
    })
  }

  const content = cliMsg?.message?.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'tool_use') {
        record(block.name, block.input)
      }
    }
  }

  const resultCommandName = cliMsg?.toolUseResult?.commandName
  if (typeof resultCommandName === 'string') {
    record(resultCommandName)
    recordFailure(resultCommandName, cliMsg.toolUseResult)
  }
}

function markRunNeedsRepair(sessionId: string, run: RedteamWorkflowRun): void {
  activeRuns.set(sessionId, {
    ...run,
    validationRequired: false,
    awaitingGate: false,
    needsRepair: true,
  })
}

function createRun(
  sessionId: string,
  target: string,
  reportFormat: RedteamReportFormat,
  reportTemplate: RedteamReportTemplate,
  screenshotProfile: RedteamScreenshotProfile,
  coverageProfile: RedteamCoverageProfile,
  coverageOraclePath: string,
  coverageOracleAvailable: boolean,
  workDir: string,
  gateComplete: boolean,
): RedteamWorkflowRun {
  const evidenceRoot = path.join(
    workDir || process.cwd(),
    `redteam_evidence_${sanitizeTarget(target)}_${timestampForPath()}`,
  )
  return {
    sessionId,
    target,
    evidenceRoot,
    evidenceRootWsl: windowsPathToWsl(evidenceRoot),
    reportFormat,
    reportTemplate,
    screenshotProfile,
    coverageProfile,
    coverageOraclePath,
    coverageOracleAvailable,
    awaitingGate: !gateComplete,
    validationRequired: gateComplete,
    needsRepair: false,
    observedSkills: [],
    failedSkills: [],
    startedAt: new Date().toISOString(),
  }
}

function extractSkillName(toolName: unknown, input?: unknown): string | null {
  if (toolName === 'Skill' && input && typeof input === 'object') {
    const skill = (input as { skill?: unknown }).skill
    return typeof skill === 'string' && skill.startsWith('redteam-')
      ? skill
      : null
  }

  if (typeof toolName === 'string' && toolName.startsWith('redteam-')) {
    return toolName
  }

  return null
}

function extractRedteamFailureReason(value: unknown): string | null {
  const text = stringifyForFailureScan(value)
  if (!text) return null

  const patterns = [
    /API Error:[^\n\r"]*/i,
    /Unable to connect to API[^\n\r"]*/i,
    /Unsupported parameter:[^\n\r"]*/i,
    /invalid_request_error[^\n\r"]*/i,
    /Connection error[^\n\r"]*/i,
    /ECONNRESET[^\n\r"]*/i,
    /ETIMEDOUT[^\n\r"]*/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)?.[0]
    if (match) return compactFailureReason(match)
  }
  return null
}

function stringifyForFailureScan(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value) return ''
  try {
    return JSON.stringify(value).slice(0, 8000)
  } catch {
    return String(value)
  }
}

function compactFailureReason(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240)
}

function buildContract(run: RedteamWorkflowRun): string {
  const validatorWindowsPath = getValidatorPath()
  const validatorWslPath = windowsPathToWsl(validatorWindowsPath)
  return `<${REDTEAM_CONTRACT_MARKER}>
This block is injected by cc-haha desktop after detecting a red-team workflow request. It is workflow control metadata, not user-facing report content.

Target: ${run.target}
Evidence root, Windows: ${run.evidenceRoot}
Evidence root, WSL: ${run.evidenceRootWsl}
Report format: ${run.reportFormat}
Report template: ${run.reportTemplate}
Screenshot profile: ${run.screenshotProfile}
Coverage profile: ${run.coverageProfile}
Coverage oracle, Windows: ${run.coverageOraclePath}
Coverage oracle, WSL: ${windowsPathToWsl(run.coverageOraclePath)}
Coverage oracle available: ${run.coverageOracleAvailable ? 'yes' : 'no'}
Gate state: ${run.awaitingGate ? 'pending confirmation' : 'confirmed'}

Mandatory behavior:
1. Use redteam-commander as the coordinator for this request.
2. If Gate state is pending confirmation, do not call tools, do not load skills, and do not probe files or network. Ask the configured execution-options checklist immediately and stop before scanning.
3. Once the gate is confirmed, create and maintain redteam_workflow_state.json under the evidence root above.
4. Each phase must record the skill it delegated to: redteam-recon, redteam-vulnscan, redteam-verify, and redteam-report.
5. Phase 5 must call redteam-report. Writing the final report inline from commander is incomplete.
   If Report template is provided-docx, redteam-report must use /mnt/c/Users/83964/.claude/skills/redteam-report/scripts/generate_template_inplace_docx_report.py or an equivalent template-in-place adapter. Do not copy the user's DOCX template and append current findings, because that can inherit old project text, stale findings, and unrelated embedded images.
   Provided-DOCX reports must use the reference DOCX as a style/layout mother document, preserve the original paragraph/table/chart positions, fill current evidence in place, use an ASCII output filename, write redteam_workflow_state.json.report.path as a relative path, and must not print the template file path/name, old project name, "(未脱敏)", "(不脱敏)", or "redaction: none" in public report prose.
   Provided-DOCX reports must replace/recalculate cover title, project/document metadata, creator, creation time, system name, target, test time, scope, vulnerability counts, finding detail tables, priority table, coverage ledger, and evidence index.
   Report issuer/company name is a variable. When known, pass it to the template adapter with --company-name or record it in redteam_workflow_state.json as top-level company_name or report_company; do not hardcode it. Treat report.company_name as output metadata, not a future input source. If the user does not explicitly provide a company name, use the neutral placeholder "报告出具单位"; do not inherit the reference template's old company name and do not default to any named vendor such as 天融信, 安恒, or 绿盟. Apply the resolved company to cover, overview, confidentiality, and copyright fields.
   The "测试分类 / 测试项 / 测试结果" summary table in the user's template must preserve the original test items and order. Clear stale old-template results, update matching rows from current evidence, and append only evidence-backed new rows when a discovered test item is absent from the original table. Do not replace the table wholesale, and do not mark unsupported checks as failed. Repaint result-cell color from the final value so stale template colors cannot leave "通过" red or "未通过" green.
   Missing evidence-backed matrix rows must be inserted inside the matching original category block, not appended near the end of the table. If the template uses a vertically merged category cell, inserted rows must continue that merge with a blank raw category cell, so Word does not render a repeated "Web 安全" / "业务逻辑安全" block. The validator rejects inserted Web/business rows after the server-security block, rejects inserted rows that are not merged into their category block, and rejects stale unsupported old-template failures such as hardcoded leakage, captcha defect, Fastjson, or database weak password when current evidence does not support them.
   Long scanner/header names must be shortened for the template matrix. Prefer report-friendly labels such as "HSTS头未配置", "来源策略头未配置", and "权限策略头未配置" rather than long English strings that wrap awkwardly in the narrow column. When a concrete finding has been added as its own row, do not also mark generic old-template rows such as "信息泄露" or "未授权访问" as failed unless the current evidence directly supports those generic rows.
   The vulnerability-count chart and surrounding prose must use the same severity-accounting rule: INFO / information items count as the first chart bucket, "无风险漏洞"; the other buckets are LOW, MEDIUM, HIGH, and CRITICAL. Do not exclude informational findings from the chart or describe them as a separate graph-external count. Prefer wording such as "无风险漏洞/信息项 N 个，低危风险/加固项 M 个，共计 X 个检测发现". The validator rejects DOCX reports whose first chart value does not equal the current informational finding count.
   The finding-table "风险描述" must be produced by a taxonomy-driven risk narrative layer such as /mnt/c/Users/83964/.claude/skills/redteam-report/scripts/risk_narrative_engine.py. Do not copy scanner proof, terse validation output, or "状态：可能风险" directly into the risk description. A valid risk narrative must include issue mechanism, verified condition, evidence boundary, impact or risk boundary, and business consequence; the validator rejects short/status-only/proof-only descriptions.
   Long responses may be excerpted in the public report, but the complete response file path must be recorded. Complete HTTP request packets must appear inside each finding table's "测试过程" field and remain available in packet files. In provided-DOCX reports, all report text including raw HTTP packets must use 宋体.
   Screenshot profile is presentation evidence only; full Burp-ready HTTP request/response packets remain the mandatory source of truth. For Windows GUI/address-bar screenshots, prefer capture_report_evidence.py --screenshot-mode native-fullscreen, which calls capture_windows_fullscreen.ps1 and is usable from cc-haha via PowerShell. Snipaste is a manual fallback, not the default automation path. Do not insert a screenshot that only shows a blank/loading/error page or does not prove the finding.
   Public report prose and finding titles must be Chinese. English is allowed only for protocol fields, raw packets, product names, CWE/CVSS/status tokens, file paths, or commands.
   Do not print visible "(未脱敏)" / "redaction: none" labels in the report body; keep redaction metadata in manifests and raw evidence.
   If report/packet_manifest.json contains legacy packets or lacks captures, redteam-report must run /mnt/c/Users/83964/.claude/skills/redteam-report/scripts/normalize_packet_manifest.py or the clean DOCX helper before validation.
   If screenshot profile is packet-only or screenshot capture is unavailable, the final DOCX must not contain inherited body screenshots or placeholder evidence images. Header/footer branding images from the template may remain.
6. Coverage oracle bridge is a hard workflow aid when the oracle is available:
   - The user-facing entrypoint is natural language red-team/pentest intent. Do not ask the user to run Python manually unless they request reproducibility commands.
   - On a new evidence root, initialize coverage ledgers with:
     python "${run.coverageOraclePath}" --root "${run.evidenceRoot}" --profile ${run.coverageProfile} --init-ledgers
   - After every meaningful tool output, input inventory update, self-created test object lifecycle update, proof attempt, packet capture, HAR capture, or report repair, run:
     python "${run.coverageOraclePath}" --root "${run.evidenceRoot}" --write --validate
   - Before claiming completion or final report readiness, run:
     python "${run.coverageOraclePath}" --root "${run.evidenceRoot}" --validate --strict
   - Read oracle artifacts in this order when choosing the next action: breakthrough_focus.md, taxonomy_gap_matrix.md, operator_action_router.md, operator_input_bundle_work_order.md, operator_execution_checklist.md, fingerprint_tool_lanes.md, discovery_execution_batches.md, candidate_proof_queue.md, candidate_seed_lineage.md, evidence_integrity.md.
   - Treat external tools such as dirsearch, nuclei, httpx, history URL search, schema inventory, JS/source-map extraction, exact code search, promptfoo, PyRIT, agent-scan, and AI-Infra-Guard as seed producers. Import their raw outputs, rerun the oracle, then prove candidate families with packet-backed attempts before reporting findings.
   - Use xray passive listen, including reverse/OAST checks, only as a late-stage authenticated traffic observation lane. First complete model-driven, logged-in, AI-simulated backend/admin workflow exploration with realistic clicks, forms, uploads, previews, exports, and other in-scope business actions; then route that operator-like traffic through xray listen if the scope and account state allow it. Do not run xray passive/OAST as first-pass discovery, because even passive probes can trigger lockouts, bans, noisy callbacks, or other risk controls. xray output remains candidate seed material until packet-backed proof, callback correlation, variants, cleanup, and final state evidence support a finding.
   - For path enumeration and brute-force-style discovery, identify target fingerprints first, then select the matching external tool profile, online lookup, or wordlist at runtime. Do not embed large path dictionaries or fallback payload banks in the prompt.
   - If the oracle reports high-yield pending actions, blocked concrete inputs, hidden critical candidate-family pressure, evidence gaps, or not_started method classes, continue testing or record the exact blocker instead of closing the workflow.
7. Runtime and command safety are hard requirements, not suggestions:
   - First probe the active shell. If it is Git Bash/MINGW, use Windows/Git-Bash paths such as /c/Users/... for local file operations, and call Ubuntu explicitly for Linux tools with wsl.exe -d Ubuntu --exec /bin/bash -lc '...'.
   - Never run nmap with default/broad port sets or without bounded timing. Every nmap command must include -Pn --max-retries 1 --host-timeout 45s and either an explicit -p list or --top-ports no greater than 100.
   - Prefer the already scoped common-port set first: -p 22,80,443,8080,8443,8888,8000,8008,9000,9090.
   - Phase 1 must run and preserve a quick port-state scan first. If service detection is needed, run -sV --version-light only as optional enrichment against already confirmed open ports; an -sV timeout must not overwrite or discard the quick scan evidence.
   - Do not generate Bash heredocs or inline multiline scripts in cc-haha live GUI. Forbidden patterns include python3 - <<, python - <<, node - <<, cat <<, and large python -c snippets. Use fixed helpers such as /mnt/c/Users/83964/.claude/skills/redteam-recon/scripts/safe_http_probe.py, /mnt/c/Users/83964/.claude/skills/redteam-recon/scripts/extract_frontend_assets.py, and /mnt/c/Users/83964/.claude/skills/redteam-recon/scripts/build_recon_summary.py with bounded timeouts and literal /mnt/c/... output paths.
   - Do not rely on transient shell variables such as E=... or $E for output paths in separate or parallel Bash calls. Use literal absolute /mnt/c/... paths in mkdir, redirects, nmap -oN/-oX, safe_http_probe --out-dir, report paths, and validator paths.
   - Do not emit parallel Bash tool calls from a redteam phase or forked subagent. Run one Bash command, wait for its result, then run the next. If a subagent emits multiple Bash calls in the same assistant turn and stops after their results return, retry that phase sequentially instead of waiting indefinitely.
   - If DNS or nmap output resolves the target to 198.18.0.0/15, treat that as local proxy/fake-IP routing evidence. Do not report nmap open ports or service banners from that address as real public exposure unless confirmed by HTTP/TLS application-layer packet evidence.
   - If redteam-commander or any phase skill returns API Error, Unable to connect to API, Unsupported parameter, invalid_request_error, Connection error, ECONNRESET, or ETIMEDOUT, stop and report the coordinator/subagent failure. Do not continue by manually composing a substitute workflow.
   - Do not use brute force, destructive writes to the target, denial of service, persistence, high concurrency, or out-of-scope assets.
8. Before saying the workflow is complete, run:
   python "${validatorWindowsPath}" --evidence-root "${run.evidenceRoot}" --report-format ${run.reportFormat}
   If running inside WSL, use:
   python3 "${validatorWslPath}" --evidence-root "${run.evidenceRootWsl}" --report-format ${run.reportFormat}
9. If validation fails, continue the missing phase or repair the ledger/report; do not claim completion.
</${REDTEAM_CONTRACT_MARKER}>`
}

function looksLikeRedteamRequest(content: string): boolean {
  return /红队|紅隊|渗透|滲透|安全测试|安全測試|安全评估|安全評估|pentest|red\s*team|vuln(?:erability)?\s*scan/i.test(content)
}

function extractRedteamTarget(content: string): string | null {
  const url = content.match(/https?:\/\/[^\s"'<>，。；、？！)）】》\]\u4e00-\u9fff]+/iu)?.[0]
  if (url) return url.replace(/[.,，。]+$/, '')

  const ip = content.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0]
  if (ip) return ip

  const domain = content.match(/\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/i)?.[0]
  return domain ?? null
}

function hasRequiredGateFields(content: string): boolean {
  const hasAuth = /授权|授權|确认.*(拥有|授權|授权)|確認.*(擁有|授權)|已获|已獲|scope|authorization/i.test(content)
  const hasMode = /执行模式|執行模式|全自动|全自動|full-auto|pause-each-phase|每阶段|每階段/i.test(content)
  const hasStart = /起始阶段|起始階段|重新扫描|重新掃描|继续利用|繼續利用|phase\s*[1-5]/i.test(content)
  const hasReport = /报告格式|報告格式|markdown|docx/i.test(content)
  const hasLimits = /限制|排除|不爆破|不破坏|不破壞|不高并发|不高併發|no brute force|no data destruction|no denial of service/i.test(content)
  return hasAuth && hasMode && hasStart && hasReport && hasLimits
}

function isCompleteGateConfirmation(content: string): boolean {
  const trimmed = content.trim()
  if (!trimmed) return false
  if (hasRequiredGateFields(trimmed)) return true
  if (/^(确认|確認|开始|開始|ok|OK|yes|Yes|可以|同意)[。.!！\s]*$/.test(trimmed)) {
    return true
  }
  return false
}

function looksLikeWorkflowRepair(content: string): boolean {
  return /继续.*(红队|报告|ledger|workflow|校验|验证)|修复.*(红队|报告|ledger|workflow|校验|验证)|补.*(报告|ledger|证据|验证)|redteam|red-team|red\s*team/i.test(content)
}

function inferReportFormat(
  content: string,
  fallback?: RedteamReportFormat,
): RedteamReportFormat {
  if (/docx|专业报告|專業報告|word/i.test(content)) return 'docx'
  if (/markdown|md|快速报告|快速報告/i.test(content)) return 'markdown'
  return fallback ?? 'markdown'
}

function inferReportTemplate(
  content: string,
  fallback?: RedteamReportTemplate,
): RedteamReportTemplate {
  if (/参考.*docx|docx.*模板|word.*模板|用户.*模板|黄金数智|template/i.test(content)) {
    return 'provided-docx'
  }
  if (/默认模板|内置模板|default/i.test(content)) return 'default'
  return fallback ?? 'default'
}

function inferScreenshotProfile(
  content: string,
  fallback?: RedteamScreenshotProfile,
): RedteamScreenshotProfile {
  if (/burp|yakit|发包截图|发包.*截图/i.test(content)) return 'burp-yakit'
  if (/地址栏|网页截图|浏览器截图|url.*bar|urlbar/i.test(content)) return 'browser-urlbar'
  if (/终端截图|cmd截图|linux截图|wsl截图|terminal/i.test(content)) return 'terminal'
  if (/暂不采集|不截图|无需截图|packet-only|只要.*数据包|数据包/i.test(content)) return 'packet-only'
  return fallback ?? 'packet-only'
}

function inferCoverageProfile(
  content: string,
  target: string,
  fallback?: RedteamCoverageProfile,
): RedteamCoverageProfile {
  const text = `${content}\n${target}`.toLowerCase()
  if (/comprehensive|full\s*coverage|all\s*methods|全面/.test(text)) return 'comprehensive'
  if (/wechat|weixin|微信|小程序|mini\s*program/.test(text)) return 'mobile_wechat'
  if (/zhihu|zhida|知乎|知答/.test(text)) return 'zhihu_web'
  if (/llm|prompt|jailbreak|rag|model|agentic|大模型|提示词|越狱/.test(text)) return 'llm_app'
  if (/mcp|agent|tool\s*use|skill\s*supply|supply\s*chain|智能体|工具调用|供应链/.test(text)) {
    return 'agent_supply_chain'
  }
  if (/mobile|android|ios|apk|ipa|移动端/.test(text)) return 'mobile_wechat'
  if (/ai\s*infra|gpu|k8s|kubernetes|model\s*server|inference|推理服务|模型服务/.test(text)) {
    return 'ai_infra'
  }
  return fallback ?? 'web_app'
}

function sanitizeTarget(target: string): string {
  const withoutScheme = target.replace(/^https?:\/\//i, '')
  const compact = withoutScheme.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return (compact || 'target').slice(0, 90)
}

function timestampForPath(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join('-') + `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function windowsPathToWsl(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  const drive = normalized.match(/^([a-zA-Z]):\/(.*)$/)
  if (!drive) return normalized
  return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]}`
}

function getValidatorPath(): string {
  return path.join(
    os.homedir(),
    '.claude',
    'skills',
    'redteam-commander',
    'scripts',
    'validate_redteam_workflow.py',
  )
}

function getCoverageOraclePath(): string {
  return process.env.CC_HAHA_COVERAGE_ORACLE_PATH || path.join(
    os.homedir(),
    '.codex',
    'skills',
    'codex-ai-redteam-coverage',
    'scripts',
    'coverage_oracle.py',
  )
}

async function runCoverageOracleStrict(
  run: RedteamWorkflowRun,
): Promise<{ ok: boolean; errors: string[]; output?: string; error?: string }> {
  const coverageProfilePath = path.join(run.evidenceRoot, 'coverage_profile.json')
  if (!fs.existsSync(coverageProfilePath)) {
    return { ok: true, errors: [] }
  }

  if (!run.coverageOracleAvailable || !fs.existsSync(run.coverageOraclePath)) {
    return {
      ok: false,
      errors: [
        `coverage oracle was initialized but the oracle script is unavailable: ${run.coverageOraclePath}`,
      ],
    }
  }

  const attempts: string[][] = [
    ['python', run.coverageOraclePath, '--root', run.evidenceRoot, '--validate', '--strict'],
    ['py', '-3', run.coverageOraclePath, '--root', run.evidenceRoot, '--validate', '--strict'],
  ]

  let lastOutput = ''
  let lastError = ''
  for (const command of attempts) {
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn(command, {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      })
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      continue
    }

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    lastOutput = stdout.trim()
    lastError = stderr.trim()

    if (exitCode === 0) {
      return { ok: true, errors: [], output: lastOutput, error: lastError || undefined }
    }
    if (lastOutput || lastError) break
  }

  return {
    ok: false,
    errors: [
      [
        'coverage oracle strict validation failed',
        lastOutput,
        lastError,
      ].filter(Boolean).join(': '),
    ],
    output: lastOutput || undefined,
    error: lastError || undefined,
  }
}

async function runValidator(
  validator: string,
  evidenceRoot: string,
  reportFormat: RedteamReportFormat,
): Promise<RedteamValidationResult> {
  const attempts: string[][] = [
    ['python', validator, '--evidence-root', evidenceRoot, '--report-format', reportFormat],
    ['py', '-3', validator, '--evidence-root', evidenceRoot, '--report-format', reportFormat],
  ]

  let lastError = ''
  for (const command of attempts) {
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn(command, {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      })
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      continue
    }

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    lastError = stderr.trim()

    if (exitCode === 0 || stdout.trim()) {
      return parseValidatorOutput(stdout, stderr, exitCode, evidenceRoot)
    }
  }

  return {
    ok: false,
    evidenceRoot,
    errors: [`failed to execute workflow validator: ${lastError || 'unknown error'}`],
    validatorError: lastError,
  }
}

function parseValidatorOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
  evidenceRoot: string,
): RedteamValidationResult {
  try {
    const parsed = JSON.parse(stdout) as {
      ok?: boolean
      errors?: string[]
      state_path?: string
    }
    return {
      ok: parsed.ok === true,
      evidenceRoot,
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      statePath: parsed.state_path,
      validatorOutput: stdout.trim(),
      validatorError: stderr.trim() || undefined,
    }
  } catch {
    return {
      ok: false,
      evidenceRoot,
      errors: [
        stdout.trim() ||
          stderr.trim() ||
          `validator did not return JSON (exit code ${exitCode})`,
      ],
      validatorOutput: stdout.trim() || undefined,
      validatorError: stderr.trim() || undefined,
    }
  }
}
