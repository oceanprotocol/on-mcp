import { FallbackProvider, JsonRpcProvider } from 'ethers'

import { parseEvmChainRpcsFromEnv } from './chainRpcConfig.js'

/** Match ocean-node `Blockchain` primary / fallback stall timeouts (ms). */
const PRIMARY_RPC_TIMEOUT = 3000
const FALLBACK_RPC_TIMEOUT = 1500

export class EvmProviderRegistry {
  private readonly providers = new Map<number, FallbackProvider>()

  private constructor(map: Map<number, string[]>) {
    for (const [chainId, urls] of map) {
      if (urls.length === 0) {
        continue
      }
      const configs = urls.map((rpc, i) => {
        const rpcProvider = new JsonRpcProvider(rpc, chainId, {
          staticNetwork: true
        })
        return {
          provider: rpcProvider,
          priority: i + 1,
          stallTimeout: i === 0 ? PRIMARY_RPC_TIMEOUT : FALLBACK_RPC_TIMEOUT
        }
      })
      const fallback = new FallbackProvider(configs, chainId, { quorum: 1 })
      this.providers.set(chainId, fallback)
    }
  }

  static fromChainRpcMap(map: Map<number, string[]>): EvmProviderRegistry {
    return new EvmProviderRegistry(map)
  }

  getProvider(chainId: number): FallbackProvider | undefined {
    return this.providers.get(chainId)
  }

  getConfiguredChainIds(): number[] {
    return [...this.providers.keys()].sort((a, b) => a - b)
  }

  async destroy(): Promise<void> {
    for (const provider of this.providers.values()) {
      for (const config of provider.providerConfigs) {
        await config.provider.destroy()
      }
      await provider.destroy()
    }
    this.providers.clear()
  }
}

let registry: EvmProviderRegistry | null = null

export function initEvmProviderRegistryFromEnv(): EvmProviderRegistry {
  if (registry !== null) {
    throw new Error('initEvmProviderRegistryFromEnv: already initialized')
  }
  const map = parseEvmChainRpcsFromEnv()
  registry = EvmProviderRegistry.fromChainRpcMap(map)
  return registry
}

export function getEvmProviderRegistry(): EvmProviderRegistry {
  if (registry === null) {
    throw new Error(
      'getEvmProviderRegistry: not initialized; call initEvmProviderRegistryFromEnv() from main()'
    )
  }
  return registry
}

/** Test-only: reset singleton after destroy. Do not use in production. */
export function resetEvmProviderRegistryForTesting(): void {
  registry = null
}
