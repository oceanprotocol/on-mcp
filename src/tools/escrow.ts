import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { EscrowContract } from '@oceanprotocol/lib'
import { getAddress } from 'ethers'
import { z } from 'zod/v4'

import type { EvmProviderRegistry } from '../evm/evmProviderRegistry.js'
import { stringifyError, textContent } from '../utils/format.js'
import {
  commandResultPayload,
  contractInputSchema,
  getVoidSigner,
  normalizeTxRequest,
  unsignedTxInputSchema
} from './evmToolUtils.js'

type Params = {
  server: McpServer
  evmRegistry: EvmProviderRegistry
}

function getEscrow(
  evmRegistry: EvmProviderRegistry,
  chainId: number,
  contractAddress: string,
  from?: string
): EscrowContract {
  const signer = getVoidSigner(evmRegistry, chainId, from) as any
  return new EscrowContract(getAddress(contractAddress), signer, chainId)
}

export function registerEscrowTools({ server, evmRegistry }: Params): void {
  server.registerTool(
    'escrow_get_funds',
    {
      title: 'Escrow: get token funds',
      description:
        'Reads total escrowed funds for a payment token from an Escrow contract (read-only).',
      inputSchema: {
        ...contractInputSchema,
        token: z.string().describe('Payment token address.')
      }
    },
    async ({ chainId, contractAddress, token }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress)
        const result = await escrow.getFunds(getAddress(token))
        return commandResultPayload('escrow_get_funds', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'escrow_get_user_funds',
    {
      title: 'Escrow: get user funds',
      description:
        'Reads escrowed funds for a payer and token from Escrow.getUserFunds (read-only).',
      inputSchema: {
        ...contractInputSchema,
        payer: z.string().describe('Payer address.'),
        token: z.string().describe('Payment token address.')
      }
    },
    async ({ chainId, contractAddress, payer, token }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress)
        const result = await escrow.getUserFunds(getAddress(payer), getAddress(token))
        return commandResultPayload('escrow_get_user_funds', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'escrow_get_user_tokens',
    {
      title: 'Escrow: get user tokens',
      description:
        'Reads payment token addresses for which the payer has escrow records via Escrow.getUserTokens (read-only).',
      inputSchema: {
        ...contractInputSchema,
        payer: z.string().describe('Payer address.')
      }
    },
    async ({ chainId, contractAddress, payer }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress)
        const result = await escrow.getUserTokens(getAddress(payer))
        return commandResultPayload('escrow_get_user_tokens', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'escrow_get_locks',
    {
      title: 'Escrow: get locks',
      description:
        'Reads escrow locks for token + payer + payee via Escrow.getLocks (read-only).',
      inputSchema: {
        ...contractInputSchema,
        token: z.string().describe('Payment token address.'),
        payer: z.string().describe('Payer address.'),
        payee: z.string().describe('Payee address.')
      }
    },
    async ({ chainId, contractAddress, token, payer, payee }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress)
        const result = await escrow.getLocks(
          getAddress(token),
          getAddress(payer),
          getAddress(payee)
        )
        return commandResultPayload('escrow_get_locks', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'escrow_get_authorizations',
    {
      title: 'Escrow: get authorizations',
      description:
        'Reads escrow authorizations for token + payer + payee via Escrow.getAuthorizations (read-only).',
      inputSchema: {
        ...contractInputSchema,
        token: z.string().describe('Payment token address.'),
        payer: z.string().describe('Payer address.'),
        payee: z.string().describe('Payee address.')
      }
    },
    async ({ chainId, contractAddress, token, payer, payee }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress)
        const result = await escrow.getAuthorizations(
          getAddress(token),
          getAddress(payer),
          getAddress(payee)
        )
        return commandResultPayload('escrow_get_authorizations', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'escrow_deposit',
    {
      title: 'Escrow: deposit funds',
      description:
        'Builds an unsigned transaction for Escrow.deposit.\n\nThis tool NEVER signs or broadcasts. To execute:\n- Sign the returned TransactionRequest offline using your wallet.\n- Broadcast it via broadcast_transaction(chainId, txRaw).',
      inputSchema: {
        ...contractInputSchema,
        ...unsignedTxInputSchema,
        token: z.string().describe('Payment token address.'),
        amount: z
          .string()
          .describe(
            'Human-readable token amount as expected by ocean.js contract wrapper.'
          ),
        tokenDecimals: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional token decimals override.')
      }
    },
    async ({ chainId, contractAddress, from, token, amount, tokenDecimals }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress, from)
        const tx = await escrow.depositTx(getAddress(token), amount, tokenDecimals)
        return commandResultPayload('escrow_deposit', {
          chainId,
          from: getAddress(from),
          tx: normalizeTxRequest({ ...tx, from: getAddress(from) }),
          next: {
            sign: 'Sign `tx` offline (e.g. ethers Wallet.signTransaction(tx)).',
            broadcast:
              'Call broadcast_transaction with { chainId, txRaw } where txRaw is the signed serialized transaction.'
          }
        })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'escrow_withdraw',
    {
      title: 'Escrow: withdraw funds',
      description:
        'Builds an unsigned transaction for Escrow.withdraw(tokens, amounts).\n\nThis tool NEVER signs or broadcasts. To execute:\n- Sign the returned TransactionRequest offline using your wallet.\n- Broadcast it via broadcast_transaction(chainId, txRaw).',
      inputSchema: {
        ...contractInputSchema,
        ...unsignedTxInputSchema,
        tokens: z.array(z.string()).describe('Payment token addresses.'),
        amounts: z
          .array(z.string())
          .describe('Token amounts aligned with `tokens` (human-readable strings).'),
        tokenDecimals: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional token decimals override.')
      }
    },
    async ({ chainId, contractAddress, from, tokens, amounts, tokenDecimals }) => {
      try {
        const tokensNorm = tokens.map((token) => getAddress(token))
        const escrow = getEscrow(evmRegistry, chainId, contractAddress, from)
        const tx = await escrow.withdrawTx(tokensNorm, amounts, tokenDecimals)
        return commandResultPayload('escrow_withdraw', {
          chainId,
          from: getAddress(from),
          tx: normalizeTxRequest({ ...tx, from: getAddress(from) }),
          next: {
            sign: 'Sign `tx` offline (e.g. ethers Wallet.signTransaction(tx)).',
            broadcast:
              'Call broadcast_transaction with { chainId, txRaw } where txRaw is the signed serialized transaction.'
          }
        })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'escrow_authorize',
    {
      title: 'Escrow: authorize payee',
      description:
        'Builds an unsigned transaction for Escrow.authorize(token, payee, maxLockedAmount, maxLockSeconds, maxLockCounts).\n\nThis tool NEVER signs or broadcasts. To execute:\n- Sign the returned TransactionRequest offline using your wallet.\n- Broadcast it via broadcast_transaction(chainId, txRaw).',
      inputSchema: {
        ...contractInputSchema,
        ...unsignedTxInputSchema,
        token: z.string().describe('Payment token address.'),
        payee: z.string().describe('Payee address to authorize.'),
        maxLockedAmount: z
          .string()
          .describe('Maximum lockable amount (human-readable string).'),
        maxLockSeconds: z.string().describe('Maximum lock duration in seconds (string).'),
        maxLockCounts: z.string().describe('Maximum number of locks (string).'),
        tokenDecimals: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional token decimals override.')
      }
    },
    async ({
      chainId,
      contractAddress,
      from,
      token,
      payee,
      maxLockedAmount,
      maxLockSeconds,
      maxLockCounts,
      tokenDecimals
    }) => {
      try {
        const escrow = getEscrow(evmRegistry, chainId, contractAddress, from)
        const tx = await escrow.authorizeTx(
          getAddress(token),
          getAddress(payee),
          maxLockedAmount,
          maxLockSeconds,
          maxLockCounts,
          tokenDecimals
        )
        return commandResultPayload('escrow_authorize', {
          chainId,
          from: getAddress(from),
          tx: normalizeTxRequest({ ...tx, from: getAddress(from) }),
          next: {
            sign: 'Sign `tx` offline (e.g. ethers Wallet.signTransaction(tx)).',
            broadcast:
              'Call broadcast_transaction with { chainId, txRaw } where txRaw is the signed serialized transaction.'
          }
        })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )
}
