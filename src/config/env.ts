const DEFAULT_NODE_URL = 'http://localhost:8000'

export type ServerConfig = {
  nodeUrl: string
  rpcUrl?: string
  chainId?: number
}

export function getServerConfig(): ServerConfig {
  const nodeUrl = process.env.NODE_URL ?? DEFAULT_NODE_URL
  const rpcUrl = process.env.RPC

  let chainId: number | undefined
  if (process.env.CHAIN_ID) {
    const parsed = Number(process.env.CHAIN_ID)
    if (!Number.isNaN(parsed)) {
      chainId = parsed
    }
  }

  return {
    nodeUrl,
    rpcUrl,
    chainId
  }
}
