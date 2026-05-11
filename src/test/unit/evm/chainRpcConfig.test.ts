import { expect } from 'chai'

import {
  EVM_CHAIN_RPCS_ENV,
  parseEvmChainRpcsFromEnv,
  parseEvmChainRpcsJson
} from '../../../evm/chainRpcConfig.js'

describe('parseEvmChainRpcsJson', () => {
  it('returns empty map for undefined or blank', () => {
    expect(parseEvmChainRpcsJson(undefined).size).to.equal(0)
    expect(parseEvmChainRpcsJson('').size).to.equal(0)
    expect(parseEvmChainRpcsJson('   ').size).to.equal(0)
  })

  it('parses chain ids and URL lists', () => {
    const raw =
      '{"1":["https://a.example/rpc","https://b.example"],"137":["https://polygon.example"]}'
    const map = parseEvmChainRpcsJson(raw)
    expect(map.get(1)).to.deep.equal(['https://a.example/rpc', 'https://b.example'])
    expect(map.get(137)).to.deep.equal(['https://polygon.example'])
  })

  it('throws on invalid JSON', () => {
    expect(() => parseEvmChainRpcsJson('{not json')).to.throw(/not valid JSON/)
  })

  it('throws on non-object root', () => {
    expect(() => parseEvmChainRpcsJson('[]')).to.throw(/JSON object/)
    expect(() => parseEvmChainRpcsJson('null')).to.throw(/JSON object/)
  })

  it('throws on invalid chain key', () => {
    expect(() => parseEvmChainRpcsJson('{"x":["https://a.example"]}')).to.throw(
      /invalid chain id/
    )
  })

  it('throws on non-array URL list', () => {
    expect(() => parseEvmChainRpcsJson('{"1":"https://a.example"}')).to.throw(
      /must be an array/
    )
  })

  it('throws on bad URL scheme', () => {
    expect(() => parseEvmChainRpcsJson('{"1":["wss://x.example"]}')).to.throw(
      /http or https/
    )
  })
})

describe('parseEvmChainRpcsFromEnv', () => {
  const key = EVM_CHAIN_RPCS_ENV

  afterEach(() => {
    delete process.env[key]
  })

  it('reads from process.env', () => {
    process.env[key] = '{"5":["https://goerli.example"]}'
    const map = parseEvmChainRpcsFromEnv()
    expect(map.get(5)).to.deep.equal(['https://goerli.example'])
  })
})
