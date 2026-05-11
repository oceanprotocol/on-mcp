import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { AccessListContract, AccesslistFactory } from '@oceanprotocol/lib'
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

function getAccessList(
  evmRegistry: EvmProviderRegistry,
  chainId: number,
  contractAddress: string,
  from?: string
): AccessListContract {
  const signer = getVoidSigner(evmRegistry, chainId, from) as any
  return new AccessListContract(getAddress(contractAddress), signer, chainId)
}

function getAccessListFactory(
  evmRegistry: EvmProviderRegistry,
  chainId: number,
  contractAddress: string,
  from?: string
): AccesslistFactory {
  const signer = getVoidSigner(evmRegistry, chainId, from) as any
  return new AccesslistFactory(getAddress(contractAddress), signer, chainId)
}

export function registerAccessListTools({ server, evmRegistry }: Params): void {
  server.registerTool(
    'accesslist_get_details',
    {
      title: 'AccessList: get details',
      description:
        'Reads core AccessList metadata: id, owner, name, and symbol from an AccessList contract (read-only).',
      inputSchema: { ...contractInputSchema }
    },
    async ({ chainId, contractAddress }) => {
      try {
        const accessList = getAccessList(evmRegistry, chainId, contractAddress)
        const [id, owner, name, symbol] = await Promise.all([
          accessList.getId(),
          accessList.getOwner(),
          accessList.getName(),
          accessList.getSymbol()
        ])
        return commandResultPayload('accesslist_get_details', {
          id,
          owner,
          name,
          symbol
        })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'accesslist_get_token_uri',
    {
      title: 'AccessList: get token URI',
      description: 'Reads tokenURI(tokenId) from an AccessList contract (read-only).',
      inputSchema: {
        ...contractInputSchema,
        tokenId: z.number().int().nonnegative().describe('AccessList token id.')
      }
    },
    async ({ chainId, contractAddress, tokenId }) => {
      try {
        const accessList = getAccessList(evmRegistry, chainId, contractAddress)
        const result = await accessList.getTokenUri(tokenId)
        return commandResultPayload('accesslist_get_token_uri', {
          tokenId,
          tokenUri: result
        })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'accesslist_mint',
    {
      title: 'AccessList: mint',
      description:
        'Builds an unsigned transaction for AccessList.mint(user, tokenUri).\n\nThis tool NEVER signs or broadcasts. To execute:\n- Sign the returned TransactionRequest offline using your wallet.\n- Broadcast it via broadcast_transaction(chainId, txRaw).',
      inputSchema: {
        ...contractInputSchema,
        ...unsignedTxInputSchema,
        user: z.string().describe('Address to receive the access token.'),
        tokenUri: z.string().describe('Token URI metadata for the minted token.')
      }
    },
    async ({ chainId, contractAddress, from, user, tokenUri }) => {
      try {
        const accessList = getAccessList(evmRegistry, chainId, contractAddress, from)
        const tx = await accessList.mintTx(getAddress(user), tokenUri)
        return commandResultPayload('accesslist_mint', {
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
    'accesslist_factory_is_deployed',
    {
      title: 'AccessListFactory: is deployed',
      description:
        'Checks AccessListFactory.isDeployed(contractAddress) for an AccessList contract (read-only).',
      inputSchema: {
        ...contractInputSchema,
        listAddress: z.string().describe('AccessList contract address to verify.')
      }
    },
    async ({ chainId, contractAddress, listAddress }) => {
      try {
        const factory = getAccessListFactory(evmRegistry, chainId, contractAddress)
        const result = await factory.isDeployed(getAddress(listAddress))
        return commandResultPayload('accesslist_factory_is_deployed', {
          listAddress: getAddress(listAddress),
          isDeployed: result
        })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'accesslist_factory_deploy',
    {
      title: 'AccessListFactory: deploy access list',
      description:
        'Builds an unsigned transaction for AccessListFactory.deployAccessListContract.\n\nThis tool NEVER signs or broadcasts. To execute:\n- Sign the returned TransactionRequest offline using your wallet.\n- Broadcast it via broadcast_transaction(chainId, txRaw).\n\nNote: the deployed AccessList address must be discovered from the broadcasted tx receipt logs (factory emits an event).',
      inputSchema: {
        ...contractInputSchema,
        ...unsignedTxInputSchema,
        nameAccessList: z.string().describe('Name for new AccessList.'),
        symbolAccessList: z.string().describe('Symbol for new AccessList.'),
        tokenURI: z.array(z.string()).describe('List of token URIs for initial users.'),
        transferable: z
          .boolean()
          .optional()
          .describe('If false (default), list is soulbound.'),
        owner: z.string().describe('Owner address of the new AccessList.'),
        user: z
          .array(z.string())
          .describe('User addresses to mint in initial deployment.')
      }
    },
    async ({
      chainId,
      contractAddress,
      from,
      nameAccessList,
      symbolAccessList,
      tokenURI,
      transferable,
      owner,
      user
    }) => {
      try {
        const users = user.map((address) => getAddress(address))
        const factory = getAccessListFactory(evmRegistry, chainId, contractAddress, from)
        const tx = await factory.deployAccessListContractTx(
          nameAccessList,
          symbolAccessList,
          tokenURI,
          transferable ?? false,
          getAddress(owner),
          users
        )
        return commandResultPayload('accesslist_factory_deploy', {
          chainId,
          from: getAddress(from),
          tx: normalizeTxRequest({ ...tx, from: getAddress(from) }),
          next: {
            sign: 'Sign `tx` offline (e.g. ethers Wallet.signTransaction(tx)).',
            broadcast:
              'Call broadcast_transaction with { chainId, txRaw } where txRaw is the signed serialized transaction.',
            deployedAddress:
              'After broadcasting, read the tx receipt logs to obtain the deployed AccessList address (factory emits an event).'
          }
        })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )
}
