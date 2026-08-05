import { expect } from 'chai'

import {
  bucketKey,
  estimate,
  recordUser,
  resetUserSketchesForTest
} from '../../../telemetry/userHll.js'

const AT = (iso: string) => new Date(iso)

describe('telemetry/userHll', () => {
  beforeEach(() => resetUserSketchesForTest())

  it('counts distinct users, not calls', () => {
    const now = AT('2026-08-05T12:00:00Z')
    for (let i = 0; i < 50; i++) recordUser('user-a', now)
    for (let i = 0; i < 50; i++) recordUser('user-b', now)

    expect(estimate('day', now)).to.equal(2)
  })

  it('is accurate in the small-cardinality range that matters here', () => {
    const now = AT('2026-08-05T12:00:00Z')
    for (let i = 0; i < 500; i++) recordUser(`user-${i}`, now)

    // Linear counting keeps the low range tight; allow a small tolerance for the sketch.
    expect(estimate('day', now)).to.be.within(485, 515)
  })

  it('stays within tolerance at a larger cardinality', () => {
    const now = AT('2026-08-05T12:00:00Z')
    for (let i = 0; i < 20_000; i++) recordUser(`u${i}`, now)

    expect(estimate('day', now)).to.be.within(19_000, 21_000)
  })

  it('ignores an absent user id instead of hashing a constant', () => {
    // `deriveUserId` returns undefined when the client IP is unknown; folding that in would
    // report a phantom user.
    const now = AT('2026-08-05T12:00:00Z')
    recordUser(undefined, now)
    expect(estimate('day', now)).to.equal(0)
  })

  describe('calendar buckets', () => {
    it('resets the day sketch at the UTC boundary', () => {
      recordUser('user-a', AT('2026-08-05T23:59:00Z'))
      expect(estimate('day', AT('2026-08-05T23:59:00Z'))).to.equal(1)
      expect(estimate('day', AT('2026-08-06T00:01:00Z'))).to.equal(0)
    })

    it('keeps the month sketch across a day rollover', () => {
      recordUser('user-a', AT('2026-08-05T23:59:00Z'))
      expect(estimate('month', AT('2026-08-06T00:01:00Z'))).to.equal(1)
    })

    it('resets the month sketch at the month boundary', () => {
      recordUser('user-a', AT('2026-08-31T23:59:00Z'))
      expect(estimate('month', AT('2026-09-01T00:01:00Z'))).to.equal(0)
    })

    it('produces stable, monotonically advancing bucket keys', () => {
      expect(bucketKey('day', AT('2026-08-05T00:00:00Z'))).to.equal('2026-08-05')
      expect(bucketKey('day', AT('2026-08-05T23:59:59Z'))).to.equal('2026-08-05')
      expect(bucketKey('month', AT('2026-08-05T00:00:00Z'))).to.equal('2026-08')
      // Weeks are epoch-relative 7-day blocks, not ISO weeks — the boundary can fall on any
      // weekday, so only same-day stability and 8-day separation are guaranteed.
      expect(bucketKey('week', AT('2026-08-05T00:00:00Z'))).to.match(/^w\d+$/)
      expect(bucketKey('week', AT('2026-08-05T00:00:00Z'))).to.equal(
        bucketKey('week', AT('2026-08-05T23:59:59Z'))
      )
      expect(bucketKey('week', AT('2026-08-05T00:00:00Z'))).to.not.equal(
        bucketKey('week', AT('2026-08-13T00:00:00Z'))
      )
    })

    it('advances week keys monotonically', () => {
      const keys = [0, 7, 14, 21].map((offset) =>
        Number(bucketKey('week', new Date(Date.UTC(2026, 7, 5 + offset))).slice(1))
      )
      expect(keys).to.deep.equal([keys[0], keys[0] + 1, keys[0] + 2, keys[0] + 3])
    })
  })

  it('tracks the three windows independently', () => {
    recordUser('user-a', AT('2026-08-04T10:00:00Z'))
    recordUser('user-b', AT('2026-08-05T10:00:00Z'))

    const now = AT('2026-08-05T10:00:00Z')
    // The day sketch reset between the two records; month saw both.
    expect(estimate('day', now)).to.equal(1)
    expect(estimate('month', now)).to.equal(2)
  })
})
