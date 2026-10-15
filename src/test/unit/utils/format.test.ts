import { expect } from 'chai'

import { sliceUtf8, toCompactJson } from '../../../utils/format.js'
import { collectStream } from '../../../clients/nodeClient.js'

describe('toCompactJson', () => {
  it('emits no indentation whitespace', () => {
    const out = toCompactJson({ a: 1, b: [2, 3], c: { d: 4 } })
    expect(out).to.equal('{"a":1,"b":[2,3],"c":{"d":4}}')
    expect(out).to.not.contain('\n')
  })
})

describe('sliceUtf8', () => {
  const text = 'abcdefghij' // 10 ASCII bytes

  it('returns the whole string when maxBytes is undefined', () => {
    const s = sliceUtf8(text)
    expect(s.text).to.equal(text)
    expect(s.totalBytes).to.equal(10)
    expect(s.offset).to.equal(0)
    expect(s.returnedBytes).to.equal(10)
    expect(s.truncated).to.equal(false)
    expect(s.nextOffset).to.equal(undefined)
  })

  it('caps at maxBytes and reports a continuation offset', () => {
    const s = sliceUtf8(text, 0, 4)
    expect(s.text).to.equal('abcd')
    expect(s.returnedBytes).to.equal(4)
    expect(s.truncated).to.equal(true)
    expect(s.nextOffset).to.equal(4)
  })

  it('reads a middle window from an offset', () => {
    const s = sliceUtf8(text, 4, 3)
    expect(s.text).to.equal('efg')
    expect(s.offset).to.equal(4)
    expect(s.truncated).to.equal(true) // offset > 0
    expect(s.nextOffset).to.equal(7)
  })

  it('has no nextOffset once the window reaches the end', () => {
    const s = sliceUtf8(text, 7, 100)
    expect(s.text).to.equal('hij')
    expect(s.nextOffset).to.equal(undefined)
    expect(s.truncated).to.equal(true) // started past 0
  })

  it('clamps an offset past EOF to an empty slice without a bogus nextOffset', () => {
    const s = sliceUtf8(text, 999, 10)
    expect(s.text).to.equal('')
    expect(s.offset).to.equal(10)
    expect(s.returnedBytes).to.equal(0)
    expect(s.nextOffset).to.equal(undefined)
  })

  it('clamps a negative offset to 0', () => {
    const s = sliceUtf8(text, -5, 2)
    expect(s.offset).to.equal(0)
    expect(s.text).to.equal('ab')
  })

  it('paging ASCII via offset=nextOffset reconstructs the original exactly', () => {
    const big = 'x'.repeat(2500) + 'y'.repeat(2500)
    let out = ''
    let offset = 0
    // Guard against an infinite loop if nextOffset ever failed to advance.
    for (let i = 0; i < 1000; i += 1) {
      const s = sliceUtf8(big, offset, 128)
      out += s.text
      if (s.nextOffset === undefined) break
      expect(s.nextOffset).to.be.greaterThan(offset)
      offset = s.nextOffset
    }
    expect(out).to.equal(big)
  })
})

async function* streamOf(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield c
}

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals)
}

describe('collectStream', () => {
  it('collects the whole stream when uncapped', async () => {
    const out = await collectStream(streamOf(bytes(1, 2), bytes(3, 4, 5)))
    expect(Array.from(out.bytes)).to.deep.equal([1, 2, 3, 4, 5])
    expect(out.byteLength).to.equal(5)
    expect(out.truncated).to.equal(false)
    expect(out.totalRead).to.equal(5)
  })

  it('truncates mid-chunk at maxBytes and reports it', async () => {
    const out = await collectStream(streamOf(bytes(1, 2, 3), bytes(4, 5, 6)), 4)
    expect(Array.from(out.bytes)).to.deep.equal([1, 2, 3, 4])
    expect(out.byteLength).to.equal(4)
    expect(out.truncated).to.equal(true)
  })

  it('does not mark truncated when the stream fits exactly in maxBytes', async () => {
    const out = await collectStream(streamOf(bytes(1, 2, 3)), 3)
    expect(out.byteLength).to.equal(3)
    // The collector stops cleanly when the stream ends on the cap boundary.
    expect(out.truncated).to.equal(false)
  })
})
