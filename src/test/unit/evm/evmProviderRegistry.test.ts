import { expect } from 'chai'
import { FallbackProvider } from 'ethers'

import {
  initEvmProviderRegistryFromEnv,
  resetEvmProviderRegistryForTesting,
  EvmProviderRegistry
} from '../../../evm/evmProviderRegistry.js'
import { EVM_CHAIN_RPCS_ENV } from '../../../evm/chainRpcConfig.js'

describe('EvmProviderRegistry', () => {
  it('fromChainRpcMap builds FallbackProvider per chain', () => {
    const map = new Map<number, string[]>([
      [1, ['https://rpc.ankr.com/eth']],
      [137, ['https://polygon-rpc.com']]
    ])
    const reg = EvmProviderRegistry.fromChainRpcMap(map)
    expect(reg.getProvider(1)).to.be.instanceOf(FallbackProvider)
    expect(reg.getProvider(137)).to.be.instanceOf(FallbackProvider)
    expect(reg.getConfiguredChainIds()).to.deep.equal([1, 137])
    expect(reg.getProvider(999)).to.equal(undefined)
  })

  it('initEvmProviderRegistryFromEnv throws if called twice', () => {
    resetEvmProviderRegistryForTesting()
    delete process.env[EVM_CHAIN_RPCS_ENV]
    initEvmProviderRegistryFromEnv()
    expect(() => initEvmProviderRegistryFromEnv()).to.throw(/already initialized/)
    resetEvmProviderRegistryForTesting()
  })
})
