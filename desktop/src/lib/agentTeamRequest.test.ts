import { describe, expect, it } from 'vitest'
import { extractRestoredUserDisplay } from '@/stores/chatStore'
import {
  AGENT_TEAM_REQUEST_INSTRUCTION,
  isAntigravitySwarmRequest,
  stripAgentTeamRequest,
  withAgentTeamRequest,
  withAntigravitySwarmRequest,
} from './agentTeamRequest'

describe('agent team request', () => {
  it('puts the team instruction in front of the message and takes it off again', () => {
    const sent = withAgentTeamRequest('Ship the release checklist')
    expect(sent).toContain(AGENT_TEAM_REQUEST_INSTRUCTION)
    expect(sent.endsWith('\n\nShip the release checklist')).toBe(true)
    expect(stripAgentTeamRequest(sent)).toEqual({ content: 'Ship the release checklist', requested: true })
  })

  it('leaves ordinary messages, and a user quoting the tag, untouched', () => {
    expect(stripAgentTeamRequest('plain text')).toEqual({ content: 'plain text', requested: false })
    const quoted = 'Why does <agent-team-request> show up in logs?'
    expect(stripAgentTeamRequest(quoted)).toEqual({ content: quoted, requested: false })
  })

  it('shows only the typed text when a team request is restored from history', () => {
    const sent = withAgentTeamRequest('Ship the release checklist')
    expect(extractRestoredUserDisplay(sent)).toMatchObject({
      content: 'Ship the release checklist',
      modelContent: sent,
    })
  })

  it('keeps file references after the team block when restoring', () => {
    const sent = withAgentTeamRequest('@"/repo/README.md" summarize this')
    const restored = extractRestoredUserDisplay(sent)
    expect(restored.content).not.toContain('agent-team-request')
    expect(restored.content).not.toContain(AGENT_TEAM_REQUEST_INSTRUCTION)
    expect(restored.modelContent).toBe(sent)
  })

  it('formats Antigravity swarm requests as /swarm without double-prefixing', () => {
    expect(withAntigravitySwarmRequest('Audit the repository')).toBe('/swarm Audit the repository')
    expect(withAntigravitySwarmRequest('  /swarm Audit the repository  ')).toBe('/swarm Audit the repository')
    expect(withAntigravitySwarmRequest('/SWARM\nReview PR')).toBe('/SWARM\nReview PR')
    expect(withAntigravitySwarmRequest('/swarm')).toBe('/swarm')
    expect(withAntigravitySwarmRequest('   ')).toBe('/swarm')
    expect(withAntigravitySwarmRequest('/swarming check')).toBe('/swarm /swarming check')

    expect(isAntigravitySwarmRequest('/swarm hello')).toBe(true)
    expect(isAntigravitySwarmRequest('/swarm')).toBe(true)
    expect(isAntigravitySwarmRequest('/swarming')).toBe(false)
    expect(isAntigravitySwarmRequest('hello')).toBe(false)
  })
})
