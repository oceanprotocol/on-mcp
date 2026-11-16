import { expect } from 'chai'
import { SubsidyKind, SubsidyMode } from '@oceanprotocol/lib'
import type { JobSubsidyEstimate, JobSubsidyScenario } from '@oceanprotocol/lib'

import { describeSubsidyEstimate } from '../../../tools/subsidy.js'

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

  it('keeps quotes for eligible providers and the drop reason for the rest', () => {
    const [kept, droppedOut] = describeSubsidyEstimate(estimate()).providers
    expect(kept.quotes?.prefunded.subsidy).to.equal('4')
    expect(kept).to.not.have.property('dropped')
    expect(droppedOut.dropped).to.equal('image_not_allowed')
    expect(droppedOut.gates.imageAllowed).to.equal(false)
    expect(droppedOut).to.not.have.property('quotes')
  })
})
