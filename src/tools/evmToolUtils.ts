import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { TransactionRequest, VoidSigner, getAddress } from 'ethers'
import { z } from 'zod/v4'

import type { EvmProviderRegistry } from '../evm/evmProviderRegistry.js'
import { textContent, toPrettyJson } from '../utils/format.js'

export type EvmToolParams = {
  server: McpServer
  evmRegistry: EvmProviderRegistry
}

export const contractInputSchema = {
  chainId: z
    .number()
    .int()
    .positive()
    .describe('EVM chain id configured in EVM_CHAIN_RPCS.'),
  contractAddress: z.string().describe('Target contract address.')
}

export const unsignedTxInputSchema = {
  from: z
    .string()
    .describe(
      'Address that will sign the transaction (EOA). This tool returns an unsigned TransactionRequest for offline signing.'
    )
}

export function commandResultPayload(command: string, result: unknown) {
  return textContent(
    toPrettyJson({
      command,
      result
    })
  )
}

export function getProviderOrThrow(evmRegistry: EvmProviderRegistry, chainId: number) {
  const provider = evmRegistry.getProvider(chainId)
  if (!provider) {
    throw new Error(
      `No EVM provider configured for chainId=${chainId}. Configure EVM_CHAIN_RPCS for this chain.`
    )
  }
  return provider
}

// NOTE: When using `npm link` for @oceanprotocol/lib (ocean.js), it's easy to end up
// with two different `ethers` installations (one under on-mcp, one under ocean.js).
// Their TypeScript types become incompatible due to private fields (e.g. Network).
// We intentionally return `unknown` here to avoid cross-package `Signer` type issues,
// while still providing a real ethers v6 signer object at runtime.
export function getVoidSigner(
  evmRegistry: EvmProviderRegistry,
  chainId: number,
  from?: string
): unknown {
  const provider = getProviderOrThrow(evmRegistry, chainId)
  if (from) return new VoidSigner(getAddress(from), provider)
  return new VoidSigner('0x0000000000000000000000000000000000000000', provider)
}

export function normalizeTxRequest(tx: TransactionRequest): Record<string, unknown> {
  const toStr = (v: unknown) => (typeof v === 'bigint' ? v.toString() : v)
  const normalize = (v: unknown): unknown => {
    if (v === undefined) return undefined
    if (v === null) return null
    if (typeof v === 'bigint') return v.toString()
    if (Array.isArray(v)) return v.map(normalize)
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = normalize(val)
      }
      return out
    }
    return v
  }

  return {
    to: tx.to,
    from: tx.from,
    data: tx.data,
    value: toStr(tx.value),
    chainId: toStr(tx.chainId),
    nonce: toStr(tx.nonce),
    gasLimit: toStr(tx.gasLimit),
    gasPrice: toStr(tx.gasPrice),
    maxFeePerGas: toStr(tx.maxFeePerGas),
    maxPriorityFeePerGas: toStr(tx.maxPriorityFeePerGas),
    type: tx.type,
    accessList: normalize(tx.accessList)
  }
}
