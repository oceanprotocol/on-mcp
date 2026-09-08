import { expect } from 'chai'

import { recordTransportRejection } from '../../../telemetry/transport.js'
import { counterValue } from '../../utils/hooks.js'

describe('telemetry/transport', () => {
  it('counts rejections that never reach a tool', async () => {
    // These are invisible to mcp.tool.calls (no handler ran) AND to mcp.sessions.* (no session
    // was created), which is the whole reason this counter exists.
    //
    // Deltas, not absolutes: counters are cumulative for the whole mocha run (see hooks.ts).
    const before = {
      session_not_found: await counterValue('mcp.transport.rejected', {
        reason: 'session_not_found'
      }),
      invalid_request: await counterValue('mcp.transport.rejected', {
        reason: 'invalid_request'
      }),
      handler_error: await counterValue('mcp.transport.rejected', {
        reason: 'handler_error'
      })
    }

    recordTransportRejection('session_not_found')
    recordTransportRejection('session_not_found')
    recordTransportRejection('invalid_request')
    recordTransportRejection('handler_error')

    expect(
      await counterValue('mcp.transport.rejected', { reason: 'session_not_found' })
    ).to.equal(before.session_not_found + 2)
    expect(
      await counterValue('mcp.transport.rejected', { reason: 'invalid_request' })
    ).to.equal(before.invalid_request + 1)
    expect(
      await counterValue('mcp.transport.rejected', { reason: 'handler_error' })
    ).to.equal(before.handler_error + 1)
  })

  it('never throws — it sits on the request path including its error branch', () => {
    expect(() => recordTransportRejection('handler_error')).to.not.throw()
  })
})
