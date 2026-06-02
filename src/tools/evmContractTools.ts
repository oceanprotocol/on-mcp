import { Contract, formatUnits, getAddress } from 'ethers'
import { z } from 'zod/v4'

import { stringifyError, textContent } from '../utils/format.js'
import { registerAccessListTools } from './accesslist.js'
import { registerEscrowTools } from './escrow.js'
import {
  commandResultPayload,
  getProviderOrThrow,
  type EvmToolParams
} from './evmToolUtils.js'

const ERC20_INFO_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)'
]

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
        return commandResultPayload('get_transaction', tx)
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
        return commandResultPayload('get_transaction_receipt', receipt)
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

  server.registerTool(
    'get_erc20_token_info',
    {
      title: 'Get ERC-20 token info (decimals, symbol, name)',
      description:
        'Reads `decimals`, `symbol`, and `name` from an ERC-20 token contract (read-only). Use this to denominate raw amounts (e.g. `payment.amount` from initializeCompute, `escrow_get_user_funds`) into human-readable units before showing them to the user. Optionally pass `rawAmount` to get back the human-readable string as well.',
      inputSchema: {
        chainId: z
          .number()
          .int()
          .positive()
          .describe('EVM chain id configured in EVM_CHAIN_RPCS.'),
        tokenAddress: z.string().describe('ERC-20 token contract address (0x...).'),
        rawAmount: z
          .string()
          .optional()
          .describe(
            'Optional raw amount (decimal string) to format using the token decimals; returns `formattedAmount`.'
          )
      }
    },
    async ({ chainId, tokenAddress, rawAmount }) => {
      try {
        const provider = getProviderOrThrow(evmRegistry, chainId)
        const contract = new Contract(getAddress(tokenAddress), ERC20_INFO_ABI, provider)
        const [decimalsRaw, symbol, name] = await Promise.all([
          contract.decimals(),
          contract.symbol(),
          contract.name()
        ])
        const decimals = Number(decimalsRaw)
        return commandResultPayload('get_erc20_token_info', {
          address: getAddress(tokenAddress),
          decimals,
          symbol,
          name,
          ...(rawAmount !== undefined
            ? { rawAmount, formattedAmount: formatUnits(BigInt(rawAmount), decimals) }
            : {})
        })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  registerEscrowTools({ server, evmRegistry })
  registerAccessListTools({ server, evmRegistry })
}
