import { expect } from 'chai'
import type { ComputeEnvironment, ServiceJob } from '@oceanprotocol/lib'

import {
  availableFor,
  buildServicePaymentInfo,
  decorateServiceJob,
  describeUserDataKeys,
  estimateServiceCost,
  findServiceEnvironments,
  parseUserData,
  resolveServiceResources,
  resourceMinimumWarnings,
  resourceShortfallReason,
  toRawAmount
} from '../../../tools/serviceCost.js'
import { serviceMinLockSeconds } from '../../../tools/escrowPreflight.js'

const TOKEN_CHECKSUMMED = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const PAYEE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const ESCROW = '0x0000000000000000000000000000000000000099'

function env(overrides: Partial<ComputeEnvironment> = {}): ComputeEnvironment {
  return {
    id: 'env-1',
    consumerAddress: PAYEE,
    runningJobs: 0,
    fees: {
      '8453': [
        {
          feeToken: TOKEN_CHECKSUMMED,
          prices: [
            { id: 'cpu', price: 0.5 },
            { id: 'ram', price: 0.25 }
          ]
        }
      ]
    },
    resources: [
      { id: 'cpu', kind: 'fungible', total: 8, inUse: 2, max: 8, min: 1 },
      { id: 'ram', kind: 'fungible', total: 32, inUse: 8, max: 32, min: 1 },
      { id: 'gpu-0', kind: 'discrete', type: 'gpu', total: 1, inUse: 0, max: 1 }
    ],
    ...overrides
  } as ComputeEnvironment
}

describe('estimateServiceCost', () => {
  it('bills ceil-to-minute using the node formula', () => {
    // 90s → 2 minutes; cpu 2 × 0.5 × 2 + ram 4 × 0.25 × 2 = 2 + 2 = 4
    const e = estimateServiceCost(
      env(),
      8453,
      TOKEN_CHECKSUMMED,
      [
        { id: 'cpu', amount: 2 },
        { id: 'ram', amount: 4 }
      ],
      90
    )
    expect(e).to.not.equal(null)
    expect(e!.minutesBilled).to.equal(2)
    expect(e!.costHuman).to.equal(4)
  })

  it('applies the env.minServiceDuration floor clamp (30s on a 60s-min env bills 60s)', () => {
    const e = estimateServiceCost(
      env({ minServiceDuration: 60 }),
      8453,
      TOKEN_CHECKSUMMED,
      [{ id: 'cpu', amount: 1 }],
      30
    )
    expect(e!.effectiveDurationSeconds).to.equal(60)
    expect(e!.minutesBilled).to.equal(1)
    expect(e!.costHuman).to.equal(0.5)
  })

  it('finds the schedule case-insensitively but echoes feeToken verbatim', () => {
    const e = estimateServiceCost(
      env(),
      8453,
      TOKEN_CHECKSUMMED.toLowerCase(),
      [{ id: 'cpu', amount: 1 }],
      60
    )
    expect(e).to.not.equal(null)
    // The node compares with `===`, so we must send back the env's own spelling.
    expect(e!.feeToken).to.equal(TOKEN_CHECKSUMMED)
    expect(e!.feeToken).to.not.equal(TOKEN_CHECKSUMMED.toLowerCase())
  })

  it('returns null when the env has no schedule for the chain or token', () => {
    expect(estimateServiceCost(env(), 1, TOKEN_CHECKSUMMED, [], 60)).to.equal(null)
    expect(estimateServiceCost(env(), 8453, '0x' + '11'.repeat(20), [], 60)).to.equal(
      null
    )
  })

  it('prices an unknown resource id at 0 and reports it', () => {
    const e = estimateServiceCost(
      env(),
      8453,
      TOKEN_CHECKSUMMED,
      [
        { id: 'cpu', amount: 1 },
        { id: 'cpuu', amount: 100 }
      ],
      60
    )
    expect(e!.costHuman).to.equal(0.5)
    expect(e!.unpricedResourceIds).to.deep.equal(['cpuu'])
  })
})

describe('toRawAmount', () => {
  it('emits a decimal string and keeps precision beyond 2^53', () => {
    const raw = toRawAmount(123.456, 18)
    expect(raw).to.be.a('string')
    expect(raw).to.equal('123456000000000000000')
    // The number branch of escrow_preflight's paymentSchema would have lost this.
    expect(BigInt(raw) > BigInt(Number.MAX_SAFE_INTEGER)).to.equal(true)
    expect(raw).to.not.match(/[.e]/)
  })

  it('does not leak float representation noise into the raw amount', () => {
    // toFixed(18) would render these as ...003070 / ...000044 — real wei that nobody owes.
    expect(toRawAmount(1234567.891, 18)).to.equal('1234567891000000000000000')
    expect(toRawAmount(0.1 + 0.2, 18)).to.equal('300000000000000000')
  })

  it('handles values that stringify in exponent notation', () => {
    // parseUnits rejects '1e-7' / '1e+21' outright, so these must be expanded first.
    expect(toRawAmount(1e-7, 18)).to.equal('100000000000')
    expect(toRawAmount(1e21, 18)).to.equal('1' + '0'.repeat(39))
  })

  it('rounds up rather than down when the value is finer than the token decimals', () => {
    // Rounding down would feed a too-small authorization into escrow_preflight.
    expect(toRawAmount(1.5, 0)).to.equal('2')
    expect(toRawAmount(1.0, 0)).to.equal('1')
  })

  it('maps a zero cost to zero', () => {
    expect(toRawAmount(0, 18)).to.equal('0')
  })

  it('rejects a non-finite or negative cost', () => {
    expect(() => toRawAmount(Number.NaN, 18)).to.throw()
    expect(() => toRawAmount(-1, 18)).to.throw()
  })
})

describe('buildServicePaymentInfo', () => {
  it('builds an escrow_preflight-shaped payment with a padded minLockSeconds', () => {
    const built = buildServicePaymentInfo({
      escrowAddressByChain: { '8453': ESCROW },
      payee: PAYEE,
      chainId: 8453,
      feeToken: TOKEN_CHECKSUMMED,
      rawAmount: '1000',
      durationSeconds: 3600
    })
    expect(built.escrowRequired).to.equal(true)
    if (!built.escrowRequired) throw new Error('unreachable')
    expect(built.payment).to.deep.include({
      escrowAddress: ESCROW,
      chainId: 8453,
      payee: PAYEE,
      token: TOKEN_CHECKSUMMED,
      amount: '1000'
    })
    // duration + max(3600, 0.25*duration) = 3600 + 3600
    expect(built.payment.minLockSeconds).to.equal(7200)
    expect(built.minLockSecondsNote).to.contain('claimDurationTimeout')
  })

  it('pads above the 3600 default for long durations', () => {
    // 40000 + max(3600, 10000) = 50000 — never a bare +3600.
    expect(serviceMinLockSeconds(40000)).to.equal(50000)
  })

  it('reports a zero cost as escrowRequired:false instead of an invalid payment', () => {
    const built = buildServicePaymentInfo({
      escrowAddressByChain: { '8453': ESCROW },
      payee: PAYEE,
      chainId: 8453,
      feeToken: TOKEN_CHECKSUMMED,
      rawAmount: '0',
      durationSeconds: 600
    })
    // escrow_preflight's paymentSchema is strictly positive on BOTH union branches, so a
    // payment with amount 0 would surface as a confusing schema error.
    expect(built.escrowRequired).to.equal(false)
    expect(built).to.not.have.property('payment')
  })

  it('throws a diagnosable error when the node advertises no escrow for the chain', () => {
    expect(() =>
      buildServicePaymentInfo({
        escrowAddressByChain: { '8453': ESCROW },
        payee: PAYEE,
        chainId: 1,
        feeToken: TOKEN_CHECKSUMMED,
        rawAmount: '1000',
        durationSeconds: 600
      })
    ).to.throw(/no escrow address for chainId=1/)
  })
})

describe('availableFor / resourceShortfallReason', () => {
  it('computes total - inUse for an exact id', () => {
    expect(availableFor(env(), { id: 'cpu', min: 1 })).to.equal(6)
    expect(availableFor(env(), { id: 'nope', min: 1 })).to.equal(0)
  })

  it('sums across a kind, optionally narrowed by type', () => {
    expect(availableFor(env(), { kind: 'fungible', min: 1 })).to.equal(6 + 24)
    expect(availableFor(env(), { kind: 'discrete', type: 'gpu', min: 1 })).to.equal(1)
    expect(availableFor(env(), { kind: 'discrete', type: 'fpga', min: 1 })).to.equal(0)
  })

  it('words a shortfall as "<what>: need N, have M", or null when it fits', () => {
    expect(
      resourceShortfallReason(env(), [{ kind: 'discrete', type: 'gpu', min: 2 }])
    ).to.equal('discrete/gpu: need 2, have 1')
    expect(resourceShortfallReason(env(), [{ id: 'cpu', min: 4 }])).to.equal(null)
  })
})

describe('findServiceEnvironments', () => {
  it('keeps envs unless features.services is explicitly false', () => {
    const envs = [
      env({ id: 'default' }),
      env({ id: 'on', features: { services: true } }),
      env({ id: 'off', features: { services: false } }),
      env({ id: 'compute-only-flag', features: { computeJobs: false } })
    ]
    expect(findServiceEnvironments(envs).map((e) => e.id)).to.deep.equal([
      'default',
      'on',
      'compute-only-flag'
    ])
  })

  it('also filters on requested capacity', () => {
    expect(
      findServiceEnvironments([env()], [{ kind: 'discrete', type: 'gpu', min: 2 }])
    ).to.deep.equal([])
  })
})

describe('resourceMinimumWarnings', () => {
  it('flags a request below the env-advertised minimum (a real under-estimate)', () => {
    const warnings = resourceMinimumWarnings(env(), [{ id: 'cpu', amount: 0 }])
    expect(warnings).to.have.length(1)
    expect(warnings[0]).to.contain('minimum of 1 for "cpu"')
    expect(warnings[0]).to.contain('higher than this estimate')
  })

  it('stays silent when the request meets or exceeds the minimum', () => {
    expect(resourceMinimumWarnings(env(), [{ id: 'cpu', amount: 4 }])).to.deep.equal([])
  })

  it('stays silent for a resource the env does not advertise', () => {
    expect(resourceMinimumWarnings(env(), [{ id: 'nope', amount: 0 }])).to.deep.equal([])
  })
})

describe('resolveServiceResources', () => {
  it('passes requested resources through', () => {
    expect(resolveServiceResources([{ id: 'gpu-0', amount: 1 }], env())).to.deep.equal([
      { id: 'gpu-0', amount: 1 }
    ])
  })

  it('falls back to cpu/ram = 1 from the env', () => {
    expect(resolveServiceResources(undefined, env())).to.deep.equal([
      { id: 'cpu', amount: 1 },
      { id: 'ram', amount: 1 }
    ])
  })
})

describe('parseUserData', () => {
  it('warns (does not fail) on a key the template does not advertise', () => {
    const r = parseUserData({ SURPRISE: 'x' }, [{ key: 'HF_TOKEN' }])
    expect(r.data).to.deep.equal({ SURPRISE: 'x' })
    expect(r.warnings).to.have.length(1)
    expect(r.warnings[0]).to.contain('SURPRISE')
  })

  it('does not warn when no template env-var spec was supplied', () => {
    expect(parseUserData({ ANYTHING: 'x' }).warnings).to.deep.equal([])
  })

  it('enforces a validation regex without ever printing the value', () => {
    const secret = 'hf_totally-secret-value'
    let message = ''
    try {
      parseUserData({ HF_TOKEN: secret }, [{ key: 'HF_TOKEN', validation: '^ghp_' }])
    } catch (error) {
      ;({ message } = error as Error)
    }
    expect(message).to.contain('HF_TOKEN')
    expect(message).to.not.contain(secret)
  })

  it('accepts a value that matches the regex', () => {
    expect(
      parseUserData({ HF_TOKEN: 'ghp_ok' }, [{ key: 'HF_TOKEN', validation: '^ghp_' }])
        .warnings
    ).to.deep.equal([])
  })

  it('rejects an array or primitive', () => {
    expect(() => parseUserData([1, 2] as never)).to.throw(/JSON object/)
  })
})

describe('describeUserDataKeys', () => {
  it('returns keys only, never values', () => {
    expect(describeUserDataKeys({ A: 'secret', B: 2 })).to.deep.equal(['A', 'B'])
    expect(describeUserDataKeys(undefined)).to.deep.equal([])
  })
})

function job(overrides: Partial<ServiceJob> = {}): ServiceJob {
  return {
    serviceId: 'svc-1',
    status: 40,
    statusText: '',
    endpoints: [],
    expiresAt: 0,
    payment: {},
    ...overrides
  } as unknown as ServiceJob
}

describe('decorateServiceJob', () => {
  it('treats Stopping (50) as in flight, not terminal, and says so', () => {
    const d = decorateServiceJob(job({ status: 50 }))
    expect(d.isTerminal).to.equal(false)
    expect(d.statusLabel).to.equal('Stopping')
    expect(d.warnings?.join(' ')).to.contain('Keep polling')
  })

  it('treats Error (99) as terminal but flags that the reservation is still held', () => {
    const d = decorateServiceJob(job({ status: 99 }))
    expect(d.isTerminal).to.equal(true)
    expect(d.warnings?.join(' ')).to.contain('restartable')
  })

  it('adds no warnings to a healthy Running job', () => {
    const d = decorateServiceJob(
      job({
        endpoints: [
          { containerPort: 8000, hostPort: 31042, url: 'http://node.example.com:31042' }
        ]
      })
    )
    expect(d.warnings).to.equal(undefined)
  })

  it('surfaces paymentClaimed and an ISO expiry', () => {
    const d = decorateServiceJob(
      job({ expiresAt: 1735689600000, payment: { claimTx: '0xabc' } })
    )
    expect(d.paymentClaimed).to.equal(true)
    expect(d.expiresAtIso).to.equal('2025-01-01T00:00:00.000Z')
  })

  it('renders a missing/zero expiry as null rather than throwing', () => {
    expect(decorateServiceJob(job({ expiresAt: 0 })).expiresAtIso).to.equal(null)
    expect(
      decorateServiceJob(job({ expiresAt: undefined as never })).expiresAtIso
    ).to.equal(null)
  })

  it('prefers the node statusText over the local label', () => {
    expect(
      decorateServiceJob(job({ status: 40, statusText: 'Up 3m' })).statusLabel
    ).to.equal('Up 3m')
  })
})
