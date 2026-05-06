import { z } from 'zod/v4'

import { stringifyError, textContent } from '../utils/format.js'
import { registerAccessListTools } from './accesslist.js'
import { registerEscrowTools } from './escrow.js'
import {
  commandResultPayload,
  getProviderOrThrow,
  type EvmToolParams
} from './evmToolUtils.js'

export function registerEvmContractTools({ server, evmRegistry }: EvmToolParams): void {
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
