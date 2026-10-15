import type { DocIndex } from '../docs/loader.js'
import type { EvmProviderRegistry } from '../evm/evmProviderRegistry.js'
import { C2D_ALGORITHM_AUTHORING_MARKDOWN } from '../utils/c2dAlgorithmAuthoring.js'
import { SERVICE_ON_DEMAND_MARKDOWN } from '../utils/serviceOnDemand.js'
import {
  P2P_AUTH_SIGNING_GUIDE,
  P2P_COMPUTE_PAYMENT_GUIDE,
  P2P_COMPUTE_POLLING_GUIDE,
  P2P_PERSISTENT_STORAGE_PREREQUISITE,
  STORAGE_OBJECT_SHAPE_GUIDE
} from '../tools/p2pSchemas.js'
import {
  SERVICE_OVERVIEW_GUIDE,
  SERVICE_PAYMENT_GUIDE,
  SERVICE_POLLING_GUIDE,
  SERVICE_RESTART_SEMANTICS_GUIDE,
  SERVICE_USERDATA_GUIDE
} from '../tools/serviceSchemas.js'

export const C2D_ALGORITHM_AUTHORING_URI = 'ocean://docs/c2d-algorithm-authoring'
export const SERVICE_ON_DEMAND_URI = 'ocean://docs/service-on-demand'
export const EVM_SUPPORTED_CHAINS_URI = 'ocean://evm/supported-chains'
/** Compact catalog of every indexed doc file (replaces one-resource-per-file registration). */
export const DOCS_INDEX_URI = 'ocean://docs/index'

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

/**
 * Built-in guide resources. These hold the long-form guides that used to be pasted verbatim into
 * dozens of tool descriptions; the descriptions now carry a short pointer to these URIs instead.
 * Each entry's text is a static string constant, so it is served by `getBuiltinResourceContent`
 * with no runtime dependencies. URIs must match the pointer literals in the schema files.
 */
export const TOOL_GUIDE_RESOURCES: ReadonlyArray<ResourceSummary & { text: string }> = [
  {
    name: 'auth-signing',
    uri: 'ocean://docs/auth-signing',
    title: 'Signed-request authentication for P2P/service tools',
    description:
      'Identity modes (authToken vs completeSignature), the plaintext message layout, nonce = getNonce + 1, ocean.js EIP-191 hashing, and the protocolCommand-per-operation table.',
    mimeType: 'text/markdown',
    text: P2P_AUTH_SIGNING_GUIDE
  },
  {
    name: 'compute-payment',
    uri: 'ocean://docs/compute-payment',
    title: 'Compute payment: duration vs escrow lock, and the paid flow',
    description:
      'How payment.amount / payment.minLockSeconds work, why the lock requirement is not the job duration, the typical initializeCompute → escrow_preflight → computeStart flow, and authorization sizing.',
    mimeType: 'text/markdown',
    text: P2P_COMPUTE_PAYMENT_GUIDE
  },
  {
    name: 'compute-polling',
    uri: 'ocean://docs/compute-polling',
    title: 'Compute: poll to completion and fetch output',
    description:
      'The C2DStatusNumber map and how to poll computeStatus to a terminal state before fetching results with getComputeResult.',
    mimeType: 'text/markdown',
    text: P2P_COMPUTE_POLLING_GUIDE
  },
  {
    name: 'storage-object-shape',
    uri: 'ocean://docs/storage-object-shape',
    title: 'fileObject shape (required fields per type)',
    description:
      'Required fields for each fileObject type (url/ipfs/arweave/s3/ftp/nodePersistentStorage) used by getFileInfo and compute dataset entries.',
    mimeType: 'text/markdown',
    text: STORAGE_OBJECT_SHAPE_GUIDE
  },
  {
    name: 'persistent-storage',
    uri: 'ocean://docs/persistent-storage',
    title: 'Persistent storage prerequisites and ownership',
    description:
      'Node capability check (node_status must advertise persistentStorage) and authToken-scoped bucket ownership for the persistent-storage tool family.',
    mimeType: 'text/markdown',
    text: P2P_PERSISTENT_STORAGE_PREREQUISITE
  },
  {
    name: 'service-overview',
    uri: 'ocean://docs/service-overview',
    title: 'Service-on-Demand: what a service is vs a compute job',
    description:
      'Asynchronous start, endpoint exposure, the pay-up-front reservation model, access-list re-checks, and the safety surface for long-running container services.',
    mimeType: 'text/markdown',
    text: SERVICE_OVERVIEW_GUIDE
  },
  {
    name: 'service-payment',
    uri: 'ocean://docs/service-payment',
    title: 'Paying for a service (no server-side quote)',
    description:
      'The estimate → escrow_preflight → serviceStart flow and the caveats that make any client figure an estimate (min-duration floor, case-sensitive feeToken, silent-0 pricing, hidden lock padding).',
    mimeType: 'text/markdown',
    text: SERVICE_PAYMENT_GUIDE
  },
  {
    name: 'service-polling',
    uri: 'ocean://docs/service-polling',
    title: 'Service: poll to Running',
    description:
      'The ServiceStatusNumber table, the Stopping-is-not-terminal trap, and how to poll serviceStatus to a settled state before reporting endpoints.',
    mimeType: 'text/markdown',
    text: SERVICE_POLLING_GUIDE
  },
  {
    name: 'service-restart',
    uri: 'ocean://docs/service-restart',
    title: 'Service restart: REUSE or RESPEC (never partial)',
    description:
      'Atomic restart semantics, why a lone changed field triggers a full RESPEC, and the recipe to rotate a secret in userData by re-sending the full spec.',
    mimeType: 'text/markdown',
    text: SERVICE_RESTART_SEMANTICS_GUIDE
  },
  {
    name: 'service-userdata',
    uri: 'ocean://docs/service-userdata',
    title: 'Service userData: plaintext in, keys only out',
    description:
      'How userData is ECIES-encrypted to the node, that values transit the chat/LLM, and that responses echo keys only while the node strips values.',
    mimeType: 'text/markdown',
    text: SERVICE_USERDATA_GUIDE
  }
]

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
    ...TOOL_GUIDE_RESOURCES.map(({ name, uri, title, description, mimeType }) => ({
      name,
      uri,
      title,
      description,
      mimeType
    })),
    {
      name: 'c2d-algorithm-authoring',
      uri: C2D_ALGORITHM_AUTHORING_URI,
      title: 'C2D algorithm authoring (rawcode + prebuilt image)',
      description:
        'Recommended C2D path: prebuilt oceanprotocol/c2d_examples image + inline rawcode. Image catalog, algorithm object shape, /data input/output contract, constraints, free-compute auth, and node targeting.',
      mimeType: 'text/markdown'
    },
    {
      name: 'service-on-demand',
      uri: SERVICE_ON_DEMAND_URI,
      title: 'Service-on-Demand (long-running containers)',
      description:
        'How Ocean services differ from compute jobs: asynchronous start, the status codes (incl. 45 Restarting and the Stopping-is-not-terminal trap), the pay-up-front reservation model, client-side cost estimation, REUSE/RESPEC restart semantics, templates as suggestions, and where endpoint hosts come from.',
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
  const guide = TOOL_GUIDE_RESOURCES.find((entry) => entry.uri === uri)
  if (guide) {
    return { uri: guide.uri, mimeType: guide.mimeType, text: guide.text }
  }

  if (uri === C2D_ALGORITHM_AUTHORING_URI) {
    return {
      uri,
      mimeType: 'text/markdown',
      text: C2D_ALGORITHM_AUTHORING_MARKDOWN
    }
  }

  if (uri === SERVICE_ON_DEMAND_URI) {
    return {
      uri,
      mimeType: 'text/markdown',
      text: SERVICE_ON_DEMAND_MARKDOWN
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

/** Summary entry for the docs catalog, surfaced by `list_resources` instead of every doc file. */
export function docsIndexSummary(docsIndex: DocIndex): ResourceSummary {
  return {
    name: 'docs-index',
    uri: DOCS_INDEX_URI,
    title: 'Ocean documentation index',
    description: `Catalog of ${docsIndex.length} documentation files as {uri,title,section}. Read one with get_doc or get_resource; browse topics with list_topics.`,
    mimeType: 'application/json'
  }
}

/** Compact JSON body for the docs catalog resource (`ocean://docs/index`). */
export function getDocsIndexContent(docsIndex: DocIndex): ResourceContent {
  return {
    uri: DOCS_INDEX_URI,
    mimeType: 'application/json',
    text: JSON.stringify({
      count: docsIndex.length,
      docs: docsIndex.map((entry) => ({
        uri: entry.uri,
        title: entry.title,
        section: entry.section
      }))
    })
  }
}

export async function getResourceContent(
  context: ResourceContext,
  uri: string
): Promise<ResourceContent | undefined> {
  if (uri === DOCS_INDEX_URI) return getDocsIndexContent(context.docsIndex)
  return (
    getDocsResourceContent(context.docsIndex, uri) ??
    (await getBuiltinResourceContent(context.evmRegistry, uri))
  )
}

/**
 * What the `list_resources` tool returns: the built-in resources plus a single docs-catalog
 * summary — **not** one entry per indexed doc file (that listing ran to ~900–1,500 entries). Use
 * the docs index / list_topics to discover a specific doc, then get_doc / get_resource to read it.
 */
export function listAllResources(context: ResourceContext): ResourceSummary[] {
  return [...listBuiltinResources(), docsIndexSummary(context.docsIndex)]
}
