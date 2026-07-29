import { expect } from 'chai'
import { ServiceStatusNumber } from '@oceanprotocol/lib'

import {
  SERVICE_END_STATUSES,
  SERVICE_STATUS_LABELS,
  TERMINAL_FAILURE_STATUSES,
  isServiceTerminal,
  serviceStatusLabel
} from '../../../tools/serviceSchemas.js'

describe('service status labels', () => {
  it('labels 45 Restarting', () => {
    // Shipped in the enum as of @oceanprotocol/lib@9.0.0-next.8; we label it either way.
    expect(ServiceStatusNumber.Restarting).to.equal(45)
    expect(SERVICE_STATUS_LABELS[45]).to.equal('Restarting')
    expect(serviceStatusLabel(45)).to.equal('Restarting')
  })

  it('covers every status the node can emit', () => {
    for (const status of [10, 11, 12, 13, 14, 15, 20, 30, 40, 45, 50, 70, 75, 99]) {
      expect(SERVICE_STATUS_LABELS[status], `label for ${status}`).to.be.a('string')
    }
  })

  it('covers every member of the shipped enum (drift guard)', () => {
    // If ocean.js adds a status we do not label, serviceStatusLabel would fall back to
    // "status N" for a code the node actively emits. Fail here instead.
    const numericValues = Object.values(ServiceStatusNumber).filter(
      (v): v is number => typeof v === 'number'
    )
    expect(numericValues.length).to.be.greaterThan(0)
    for (const status of numericValues) {
      expect(
        SERVICE_STATUS_LABELS[status],
        `no label for ServiceStatusNumber ${ServiceStatusNumber[status]} (${status})`
      ).to.be.a('string')
    }
  })

  it('uses agent-readable labels rather than the enum identifiers', () => {
    // The reason this map exists now that the enum is complete: "PullImageFailed" is a symbol
    // name, not something to show a user.
    expect(SERVICE_STATUS_LABELS[12]).to.equal('Image pull FAILED')
    expect(SERVICE_STATUS_LABELS[12]).to.not.equal(ServiceStatusNumber[12])
    expect(SERVICE_STATUS_LABELS[20]).to.equal('Locking escrow')
  })

  it('falls back to "status N" for an unknown code', () => {
    expect(serviceStatusLabel(123)).to.equal('status 123')
  })

  it('prefers the node-provided statusText', () => {
    expect(serviceStatusLabel(40, 'Running (healthy)')).to.equal('Running (healthy)')
  })
})

describe('isServiceTerminal', () => {
  it('classifies the four terminal failures', () => {
    expect(TERMINAL_FAILURE_STATUSES).to.deep.equal([12, 14, 15, 99])
    for (const status of TERMINAL_FAILURE_STATUSES) {
      expect(isServiceTerminal(status), `${status} terminal`).to.equal(true)
    }
  })

  it('classifies Stopped and Expired as the only end states', () => {
    expect(SERVICE_END_STATUSES).to.deep.equal([70, 75])
    expect(isServiceTerminal(70)).to.equal(true)
    expect(isServiceTerminal(75)).to.equal(true)
  })

  it('does NOT treat Stopping (50) as terminal', () => {
    // 50 still holds cpu/ram/gpu and host ports, and ocean-node counts it among its active
    // jobs. Halting a poll at 50 reports "done" while teardown is still in flight.
    expect(isServiceTerminal(50)).to.equal(false)
  })

  it('does not treat the in-flight pipeline statuses as terminal', () => {
    for (const status of [10, 11, 13, 20, 30, 40, 45]) {
      expect(isServiceTerminal(status), `${status} not terminal`).to.equal(false)
    }
  })
})
