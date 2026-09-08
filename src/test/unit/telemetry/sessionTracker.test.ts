import { expect } from 'chai'

import {
  activeSessionCount,
  endSession,
  getSession,
  resetSessionsForTest,
  startSession
} from '../../../telemetry/sessionTracker.js'
import { counterValue, histogramCount } from '../../utils/hooks.js'

const CLIENT = { clientName: 'test-client', clientVersion: '1.0.0' }

describe('telemetry/sessionTracker', () => {
  beforeEach(() => resetSessionsForTest())

  it('tracks the active gauge up and down', async () => {
    const before = await counterValue('mcp.sessions.active', { 'client.name': 'cursor' })

    startSession('s-active-1', { ...CLIENT, clientName: 'cursor' })
    startSession('s-active-2', { ...CLIENT, clientName: 'cursor' })
    expect(
      await counterValue('mcp.sessions.active', { 'client.name': 'cursor' })
    ).to.equal(before + 2)

    endSession('s-active-1')
    expect(
      await counterValue('mcp.sessions.active', { 'client.name': 'cursor' })
    ).to.equal(before + 1)
  })

  it('records duration exactly once and is idempotent on double end', async () => {
    // `transport.onclose` can fire more than once; double-counting would skew every percentile.
    startSession('s-idem', { ...CLIENT, clientName: 'zed' })
    const before = await histogramCount('mcp.session.duration', { 'client.name': 'zed' })

    endSession('s-idem')
    endSession('s-idem')
    endSession('s-idem')

    expect(
      await histogramCount('mcp.session.duration', { 'client.name': 'zed' })
    ).to.equal(before + 1)
  })

  it('ignores an unknown or undefined session id', () => {
    expect(() => endSession('never-started')).to.not.throw()
    expect(() => endSession(undefined)).to.not.throw()
  })

  it('counts a session that made zero tool calls as a bounce', async () => {
    const before = await counterValue('mcp.sessions.empty', { 'client.name': 'goose' })
    startSession('s-empty', { ...CLIENT, clientName: 'goose' })
    endSession('s-empty')
    expect(await counterValue('mcp.sessions.empty', { 'client.name': 'goose' })).to.equal(
      before + 1
    )
  })

  it('does not count a session with tool calls as a bounce', async () => {
    const before = await counterValue('mcp.sessions.empty', { 'client.name': 'cline' })
    const meta = startSession('s-busy', { ...CLIENT, clientName: 'cline' })
    meta.recordToolUse('computeStart')
    endSession('s-busy')
    expect(await counterValue('mcp.sessions.empty', { 'client.name': 'cline' })).to.equal(
      before
    )
  })

  it('records activation latency exactly once, on the first tool call', async () => {
    // `sessions.empty` counts the sessions that never got here; this measures how long the rest
    // took, which is what separates "slow to start" from "never started".
    const before = await histogramCount('mcp.session.time_to_first_call', {
      'client.name': 'windsurf'
    })
    const meta = startSession('s-activate', { ...CLIENT, clientName: 'windsurf' })

    expect(
      await histogramCount('mcp.session.time_to_first_call', {
        'client.name': 'windsurf'
      })
    ).to.equal(before, 'must not record before the first tool call')

    meta.recordToolUse('search_docs')
    meta.recordToolUse('get_doc')
    meta.recordToolUse('list_topics')

    expect(
      await histogramCount('mcp.session.time_to_first_call', {
        'client.name': 'windsurf'
      })
    ).to.equal(before + 1)
  })

  it('records no activation latency for a session that never calls a tool', async () => {
    const before = await histogramCount('mcp.session.time_to_first_call', {
      'client.name': 'librechat'
    })
    startSession('s-never', { ...CLIENT, clientName: 'librechat' })
    endSession('s-never')

    expect(
      await histogramCount('mcp.session.time_to_first_call', {
        'client.name': 'librechat'
      })
    ).to.equal(before)
  })

  it('tracks call count and distinct-tool breadth separately', () => {
    const meta = startSession('s-breadth', CLIENT)
    meta.recordToolUse('computeStatus')
    meta.recordToolUse('computeStatus')
    meta.recordToolUse('serviceStatus')

    expect(meta.toolCalls).to.equal(3)
    expect(meta.distinctTools.size).to.equal(2)
  })

  it('returns the same meta for a repeated start rather than resetting the session', () => {
    const first = startSession('s-dup', CLIENT)
    first.recordToolUse('search_docs')
    const second = startSession('s-dup', CLIENT)
    expect(second).to.equal(first)
    expect(second.toolCalls).to.equal(1)
  })

  it('exposes the session to the tool wrapper by id', () => {
    startSession('s-lookup', CLIENT)
    expect(getSession('s-lookup')?.sessionId).to.equal('s-lookup')
    expect(getSession('nope')).to.equal(undefined)
    expect(getSession(undefined)).to.equal(undefined)
  })

  it('drops the session from the map once it ends', () => {
    startSession('s-cleanup', CLIENT)
    expect(activeSessionCount()).to.equal(1)
    endSession('s-cleanup')
    expect(activeSessionCount()).to.equal(0)
    expect(getSession('s-cleanup')).to.equal(undefined)
  })
})
