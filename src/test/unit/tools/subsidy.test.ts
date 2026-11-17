import { expect } from 'chai'
import { SubsidyKind, SubsidyMode } from '@oceanprotocol/lib'
import type {
  ComputeEnvironment,
  JobSubsidyEstimate,
  JobSubsidyScenario
} from '@oceanprotocol/lib'

import {
  captureEnvironments,
  describeSubsidyEstimate,
  minimumResourceWarnings,
  type SubsidyNodeProvider
} from '../../../tools/subsidy.js'

const A = '0x00000000000000000000000000000000000000A1'
const B = '0x00000000000000000000000000000000000000b2'

function scenario(mode: SubsidyMode, selected: string[]): JobSubsidyScenario {
  return {
    mode,
    selected,
    projectedTotalSubsidy: '4',
    meetsSubsidyNeeded: false,
    escrowNeeded: '6',
    escrowAvailable: '1',
    escrowShortfall: '5'
  }
}

function estimate(): JobSubsidyEstimate {
  return {
    chainId: 8453,
    node: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    cost: '10',
    costBaseUnits: '10000000',
    minutesBilled: 10,
    minLockSeconds: 4200,
    escrowAddress: '0x0000000000000000000000000000000000000099',
    maxSponsorsPerLock: 10,
    subsidyProviderFilter: true,
    subsidyNeeded: '10',
    unpricedResourceIds: [],
    providers: [
      {
        address: A,
        subsidyKind: SubsidyKind.ONE_TIME,
        version: 2,
        isV2: true,
        gates: {
          imageAllowed: true,
          isNodeAllowed: true,
          isUserAllowed: null,
          isJobTypeSubsidized: true
        },
        eligible: true,
        quotes: {
          reimbursement: { subsidy: '4', bonus: '0' },
          prefunded: { subsidy: '4', bonus: '0' }
        }
      },
      {
        address: B,
        subsidyKind: null,
        version: null,
        isV2: false,
        gates: {
          imageAllowed: false,
          isNodeAllowed: null,
          isUserAllowed: null,
          isJobTypeSubsidized: null
        },
        eligible: false,
        dropped: 'image_not_allowed',
        reason: "The requested image is not in this provider's allowed images.",
        quotes: {
          reimbursement: { subsidy: '0', bonus: '0' },
          prefunded: { subsidy: '0', bonus: '0' }
        }
      }
    ],
    scenarios: {
      reimbursement: scenario(SubsidyMode.REIMBURSEMENT, [A]),
      prefunded: scenario(SubsidyMode.PREFUNDED, [A])
    },
    warnings: ['Advisory estimate']
  }
}

describe('describeSubsidyEstimate', () => {
  it('names the enums and keeps the selection and escrow figures verbatim', () => {
    const out = describeSubsidyEstimate(estimate())
    expect(out.scenarios.reimbursement.mode).to.equal('REIMBURSEMENT')
    expect(out.scenarios.prefunded.mode).to.equal('PREFUNDED')
    expect(out.scenarios.prefunded.selected).to.deep.equal([A])
    expect(out.scenarios.prefunded.escrowShortfall).to.equal('5')
    expect(out.providers[0].subsidyKind).to.equal('ONE_TIME')
    // Raw base units survive untouched — this is the `amount` escrow_preflight takes.
    expect(out.costBaseUnits).to.equal('10000000')
    expect(out.warnings).to.deep.equal(['Advisory estimate'])
  })

  it('lists on-mcp warnings (e.g. under-minimum resources) ahead of the lib ones', () => {
    const out = describeSubsidyEstimate(estimate(), ['cpu below env minimum'])
    expect(out.warnings).to.deep.equal(['cpu below env minimum', 'Advisory estimate'])
  })

  it('keeps quotes for eligible providers and the drop reason for the rest', () => {
    const [kept, droppedOut] = describeSubsidyEstimate(estimate()).providers
    expect(kept.quotes?.prefunded.subsidy).to.equal('4')
    expect(kept).to.not.have.property('dropped')
    expect(droppedOut.dropped).to.equal('image_not_allowed')
    expect(droppedOut.gates.imageAllowed).to.equal(false)
    expect(droppedOut).to.not.have.property('quotes')
  })
})

const ENV = {
  id: 'env-1',
  resources: [{ id: 'cpu', kind: 'fungible', total: 8, inUse: 0, max: 8, min: 2 }]
} as unknown as ComputeEnvironment

describe('minimumResourceWarnings', () => {
  it('warns for an amount below the env minimum', () => {
    const warnings = minimumResourceWarnings([ENV], 'env-1', [{ id: 'cpu', amount: 1 }])
    expect(warnings).to.have.length(1)
    expect(warnings[0]).to.contain('minimum of 2')
  })

  it('is silent when every amount meets the minimum', () => {
    expect(
      minimumResourceWarnings([ENV], 'env-1', [{ id: 'cpu', amount: 2 }])
    ).to.deep.equal([])
  })

  it('says the check did not run when the env data is unavailable', () => {
    for (const envs of [undefined, [], [ENV]]) {
      const warnings = minimumResourceWarnings(envs, 'other-env', [
        { id: 'cpu', amount: 1 }
      ])
      expect(warnings).to.have.length(1)
      expect(warnings[0]).to.contain('RESOURCE MINIMUMS NOT CHECKED')
    }
  })
})

describe('captureEnvironments', () => {
  function fakeBase(envs: unknown) {
    return {
      tag: 'base',
      getComputeEnvironments(node: string) {
        return Promise.resolve(node === 'n1' ? envs : undefined)
      },
      getNodeStatus(this: { tag: string }) {
        return Promise.resolve({ address: this.tag })
      }
    } as unknown as SubsidyNodeProvider
  }

  it('remembers the envs the estimate read, passing them through unchanged', async () => {
    const captured = captureEnvironments(fakeBase([ENV]))
    expect(captured.environments()).to.equal(undefined)
    const envs = await captured.provider.getComputeEnvironments('n1')
    expect(envs).to.deep.equal([ENV])
    expect(captured.environments()).to.deep.equal([ENV])
  })

  it('leaves other methods working with their original `this`', async () => {
    const captured = captureEnvironments(fakeBase([ENV]))
    const status = await captured.provider.getNodeStatus('n1')
    expect(status.address).to.equal('base')
  })

  it('captures nothing when the read fails', async () => {
    const base = {
      getComputeEnvironments: () => Promise.reject(new Error('boom'))
    } as unknown as SubsidyNodeProvider
    const captured = captureEnvironments(base)
    let threw = false
    try {
      await captured.provider.getComputeEnvironments('n1')
    } catch {
      threw = true
    }
    expect(threw).to.equal(true)
    expect(captured.environments()).to.equal(undefined)
  })
})
