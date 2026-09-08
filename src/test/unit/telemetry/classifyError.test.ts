import { expect } from 'chai'

import { classifyError } from '../../../telemetry/classifyError.js'

describe('telemetry/classifyError', () => {
  it('maps thrown errors onto the bounded enum', () => {
    expect(classifyError(new Error('execution reverted: not authorized'))).to.equal(
      'onchain_revert'
    )
    expect(
      classifyError(new Error('Invalid input: expected number, received string'))
    ).to.equal('validation')
    expect(classifyError(new Error('DDO not found for did:op:abc'))).to.equal('not_found')
    expect(classifyError(new Error('The operation was aborted'))).to.equal('p2p_timeout')
    expect(classifyError(new Error('connect ECONNREFUSED 127.0.0.1:8000'))).to.equal(
      'network'
    )
  })

  it('classifies authentication failures as auth, not internal', () => {
    // ~44 tools take an auth token. Without this rule these all land in `internal`, where
    // "users cannot authenticate" is indistinguishable from any other unexplained failure.
    expect(classifyError(new Error('Unauthorized'))).to.equal('auth')
    expect(classifyError(new Error('auth token expired'))).to.equal('auth')
    expect(classifyError(new Error('Invalid signature for consumer'))).to.equal('auth')
    expect(classifyError(new Error('nonce too low'))).to.equal('auth')
    expect(classifyError(new Error('403 Forbidden'))).to.equal('auth')
    expect(classifyError(new Error('permission denied'))).to.equal('auth')
  })

  it('prefers auth over the rules it deliberately precedes', () => {
    // A revert string can contain "unauthorized", and an expired token commonly reads as
    // "session not found" — auth is ordered first so those are attributed correctly.
    expect(classifyError(new Error('execution reverted: unauthorized caller'))).to.equal(
      'auth'
    )
    expect(classifyError(new Error('auth token not found for session'))).to.equal('auth')
  })

  it('does not steal ordinary not-found or revert failures', () => {
    expect(classifyError(new Error('DDO not found'))).to.equal('not_found')
    expect(classifyError(new Error('execution reverted: insufficient balance'))).to.equal(
      'onchain_revert'
    )
  })

  it('classifies the no-providers p2p failure as a timeout, not internal', () => {
    expect(classifyError(new Error('No providers found for this DID'))).to.equal(
      'p2p_timeout'
    )
  })

  it('reads the `{ isError: true }` result shape, not just thrown errors', () => {
    const result = {
      content: [{ type: 'text', text: 'Request timed out after 30000ms' }],
      isError: true
    }
    expect(classifyError(result)).to.equal('p2p_timeout')
  })

  it('uses the ethers `code` discriminator when the message is unhelpful', () => {
    const error = Object.assign(new Error('missing revert data'), {
      code: 'CALL_EXCEPTION'
    })
    expect(classifyError(error)).to.equal('onchain_revert')
  })

  it('falls back to internal for anything unrecognized', () => {
    expect(classifyError(new Error('something odd happened'))).to.equal('internal')
    expect(classifyError(undefined)).to.equal('internal')
    expect(classifyError({})).to.equal('internal')
  })

  it('only ever returns a value from the bounded enum', () => {
    const allowed = [
      'auth',
      'validation',
      'not_found',
      'p2p_timeout',
      'network',
      'onchain_revert',
      'internal'
    ]
    const samples = [
      new Error('did:op:deadbeef could not be resolved'),
      new Error('0xAbCd1234 has insufficient funds for gas'),
      'a bare string failure',
      { message: 'nested', code: 502 },
      null
    ]
    for (const sample of samples) {
      expect(allowed).to.include(classifyError(sample))
    }
  })

  it('never returns the message itself', () => {
    const secret = 'privateKey=0xdeadbeefcafe'
    expect(classifyError(new Error(secret))).to.not.contain('0xdeadbeef')
  })
})
