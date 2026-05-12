import type { DocIndex } from '../docs/loader.js'
import type { EvmProviderRegistry } from '../evm/evmProviderRegistry.js'
import { C2D_FIND_PROVIDER_RESOURCE_MARKDOWN } from '../utils/c2dProviderSearchString.js'

export const C2D_FIND_PROVIDER_URI = 'ocean://docs/c2d-find-provider-search'
export const EVM_SUPPORTED_CHAINS_URI = 'ocean://evm/supported-chains'

export type ResourceSummary = {
  name: string
  uri: string
  title: string
  description: string
  mimeType: string
}

export type ResourceContent = {
  uri: string
  mimeType: string
  text: string
}

type ResourceContext = {
  evmRegistry: EvmProviderRegistry
  docsIndex: DocIndex
}

function getDocsResourceName(uri: string): string {
  return uri
    .replace('ocean://', '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

export function listDocsResources(docsIndex: DocIndex): ResourceSummary[] {
  return docsIndex.map((entry) => ({
    name: getDocsResourceName(entry.uri),
    uri: entry.uri,
    title: entry.title,
    description: `${entry.title} (${entry.section})`,
    mimeType: entry.mimeType
  }))
}

export function getDocsResourceContent(
  docsIndex: DocIndex,
  uri: string
): ResourceContent | undefined {
  const entry = docsIndex.find((docEntry) => docEntry.uri === uri)
  if (!entry) return undefined

  return {
    uri: entry.uri,
    mimeType: entry.mimeType,
    text: entry.content
  }
}

export function listBuiltinResources(): ResourceSummary[] {
  return [
    {
      name: 'c2d-find-provider-search',
      uri: C2D_FIND_PROVIDER_URI,
      title: 'C2D find_provider search strings',
      description:
        'How ocean-node advertises compute capacity for DHT discovery and how to use buildFindProviderC2dContent + find_provider.',
      mimeType: 'text/markdown'
    },
    {
      name: 'evm-supported-chains',
      uri: EVM_SUPPORTED_CHAINS_URI,
      title: 'EVM supported chains',
      description:
        'Configured EVM chains with latest observed block number and timestamp from each chain fallback provider.',
      mimeType: 'application/json'
    }
  ]
}

export async function getBuiltinResourceContent(
  evmRegistry: EvmProviderRegistry,
  uri: string
): Promise<ResourceContent | undefined> {
  if (uri === C2D_FIND_PROVIDER_URI) {
    return {
      uri,
      mimeType: 'text/markdown',
      text: C2D_FIND_PROVIDER_RESOURCE_MARKDOWN
    }
  }

  if (uri !== EVM_SUPPORTED_CHAINS_URI) {
    return undefined
  }

  const chains = await Promise.all(
    evmRegistry.getConfiguredChainIds().map(async (chainId) => {
      const provider = evmRegistry.getProvider(chainId)
      if (!provider) {
        return {
          chainId,
          ready: false,
          error: 'Provider not found'
        }
      }

      try {
        const latestBlock = await provider.getBlock('latest')
        if (!latestBlock) {
          return {
            chainId,
            ready: false,
            error: 'No latest block returned'
          }
        }

        return {
          chainId,
          ready: true,
          blockNumber: latestBlock.number,
          blockTimestamp: latestBlock.timestamp,
          blockTimestampIso: new Date(latestBlock.timestamp * 1000).toISOString()
        }
      } catch (error) {
        return {
          chainId,
          ready: false,
          error: error instanceof Error ? error.message : `${error}`
        }
      }
    })
  )

  return {
    uri,
    mimeType: 'application/json',
    text: JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        chains
      },
      null,
      2
    )
  }
}

export async function getResourceContent(
  context: ResourceContext,
  uri: string
): Promise<ResourceContent | undefined> {
  return (
    getDocsResourceContent(context.docsIndex, uri) ??
    (await getBuiltinResourceContent(context.evmRegistry, uri))
  )
}

export function listAllResources(context: ResourceContext): ResourceSummary[] {
  return [...listBuiltinResources(), ...listDocsResources(context.docsIndex)]
}
