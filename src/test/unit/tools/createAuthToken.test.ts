import { expect } from 'chai'

import { registerP2pProviderTools } from '../../../tools/p2pProviderTools.js'

type Handler = (args: any) => Promise<any>

// Hardhat account #0 private key — valid test key, no real funds.
const VALID_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

function getHandler(nodeClient: any): Handler {
  let handler: Handler | undefined
  const server = {
    registerTool(name: string, _config: unknown, fn: Handler) {
      if (name === 'create_auth_token') handler = fn
    }
  }
  registerP2pProviderTools({ server: server as any, nodeClient })
  if (!handler) throw new Error('create_auth_token was not registered')
  return handler
}

function resultObject(res: any) {
  return JSON.parse(res.content[0].text).result
}

describe('create_auth_token tool', () => {
  it('ephemeral: returns token + generated address + throwaway privateKey', async () => {
    let signerAddress: string | undefined
    const nodeClient = {
      createAuthTokenWithSigner(_node: any, signer: any) {
        signerAddress = signer.address
        return Promise.resolve('jwt-ephemeral')
      }
    }
    const res = await getHandler(nodeClient)({ nodeId: 'peer-1', ephemeral: true })
    expect(res.isError).to.not.equal(true)
    const out = resultObject(res)
    expect(out.token).to.equal('jwt-ephemeral')
    expect(out.consumerAddress).to.match(/^0x[0-9a-fA-F]{40}$/)
    expect(out.privateKey).to.match(/^0x[0-9a-fA-F]{64}$/)
    expect(out.consumerAddress.toLowerCase()).to.equal(signerAddress?.toLowerCase())
    expect(out.disclaimer).to.be.a('string').and.have.length.greaterThan(0)
  })

  it('privateKey: returns token + derived address and never echoes the key', async () => {
    const nodeClient = {
      createAuthTokenWithSigner() {
        return Promise.resolve('jwt-own')
      }
    }
    const res = await getHandler(nodeClient)({ nodeId: 'peer-1', privateKey: VALID_PK })
    expect(res.content[0].text).to.not.contain(VALID_PK)
    const out = resultObject(res)
    expect(out.token).to.equal('jwt-own')
    expect(out.consumerAddress).to.match(/^0x[0-9a-fA-F]{40}$/)
    expect(out.privateKey).to.equal(undefined)
  })

  it('rejects when no auth source is provided', async () => {
    const res = await getHandler({})({ nodeId: 'peer-1' })
    expect(res.isError).to.equal(true)
  })

  it('rejects when more than one auth source is provided', async () => {
    const res = await getHandler({})({
      nodeId: 'peer-1',
      ephemeral: true,
      privateKey: VALID_PK
    })
    expect(res.isError).to.equal(true)
  })

  it('returns isError on an invalid privateKey and never echoes it', async () => {
    const nodeClient = {
      createAuthTokenWithSigner() {
        return Promise.resolve('x')
      }
    }
    const badKey = 'super-secret-not-hex-passphrase'
    const res = await getHandler(nodeClient)({ nodeId: 'peer-1', privateKey: badKey })
    expect(res.isError).to.equal(true)
    expect(res.content[0].text).to.not.contain(badKey)
  })

  it('privateKey: a downstream mint failure never echoes the key', async () => {
    const nodeClient = {
      createAuthTokenWithSigner() {
        // Worst case: the underlying error text embeds the key. The handler must
        // not surface it on the user-key path.
        return Promise.reject(new Error(`signing exploded ${VALID_PK}`))
      }
    }
    const res = await getHandler(nodeClient)({ nodeId: 'peer-1', privateKey: VALID_PK })
    expect(res.isError).to.equal(true)
    expect(res.content[0].text).to.not.contain(VALID_PK)
  })
})
