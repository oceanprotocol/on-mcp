import { z } from 'zod/v4'

import { stringifyError, textContent } from '../utils/format.js'
import { registerAccessListTools } from './accesslist.js'
import { registerEscrowTools } from './escrow.js'
import {
  commandResultPayload,
  getProviderOrThrow,
  type EvmToolParams
} from './evmToolUtils.js'

function toJsonFriendly(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(toJsonFriendly)
  if (typeof value === 'object') {
    const v = value as Record<string, unknown> & { toJSON?: () => unknown }
    if (typeof v.toJSON === 'function') return toJsonFriendly(v.toJSON())
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) out[k] = toJsonFriendly(val)
    return out
  }
  return value
}

export function registerEvmContractTools({ server, evmRegistry }: EvmToolParams): void {
  server.registerTool(
    'get_balance',
    {
      title: 'Get ETH balance',
      description: 'Gets the native ETH balance of an EVM account.',
      inputSchema: {
        chainId: z
          .number()
          .int()
          .positive()
          .describe('EVM chain id configured in EVM_CHAIN_RPCS.'),
        address: z.string().describe('Account address (0x...).')
      }
    },
    async ({ chainId, address }) => {
      try {
        const provider = getProviderOrThrow(evmRegistry, chainId)
        const balance = await provider.getBalance(address)
        return commandResultPayload('get_balance', {
          address,
          balance: balance.toString()
        })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'get_transaction_count',
    {
      title: 'Get transaction count',
      description: 'Gets the transaction count (nonce) for an EVM account.',
      inputSchema: {
        chainId: z
          .number()
          .int()
          .positive()
          .describe('EVM chain id configured in EVM_CHAIN_RPCS.'),
        address: z.string().describe('Account address (0x...).')
      }
    },
    async ({ chainId, address }) => {
      try {
        const provider = getProviderOrThrow(evmRegistry, chainId)
        const nonce = await provider.getTransactionCount(address)
        return commandResultPayload('get_transaction_count', { address, nonce })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'get_transaction',
    {
      title: 'Get transaction',
      description: 'Gets an EVM transaction by hash (if available on the connected RPC).',
      inputSchema: {
        chainId: z
          .number()
          .int()
          .positive()
          .describe('EVM chain id configured in EVM_CHAIN_RPCS.'),
        txHash: z.string().describe('Transaction hash (0x...).')
      }
    },
    async ({ chainId, txHash }) => {
      try {
        const provider = getProviderOrThrow(evmRegistry, chainId)
        const tx = await provider.getTransaction(txHash)
        return commandResultPayload('get_transaction', toJsonFriendly(tx))
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'get_transaction_receipt',
    {
      title: 'Get transaction receipt',
      description: 'Gets an EVM transaction receipt by hash (if mined).',
      inputSchema: {
        chainId: z
          .number()
          .int()
          .positive()
          .describe('EVM chain id configured in EVM_CHAIN_RPCS.'),
        txHash: z.string().describe('Transaction hash (0x...).')
      }
    },
    async ({ chainId, txHash }) => {
      try {
        const provider = getProviderOrThrow(evmRegistry, chainId)
        const receipt = await provider.getTransactionReceipt(txHash)
        return commandResultPayload('get_transaction_receipt', toJsonFriendly(receipt))
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'broadcast_transaction',
    {
      title: 'Broadcast raw EVM transaction',
      description:
        'Broadcasts a raw signed EVM transaction to the configured chain provider and returns the resulting transaction response.',
      inputSchema: {
        chainId: z
          .number()
          .int()
          .positive()
          .describe('EVM chain id configured in EVM_CHAIN_RPCS.'),
        txRaw: z
          .string()
          .describe(
            'Raw signed transaction hex string (0x-prefixed serialized transaction).'
          )
      }
    },
    async ({ chainId, txRaw }) => {
      try {
        const provider = getProviderOrThrow(evmRegistry, chainId)
        const result = await provider.broadcastTransaction(txRaw)
        return commandResultPayload('broadcast_transaction', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  registerEscrowTools({ server, evmRegistry })
  registerAccessListTools({ server, evmRegistry })
}
