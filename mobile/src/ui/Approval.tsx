import { useState } from 'react'
import type { ApiClient } from '../core/client'
import type {
  ChatState,
  ClientMessage,
  PermissionRequest,
  RuntimeConfig,
} from '../core/types'
import { Card, Mono, useColors } from './kit'
import { Text } from './Text'
import { decisionResponse } from './approvalData'
import { PlanDecision } from './decision/PlanDecision'
import { PlanDocument } from './decision/PlanDocument'
import { MISSING_PLAN_TEXT, planFilePath, planSource } from './decision/planText'
import { QuestionDecision } from './decision/QuestionDecision'
import { ToolDecision, type ToolRespond } from './decision/ToolDecision'

const requestInput = (request: PermissionRequest) =>
  (request.input && typeof request.input === 'object'
    ? request.input
    : {}) as Record<string, unknown>

/** @deprecated 计划改由 Approval 的全屏计划页呈现；保留导出直到聊天页移除引用。 */
export function PlanPreview({ request }: { request: PermissionRequest }) {
  const colors = useColors()
  const input = requestInput(request)
  const text = planSource(input)
  const path = planFilePath(input)
  return (
    <Card style={{ padding: 18, gap: 12 }}>
      {text ? (
        <PlanDocument text={text} />
      ) : (
        <Text style={{ fontSize: 16, lineHeight: 25, color: colors.ink2 }}>{MISSING_PLAN_TEXT}</Text>
      )}
      {path ? (
        <Mono selectable style={{ fontSize: 12, color: colors.ink3 }}>
          {path}
        </Mono>
      ) : null}
    </Card>
  )
}

/**
 * “需要你决定”：普通工具审批、提问、计划三种底座。提交后保持“已提交”直到电脑回执；
 * 连接重建或服务端报错时恢复可操作，以便重试。
 */
export function Approval({
  request,
  send,
  ready,
  serverError,
  client,
  runtime,
  position,
  onStop,
  workDir,
}: {
  request: PermissionRequest
  send(message: ClientMessage): boolean
  ready: boolean
  serverError?: ChatState['error']
  client?: ApiClient | null
  runtime?: RuntimeConfig
  /** 多个审批排队时右上角显示“1 / 2”。 */
  position?: { index: number; total: number }
  /** “停止整个任务”；由调用方弹确认。 */
  onStop?(): void
  /** 会话工作目录，命令审批显示“在 ~/…”；拿不到时不显示。 */
  workDir?: string
}) {
  const input = requestInput(request)
  const [submission, setSubmission] = useState({
    ready,
    serverError,
    sent: false,
  })
  const sent =
    submission.ready === ready &&
    submission.serverError === serverError &&
    submission.sent
  if (submission.ready !== ready || submission.serverError !== serverError)
    setSubmission({ ready, serverError, sent: false })

  function respond(
    options: Omit<Parameters<typeof decisionResponse>[0], 'requestId' | 'toolName' | 'input'>
  ) {
    const accepted = send(
      decisionResponse({
        requestId: request.requestId,
        toolName: request.toolName,
        input,
        ...options,
      })
    )
    if (accepted) setSubmission({ ready, serverError, sent: true })
    return accepted
  }

  if (request.toolName === 'AskUserQuestion')
    return (
      <QuestionDecision
        request={request}
        input={input}
        ready={ready}
        sent={sent}
        signalActivity={() =>
          send({ type: 'ask_user_question_activity', requestId: request.requestId })
        }
        submit={(answers) => respond({ allowed: true, answers })}
        discuss={(note) => respond({ allowed: false, note })}
      />
    )

  if (request.toolName === 'ExitPlanMode')
    return (
      <PlanDecision
        input={input}
        ready={ready}
        sent={sent}
        serverError={serverError}
        client={client}
        runtime={runtime}
        position={position}
        approve={(plan) => respond({ allowed: true, plan })}
        revise={(note) => respond({ allowed: false, note })}
      />
    )

  const toolRespond: ToolRespond = (options) => respond(options)
  return (
    <ToolDecision
      request={request}
      input={input}
      ready={ready}
      sent={sent}
      respond={toolRespond}
      position={position}
      onStop={onStop}
      workDir={workDir}
    />
  )
}
