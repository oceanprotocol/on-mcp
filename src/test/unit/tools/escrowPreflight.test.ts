import { expect } from 'chai'

import {
  evaluateEscrowReadiness,
  type EscrowAuthorizationView
} from '../../../tools/escrowPreflight.js'

const BASE = {
  payer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  payee: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  chainId: 8453,
  escrowAddress: '0x0000000000000000000000000000000000000099',
  amount: 1000n,
  minLockSeconds: 3600n,
  maxJobDuration: 600,
  parallelJobs: 3
}

// requiredMaxLockedAmount = 1000 * 3 = 3000
// requiredMaxLockSeconds  = 600 + 86400 = 87000
// requiredMaxLockCounts   = 3
const fullAuth: EscrowAuthorizationView = {
  maxLockedAmount: 3000n,
  currentLockedAmount: 0n,
  maxLockSeconds: 87000n,
  maxLockCounts: 3n,
  currentLocks: 0n,
  expiryTimestamp: 0n // indefinite (Escrow v2 default)
}

const nowSec = () => BigInt(Math.floor(Date.now() / 1000))

describe('evaluateEscrowReadiness', () => {
  it('ready when funds + authorization meet the generous targets', () => {
    const r = evaluateEscrowReadiness({
      ...BASE,
      available: 3000n,
      authorization: fullAuth
    })
    expect(r.ready).to.equal(true)
    expect(r.canStartThisJob).to.equal(true)
    expect(r.reason).to.equal(undefined)
    expect(r.action).to.equal(undefined)
    expect(r.required.maxLockedAmount).to.equal('3000')
    expect(r.required.maxLockSeconds).to.equal('87000')
    expect(r.required.maxLockCounts).to.equal('3')
  })

  it('insufficient_funds when available < per-job amount', () => {
    const r = evaluateEscrowReadiness({
      ...BASE,
      available: 500n,
      authorization: fullAuth
    })
    expect(r.canStartThisJob).to.equal(false)
    expect(r.reason).to.equal('insufficient_funds')
    expect(r.action?.url).to.match(/profile\/escrow/)
  })

  it('missing_authorization when no authorization exists', () => {
    const r = evaluateEscrowReadiness({ ...BASE, available: 3000n, authorization: null })
    expect(r.canStartThisJob).to.equal(false)
    expect(r.reason).to.equal('missing_authorization')
    expect(r.current.authorization.exists).to.equal(false)
  })

  it('authorization_limits when maxLockSeconds is below the per-job minimum', () => {
    const r = evaluateEscrowReadiness({
      ...BASE,
      available: 3000n,
      authorization: { ...fullAuth, maxLockSeconds: 100n }
    })
    expect(r.canStartThisJob).to.equal(false)
    expect(r.reason).to.equal('authorization_limits')
  })

  it('authorization_limits when locked headroom is below the per-job amount', () => {
    const r = evaluateEscrowReadiness({
      ...BASE,
      available: 3000n,
      authorization: { ...fullAuth, maxLockedAmount: 1000n, currentLockedAmount: 500n }
    })
    expect(r.canStartThisJob).to.equal(false)
    expect(r.reason).to.equal('authorization_limits')
    // The per-job blocker must be reported even though the recommended target (3000) is met.
    expect(r.shortfalls.join(' ')).to.match(/headroom/)
  })

  it('authorization_limits when no free lock slot, reported in shortfalls', () => {
    const r = evaluateEscrowReadiness({
      ...BASE,
      available: 3000n,
      authorization: { ...fullAuth, maxLockCounts: 5n, currentLocks: 5n }
    })
    expect(r.canStartThisJob).to.equal(false)
    expect(r.reason).to.equal('authorization_limits')
    expect(r.shortfalls.join(' ')).to.match(/no free lock slot/)
  })

  it('can start one job but not ready when under-provisioned for parallelJobs', () => {
    const r = evaluateEscrowReadiness({
      ...BASE,
      available: 1000n, // enough for one job, < 3000 target
      authorization: { ...fullAuth, maxLockedAmount: 1000n }
    })
    expect(r.canStartThisJob).to.equal(true)
    expect(r.ready).to.equal(false)
    expect(r.reason).to.equal(undefined) // not blocking — just a recommendation
    expect(r.action?.url).to.match(/profile\/escrow/)
    expect(r.shortfalls.join(' ')).to.match(/recommended 3000/)
  })

  it('authorization_expired when expiryTimestamp is in the past (Escrow v2)', () => {
    const r = evaluateEscrowReadiness({
      ...BASE,
      available: 3000n,
      authorization: { ...fullAuth, expiryTimestamp: nowSec() - 100n }
    })
    expect(r.canStartThisJob).to.equal(false)
    expect(r.reason).to.equal('authorization_expired')
    expect(r.shortfalls.join(' ')).to.match(/expired/)
    expect(r.current.authorization.expiryTimestamp).to.not.equal('0')
  })

  it('authorization_expired when the lock would outlive the authorization expiry', () => {
    // expiry is in the future but closer than minLockSeconds (3600), so the lock end exceeds it.
    const r = evaluateEscrowReadiness({
      ...BASE,
      available: 3000n,
      authorization: { ...fullAuth, expiryTimestamp: nowSec() + 60n }
    })
    expect(r.canStartThisJob).to.equal(false)
    expect(r.reason).to.equal('authorization_expired')
    expect(r.shortfalls.join(' ')).to.match(/outlive authorization expiry/)
  })

  it('ready with a comfortably-future expiryTimestamp (indefinite-equivalent)', () => {
    const r = evaluateEscrowReadiness({
      ...BASE,
      available: 3000n,
      authorization: { ...fullAuth, expiryTimestamp: nowSec() + 1_000_000n }
    })
    expect(r.ready).to.equal(true)
    expect(r.canStartThisJob).to.equal(true)
  })

  it('sponsored lock: zero funds is startable when an authorization exists', () => {
    // A selected subsidy provider may fully pre-fund the lock, so the payer-funded funds/amount
    // guards are skipped and a zero-deposit user can still start.
    const r = evaluateEscrowReadiness({
      ...BASE,
      available: 0n,
      authorization: fullAuth,
      subsidyProviders: ['0x0000000000000000000000000000000000000abc']
    })
    expect(r.canStartThisJob).to.equal(true)
    expect(r.ready).to.equal(true)
    expect(r.reason).to.equal(undefined)
    expect(r.shortfalls.join(' ')).to.not.match(/funds|headroom/)
  })

  it('sponsored lock still requires an authorization to exist', () => {
    const r = evaluateEscrowReadiness({
      ...BASE,
      available: 0n,
      authorization: null,
      subsidyProviders: ['0x0000000000000000000000000000000000000abc']
    })
    expect(r.canStartThisJob).to.equal(false)
    expect(r.reason).to.equal('missing_authorization')
  })

  it('explicit empty subsidyProviders stays payer-funded (not relaxed)', () => {
    const r = evaluateEscrowReadiness({
      ...BASE,
      available: 0n,
      authorization: fullAuth,
      subsidyProviders: []
    })
    expect(r.canStartThisJob).to.equal(false)
    expect(r.reason).to.equal('insufficient_funds')
  })

  it('bumps requiredMaxLockSeconds up to minLockSeconds when the buffer is smaller', () => {
    const r = evaluateEscrowReadiness({
      ...BASE,
      minLockSeconds: 100000n, // larger than 600 + 86400
      available: 3000n,
      authorization: fullAuth
    })
    expect(r.required.maxLockSeconds).to.equal('100000')
  })
})
