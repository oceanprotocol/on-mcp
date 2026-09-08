import { expect } from 'chai'
import type { ComputeEnvironment } from '@oceanprotocol/lib'

import { NodeClient } from '../../../clients/nodeClient.js'
import {
  recordAutoFix,
  recordPreflight,
  recordPreflightError
} from '../../../telemetry/escrowMetrics.js'
import { serviceEscrowGate } from '../../../tools/serviceTools.js'
import type { EscrowPreflightResult } from '../../../tools/escrowPreflight.js'
import { counterValue } from '../../utils/hooks.js'

/** Local method stub, matching the pattern in `serviceTools.test.ts` (sinon ships no types). */
const restores: Array<() => void> = []

function stubMethod<T extends object, K extends keyof T>(
  target: T,
  method: K,
  impl: (...args: unknown[]) => unknown
): void {
  const original = target[method]
  ;(target as Record<K, unknown>)[method] = impl as T[K]
  restores.push(() => {
    ;(target as Record<K, unknown>)[method] = original
  })
}

function restoreAll(): void {
  while (restores.length) restores.pop()!()
}

const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const PAYEE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const PAYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const ESCROW = '0x0000000000000000000000000000000000000099'
const NODE_ID = '16Uiu2HAmR9z4EhF9zoZcErrdcEJKCjfTpXJfBcmbNppbT3QYtBpi'

function fakeAuthToken(address = PAYER): string {
  const payload = Buffer.from(JSON.stringify({ address })).toString('base64url')
  return `header.${payload}.signature`
}

function preflightResult(
  overrides: Partial<EscrowPreflightResult> = {}
): EscrowPreflightResult {
  return {
    ready: true,
    canStartThisJob: true,
    payer: PAYER,
    payee: PAYEE,
    token: TOKEN,
    chainId: 8453,
    escrowAddress: ESCROW,
    required: {
      amount: '10',
      parallelJobs: 3,
      maxLockedAmount: '30',
      maxLockSeconds: '87000',
      maxLockCounts: '3',
      minLockSeconds: '4200'
    },
    current: { funds: '0', authorization: { exists: false } },
    shortfalls: [],
    ...overrides
  }
}

describe('telemetry/escrowMetrics', () => {
  describe('recordPreflight', () => {
    it('keys off canStartThisJob, not the generous `ready` target', async () => {
      // `ready` is provisioning advice sized for parallel jobs; `canStartThisJob` is what the
      // node actually enforces at createLock. Using `ready` would over-report blockage.
      recordPreflight({ canStartThisJob: true }, 'tool')
      expect(
        await counterValue('mcp.escrow.preflight', { result: 'ready' })
      ).to.be.at.least(1)
    })

    it('encodes the blocking reason', async () => {
      const reasons = [
        'insufficient_funds',
        'missing_authorization',
        'authorization_limits'
      ] as const
      // Baseline first: counters are cumulative for the whole run (see hooks.ts).
      const before = new Map<string, number>()
      for (const reason of reasons) {
        before.set(
          reason,
          await counterValue('mcp.escrow.preflight', { result: `blocked_${reason}` })
        )
      }

      for (const reason of reasons) {
        recordPreflight({ canStartThisJob: false, reason }, 'tool')
      }

      for (const reason of reasons) {
        expect(
          await counterValue('mcp.escrow.preflight', { result: `blocked_${reason}` }),
          reason
        ).to.equal((before.get(reason) ?? 0) + 1)
      }
    })

    it('falls back to a bounded value when the reason is missing', async () => {
      const before = await counterValue('mcp.escrow.preflight', {
        result: 'blocked_unknown'
      })
      recordPreflight({ canStartThisJob: false }, 'tool')
      expect(
        await counterValue('mcp.escrow.preflight', { result: 'blocked_unknown' })
      ).to.equal(before + 1)
    })

    it('records a bounded error result when a preflight cannot reach a verdict', async () => {
      // Both gates swallow RPC failures and proceed, so without this a broken escrow backend looks
      // like no preflight traffic rather than a problem — biasing the block-rate denominator.
      const before = await counterValue('mcp.escrow.preflight', {
        result: 'error',
        caller: 'compute_gate'
      })
      recordPreflightError('compute_gate')
      expect(
        await counterValue('mcp.escrow.preflight', {
          result: 'error',
          caller: 'compute_gate'
        })
      ).to.equal(before + 1)
    })

    it('separates the tool from the two implicit gates', async () => {
      // The whole point of instrumenting the function rather than the tool: most preflights are
      // gates inside computeStart/serviceStart and would otherwise be invisible.
      const callers = ['compute_gate', 'service_gate', 'tool_recheck'] as const
      const before = new Map<string, number>()
      for (const caller of callers) {
        before.set(caller, await counterValue('mcp.escrow.preflight', { caller }))
      }

      for (const caller of callers) {
        recordPreflight({ canStartThisJob: true }, caller)
      }

      for (const caller of callers) {
        expect(await counterValue('mcp.escrow.preflight', { caller }), caller).to.equal(
          (before.get(caller) ?? 0) + 1
        )
      }
    })

    it('never throws — a telemetry failure must not turn a proceed into a block', () => {
      expect(() => recordPreflight(undefined as never, 'tool')).to.not.throw()
    })
  })

  describe('recordAutoFix', () => {
    it('distinguishes a real transaction from the advisory no-op', async () => {
      // `escrowPreflight.ts:360-361` pushes an `authorize` action with only a `note` when an
      // existing authorization is below target and cannot be raised — that is not a fix.
      recordAutoFix([
        { action: 'deposit', tx: '0xabc' },
        { action: 'authorize', note: 'cannot be raised automatically' }
      ])

      const beforeDeposit = await counterValue('mcp.escrow.autofix', {
        outcome: 'deposit'
      })
      const beforeNoop = await counterValue('mcp.escrow.autofix', { outcome: 'noop' })
      recordAutoFix([
        { action: 'deposit', tx: '0xdef' },
        { action: 'authorize', note: 'still cannot be raised' }
      ])
      expect(await counterValue('mcp.escrow.autofix', { outcome: 'deposit' })).to.equal(
        beforeDeposit + 1
      )
      expect(await counterValue('mcp.escrow.autofix', { outcome: 'noop' })).to.equal(
        beforeNoop + 1
      )
      // A `note`-only action must never be attributed as a real authorize.
      expect(await counterValue('mcp.escrow.autofix', { outcome: 'authorize' })).to.equal(
        0
      )
    })

    it('ignores an absent or empty action list', () => {
      expect(() => recordAutoFix(undefined)).to.not.throw()
      expect(() => recordAutoFix([])).to.not.throw()
    })
  })

  describe('caller threading', () => {
    const fakeEvmRegistry = {
      getProvider: () => ({ call: () => Promise.resolve(`0x${'0'.repeat(62)}12`) })
    } as never

    function stubbedClient() {
      const nodeClient = new NodeClient()
      stubMethod(nodeClient, 'status', () =>
        Promise.resolve({ escrowAddress: { '8453': ESCROW } })
      )
      return nodeClient
    }

    afterEach(restoreAll)

    it('serviceEscrowGate identifies itself as service_gate', async () => {
      let seenCaller: string | undefined
      await serviceEscrowGate({
        command: 'serviceStart',
        nodeClient: stubbedClient(),
        evmRegistry: fakeEvmRegistry,
        node: { nodeId: NODE_ID } as never,
        timeout: 10_000,
        args: { authToken: fakeAuthToken() },
        env: {
          id: 'env-1',
          consumerAddress: PAYEE,
          runningJobs: 0,
          fees: { '8453': [{ feeToken: TOKEN, prices: [{ id: 'cpu', price: 1 }] }] },
          resources: [{ id: 'cpu', kind: 'fungible', total: 8, inUse: 0, max: 8, min: 1 }]
        } as ComputeEnvironment,
        chainId: 8453,
        token: TOKEN,
        resources: [{ id: 'cpu', amount: 1 }],
        durationSeconds: 600,
        runPreflight: (params) => {
          seenCaller = params.caller
          return Promise.resolve(preflightResult())
        }
      })

      expect(seenCaller).to.equal('service_gate')
    })
  })
})
