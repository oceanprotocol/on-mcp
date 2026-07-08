import { expect } from 'chai'

import { decodeAuthTokenAddress, resolveConsumerAddress } from '../../../utils/auth.js'

// Hardhat account #0 — valid test key, no real funds.
const VALID_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const PK_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
    'base64url'
  )
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature-not-verified`
}

describe('decodeAuthTokenAddress', () => {
  it('extracts and checksums the `address` claim without verifying the signature', () => {
    const token = makeJwt({
      address: PK_ADDRESS.toLowerCase(),
      nonce: 1,
      createdAt: 1700000000
    })
    expect(decodeAuthTokenAddress(token)).to.equal(PK_ADDRESS)
  })

  it('throws on a non-JWT string', () => {
    expect(() => decodeAuthTokenAddress('not-a-jwt')).to.throw(/not a JWT/)
  })

  it('throws when the payload has no address claim', () => {
    expect(() => decodeAuthTokenAddress(makeJwt({ nonce: 1 }))).to.throw(/address/)
  })
})

describe('resolveConsumerAddress', () => {
  it('derives the address from a private key (precedence over others)', () => {
    expect(resolveConsumerAddress({ privateKey: VALID_PK })).to.equal(PK_ADDRESS)
  })

  it('checksums an explicit consumerAddress', () => {
    expect(
      resolveConsumerAddress({ consumerAddress: PK_ADDRESS.toLowerCase() })
    ).to.equal(PK_ADDRESS)
  })

  it('decodes an authToken', () => {
    const token = makeJwt({ address: PK_ADDRESS.toLowerCase() })
    expect(resolveConsumerAddress({ authToken: token })).to.equal(PK_ADDRESS)
  })

  it('throws an opaque error on an invalid private key (never echoes it)', () => {
    const bad = 'super-secret-passphrase-not-hex'
    try {
      resolveConsumerAddress({ privateKey: bad })
      expect.fail('expected throw')
    } catch (e) {
      expect((e as Error).message).to.not.contain(bad)
    }
  })

  it('throws when no identity is supplied', () => {
    expect(() => resolveConsumerAddress({})).to.throw(/Provide an identity/)
  })
})
