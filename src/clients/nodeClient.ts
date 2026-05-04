import {
  ProviderInstance,
  type ComputeAlgorithm,
  type ComputeAsset,
  type ComputeJobMetadata,
  type ComputeOutput,
  type ComputeResourceRequest,
  type dockerRegistryAuth,
  type PersistentStorageCreateBucketRequest,
  type SignerOrAuthTokenOrSignature,
  type StorageObject
} from '@oceanprotocol/lib'
import type { DDO } from '@oceanprotocol/ddo-js'
import type { Multiaddr } from '@multiformats/multiaddr'

type NodeP2P = {
  nodeId: string | null
  multiaddress?: Multiaddr[]
}

function getP2p() {
  return ProviderInstance.getP2PProvider()
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms
        )
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function* singleChunkUint8(buf: Uint8Array): AsyncIterable<Uint8Array> {
  yield buf
}

export class NodeClient {
  /* async directCommand<T = unknown>(
    command: ProtocolCommand,
    payload: Record<string, unknown> = {},
    node: nodeDetails = {}
  ): Promise<T> {
    const body = {
      command,
      ...payload,
      ...(options.node ? { node: options.node } : {}),
      ...(options.multiAddrs ? { multiAddrs: options.multiAddrs } : {})
    }

    const response = await fetch(`${this.nodeUrl}/directCommand`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })

    const responseText = await response.text()
    if (!response.ok) {
      throw new Error(
        `Ocean node command "${command}" failed (${response.status}): ${responseText}`
      )
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (contentType.includes('application/json')) {
      return JSON.parse(responseText) as T
    }

    return responseText as T
  } */

  async status<T = unknown>(node: NodeP2P, timeout: number): Promise<T> {
    try {
      const result = await ProviderInstance.getNodeStatus(
        node,
        AbortSignal.timeout(timeout)
      )
      return result as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`Failed to fetch node status: ${message}`)
    }
  }

  async findProviderForString<T = unknown>(content: string, timeout: number): Promise<T> {
    try {
      const result = await getP2p().getProvidersForString(
        content,
        AbortSignal.timeout(timeout)
      )
      return result as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`Failed to fetch providers: ${message}`)
    }
  }

  async getComputeEnvironments<T = unknown>(node: NodeP2P, timeout: number): Promise<T> {
    try {
      const result = await getP2p().getComputeEnvironments(
        node,
        AbortSignal.timeout(timeout)
      )
      return result as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`Failed to fetch compute environments: ${message}`)
    }
  }

  async resolveDdo<T = unknown>(node: NodeP2P, did: string, timeout: number): Promise<T> {
    try {
      return (await getP2p().resolveDdo(node, did, AbortSignal.timeout(timeout))) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P resolveDdo failed: ${message}`)
    }
  }

  async validateDdo<T = unknown>(
    node: NodeP2P,
    ddo: DDO,
    auth: SignerOrAuthTokenOrSignature,
    timeout: number
  ): Promise<T> {
    try {
      return (await getP2p().validateDdo(
        node,
        ddo,
        auth,
        AbortSignal.timeout(timeout)
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P validateDdo failed: ${message}`)
    }
  }

  async getNodeJobs<T = unknown>(
    node: NodeP2P,
    timeout: number,
    fromTimestamp?: number
  ): Promise<T> {
    try {
      return (await getP2p().getNodeJobs(
        node,
        fromTimestamp,
        AbortSignal.timeout(timeout)
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P getNodeJobs failed: ${message}`)
    }
  }

  async getNonce(
    node: NodeP2P,
    consumerAddress: string,
    timeout: number
  ): Promise<number> {
    try {
      return await getP2p().getNonce(node, consumerAddress, AbortSignal.timeout(timeout))
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P getNonce failed: ${message}`)
    }
  }

  async getFileInfo<T = unknown>(
    file: StorageObject,
    node: NodeP2P,
    withChecksum: boolean,
    timeout: number
  ): Promise<T> {
    try {
      return (await getP2p().getFileInfo(
        file,
        node,
        withChecksum,
        AbortSignal.timeout(timeout)
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P getFileInfo failed: ${message}`)
    }
  }

  async initializeCompute<T = unknown>(
    node: NodeP2P,
    timeout: number,
    params: {
      assets: ComputeAsset[]
      algorithm: ComputeAlgorithm
      computeEnv: string
      token: string
      validUntil: number
      consumerAddress: string
      resources: ComputeResourceRequest[]
      chainId: number
      policyServer?: unknown
      queueMaxWaitTime?: number
      dockerRegistryAuthData?: dockerRegistryAuth
      output?: ComputeOutput
    }
  ): Promise<T> {
    try {
      return (await getP2p().initializeCompute(
        params.assets,
        params.algorithm,
        params.computeEnv,
        params.token,
        params.validUntil,
        node,
        params.consumerAddress,
        params.resources,
        params.chainId,
        params.policyServer,
        AbortSignal.timeout(timeout),
        params.queueMaxWaitTime,
        params.dockerRegistryAuthData,
        params.output
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P initializeCompute failed: ${message}`)
    }
  }

  async computeStart<T = unknown>(
    node: NodeP2P,
    auth: SignerOrAuthTokenOrSignature,
    timeout: number,
    params: {
      computeEnv: string
      datasets: ComputeAsset[]
      algorithm: ComputeAlgorithm
      maxJobDuration: number
      token: string
      resources: ComputeResourceRequest[]
      chainId: number
      metadata?: ComputeJobMetadata
      additionalViewers?: string[]
      output?: ComputeOutput
      policyServer?: unknown
      queueMaxWaitTime?: number
      dockerRegistryAuth?: dockerRegistryAuth
    }
  ): Promise<T> {
    try {
      return (await getP2p().computeStart(
        node,
        auth,
        params.computeEnv,
        params.datasets,
        params.algorithm,
        params.maxJobDuration,
        params.token,
        params.resources,
        params.chainId,
        params.metadata,
        params.additionalViewers,
        params.output,
        params.policyServer,
        AbortSignal.timeout(timeout),
        params.queueMaxWaitTime,
        params.dockerRegistryAuth
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P computeStart failed: ${message}`)
    }
  }

  async freeComputeStart<T = unknown>(
    node: NodeP2P,
    auth: SignerOrAuthTokenOrSignature,
    timeout: number,
    params: {
      computeEnv: string
      datasets: ComputeAsset[]
      algorithm: ComputeAlgorithm
      resources?: ComputeResourceRequest[]
      metadata?: ComputeJobMetadata
      additionalViewers?: string[]
      output?: ComputeOutput
      policyServer?: unknown
      queueMaxWaitTime?: number
      dockerRegistryAuth?: dockerRegistryAuth
    }
  ): Promise<T> {
    try {
      return (await getP2p().freeComputeStart(
        node,
        auth,
        params.computeEnv,
        params.datasets,
        params.algorithm,
        params.resources,
        params.metadata,
        params.additionalViewers,
        params.output,
        params.policyServer,
        AbortSignal.timeout(timeout),
        params.queueMaxWaitTime,
        params.dockerRegistryAuth
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P freeComputeStart failed: ${message}`)
    }
  }

  async computeStop<T = unknown>(
    jobId: string,
    node: NodeP2P,
    auth: SignerOrAuthTokenOrSignature,
    timeout: number,
    agreementId?: string
  ): Promise<T> {
    try {
      return (await getP2p().computeStop(
        jobId,
        node,
        auth,
        agreementId,
        AbortSignal.timeout(timeout)
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P computeStop failed: ${message}`)
    }
  }

  async computeStatus<T = unknown>(
    node: NodeP2P,
    auth: SignerOrAuthTokenOrSignature,
    timeout: number,
    jobId?: string,
    agreementId?: string
  ): Promise<T> {
    try {
      return (await getP2p().computeStatus(
        node,
        auth,
        jobId,
        agreementId,
        AbortSignal.timeout(timeout)
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P computeStatus failed: ${message}`)
    }
  }

  /** Collects streamed compute result bytes; large jobs may produce very large base64. */
  async getComputeResultBase64(
    node: NodeP2P,
    auth: SignerOrAuthTokenOrSignature,
    jobId: string,
    index: number,
    offset: number,
    timeout: number
  ): Promise<{ dataBase64: string; byteLength: number }> {
    try {
      const stream = await getP2p().getComputeResult(node, auth, jobId, index, offset)
      const chunks: Uint8Array[] = []
      for await (const chunk of stream) {
        const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
        chunks.push(u8)
      }
      let total = 0
      for (const c of chunks) total += c.length
      const merged = new Uint8Array(total)
      let pos = 0
      for (const c of chunks) {
        merged.set(c, pos)
        pos += c.length
      }
      return {
        dataBase64: Buffer.from(merged).toString('base64'),
        byteLength: total
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P getComputeResult failed: ${message}`)
    }
  }

  async downloadNodeLogs<T = unknown>(
    node: NodeP2P,
    auth: SignerOrAuthTokenOrSignature,
    timeout: number,
    params: {
      startTime: string
      endTime: string
      maxLogs?: number
      moduleName?: string
      level?: string
      page?: number
    }
  ): Promise<T> {
    try {
      return (await getP2p().downloadNodeLogs(
        node,
        auth,
        params.startTime,
        params.endTime,
        params.maxLogs,
        params.moduleName,
        params.level,
        params.page,
        AbortSignal.timeout(timeout)
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P downloadNodeLogs failed: ${message}`)
    }
  }

  async createPersistentStorageBucket<T = unknown>(
    node: NodeP2P,
    auth: SignerOrAuthTokenOrSignature,
    payload: PersistentStorageCreateBucketRequest,
    timeout: number
  ): Promise<T> {
    try {
      return (await getP2p().createPersistentStorageBucket(
        node,
        auth,
        payload,
        AbortSignal.timeout(timeout)
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P createPersistentStorageBucket failed: ${message}`)
    }
  }

  async getPersistentStorageBuckets<T = unknown>(
    node: NodeP2P,
    auth: SignerOrAuthTokenOrSignature,
    owner: string,
    timeout: number
  ): Promise<T> {
    try {
      return (await getP2p().getPersistentStorageBuckets(
        node,
        auth,
        owner,
        AbortSignal.timeout(timeout)
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P getPersistentStorageBuckets failed: ${message}`)
    }
  }

  async listPersistentStorageFiles<T = unknown>(
    node: NodeP2P,
    auth: SignerOrAuthTokenOrSignature,
    bucketId: string,
    timeout: number
  ): Promise<T> {
    try {
      return (await getP2p().listPersistentStorageFiles(
        node,
        auth,
        bucketId,
        AbortSignal.timeout(timeout)
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P listPersistentStorageFiles failed: ${message}`)
    }
  }

  async getPersistentStorageFileObject<T = unknown>(
    node: NodeP2P,
    auth: SignerOrAuthTokenOrSignature,
    bucketId: string,
    fileName: string,
    timeout: number
  ): Promise<T> {
    try {
      return (await getP2p().getPersistentStorageFileObject(
        node,
        auth,
        bucketId,
        fileName,
        AbortSignal.timeout(timeout)
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P getPersistentStorageFileObject failed: ${message}`)
    }
  }

  async deletePersistentStorageFile<T = unknown>(
    node: NodeP2P,
    auth: SignerOrAuthTokenOrSignature,
    bucketId: string,
    fileName: string,
    timeout: number
  ): Promise<T> {
    try {
      return (await getP2p().deletePersistentStorageFile(
        node,
        auth,
        bucketId,
        fileName,
        AbortSignal.timeout(timeout)
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P deletePersistentStorageFile failed: ${message}`)
    }
  }

  async getDownloadFees<T = unknown>(
    node: NodeP2P,
    timeout: number,
    params: {
      did: string
      serviceId: string
      fileIndex: number
      consumerAddress: string
      userCustomParameters?: Record<string, unknown>
      computeEnv?: string
      validUntil?: number
    }
  ): Promise<T> {
    try {
      return (await getP2p().initialize(
        params.did,
        params.serviceId,
        params.fileIndex,
        params.consumerAddress,
        node,
        AbortSignal.timeout(timeout),
        params.userCustomParameters as never,
        params.computeEnv,
        params.validUntil
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P initialize (getFees) failed: ${message}`)
    }
  }

  async downloadAssetFileBase64(
    node: NodeP2P,
    auth: SignerOrAuthTokenOrSignature,
    timeout: number,
    params: {
      did: string
      serviceId: string
      fileIndex: number
      transferTxId: string
      policyServer?: unknown
      userCustomParameters?: Record<string, unknown>
    }
  ): Promise<{ dataBase64: string; byteLength: number; filename: string }> {
    try {
      const res = await withTimeout(
        getP2p().getDownloadUrl(
          params.did,
          params.serviceId,
          params.fileIndex,
          params.transferTxId,
          node,
          auth,
          params.policyServer,
          params.userCustomParameters as never
        ),
        timeout,
        'getDownloadUrl'
      )
      const u8 = new Uint8Array(res.data)
      return {
        dataBase64: Buffer.from(u8).toString('base64'),
        byteLength: u8.byteLength,
        filename: res.filename ?? `file${params.fileIndex}`
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P getDownloadUrl failed: ${message}`)
    }
  }

  async encryptBlob<T = unknown>(
    node: NodeP2P,
    auth: SignerOrAuthTokenOrSignature,
    chainId: number,
    data: string,
    timeout: number,
    policyServer?: unknown
  ): Promise<T> {
    try {
      return (await getP2p().encrypt(
        data,
        chainId,
        node,
        auth,
        policyServer,
        AbortSignal.timeout(timeout)
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P encrypt failed: ${message}`)
    }
  }

  async checkDidFiles<T = unknown>(
    node: NodeP2P,
    did: string,
    serviceId: string,
    withChecksum: boolean,
    timeout: number
  ): Promise<T> {
    try {
      return (await getP2p().checkDidFiles(
        did,
        serviceId,
        node,
        withChecksum,
        AbortSignal.timeout(timeout)
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P checkDidFiles failed: ${message}`)
    }
  }

  async createAuthToken(
    node: NodeP2P,
    address: string,
    signature: string,
    nonce: string,
    timeout: number
  ): Promise<string> {
    try {
      const token = await getP2p().generateSignedAuthToken(
        address,
        signature,
        nonce,
        node,
        AbortSignal.timeout(timeout)
      )
      return typeof token === 'string' ? token : `${token}`
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P createAuthToken failed: ${message}`)
    }
  }

  async policyServerPassthrough<T = unknown>(
    node: NodeP2P,
    request: Record<string, unknown>,
    timeout: number
  ): Promise<T> {
    try {
      return (await getP2p().PolicyServerPassthrough(
        node,
        request as never,
        AbortSignal.timeout(timeout)
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P PolicyServerPassthrough failed: ${message}`)
    }
  }

  async initializePolicyServerVerification<T = unknown>(
    node: NodeP2P,
    request: Record<string, unknown>,
    timeout: number
  ): Promise<T> {
    try {
      return (await getP2p().initializePSVerification(
        node,
        request as never,
        AbortSignal.timeout(timeout)
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P initializePSVerification failed: ${message}`)
    }
  }

  async getComputeResultUrl<T = unknown>(
    node: NodeP2P,
    auth: SignerOrAuthTokenOrSignature,
    jobId: string,
    index: number,
    timeout: number
  ): Promise<T> {
    try {
      return (await withTimeout(
        getP2p().getComputeResultUrl(node, auth, jobId, index) as Promise<T>,
        timeout,
        'getComputeResultUrl'
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P getComputeResultUrl failed: ${message}`)
    }
  }

  /** Collects streamable compute log bytes (same framing as getComputeResult). */
  async computeStreamableLogsBase64(
    node: NodeP2P,
    auth: SignerOrAuthTokenOrSignature,
    jobId: string,
    timeout: number
  ): Promise<{ dataBase64: string; byteLength: number }> {
    try {
      const raw = await getP2p().computeStreamableLogs(
        node,
        auth,
        jobId,
        AbortSignal.timeout(timeout)
      )
      const iterable = raw as AsyncIterable<Uint8Array>
      const chunks: Uint8Array[] = []
      for await (const chunk of iterable) {
        const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
        chunks.push(u8)
      }
      let total = 0
      for (const c of chunks) total += c.length
      const merged = new Uint8Array(total)
      let pos = 0
      for (const c of chunks) {
        merged.set(c, pos)
        pos += c.length
      }
      return {
        dataBase64: Buffer.from(merged).toString('base64'),
        byteLength: total
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P computeStreamableLogs failed: ${message}`)
    }
  }

  async uploadPersistentStorageFile<T = unknown>(
    node: NodeP2P,
    auth: SignerOrAuthTokenOrSignature,
    bucketId: string,
    fileName: string,
    contentBase64: string,
    timeout: number
  ): Promise<T> {
    try {
      const buf = Buffer.from(contentBase64, 'base64')
      return (await getP2p().uploadPersistentStorageFile(
        node,
        auth,
        bucketId,
        fileName,
        singleChunkUint8(new Uint8Array(buf)),
        AbortSignal.timeout(timeout)
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P uploadPersistentStorageFile failed: ${message}`)
    }
  }

  async fetchNodeConfig<T = unknown>(
    node: NodeP2P,
    payload: Record<string, unknown>,
    timeout: number
  ): Promise<T> {
    try {
      return (await withTimeout(
        getP2p().fetchConfig(node, payload) as Promise<T>,
        timeout,
        'fetchConfig'
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P fetchConfig failed: ${message}`)
    }
  }

  async pushNodeConfig<T = unknown>(
    node: NodeP2P,
    payload: Record<string, unknown>,
    timeout: number
  ): Promise<T> {
    try {
      return (await withTimeout(
        getP2p().pushConfig(node, payload) as Promise<T>,
        timeout,
        'pushConfig'
      )) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P pushConfig failed: ${message}`)
    }
  }

  async isValidProvider(node: NodeP2P, timeout: number): Promise<boolean> {
    try {
      return await getP2p().isValidProvider(node, AbortSignal.timeout(timeout))
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P isValidProvider failed: ${message}`)
    }
  }

  async resolvePeerMultiaddr(peerId: string): Promise<string> {
    try {
      return await getP2p().getMultiaddrFromPeerId(peerId)
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P getMultiaddrFromPeerId failed: ${message}`)
    }
  }

  async listDiscoveredPeers(): Promise<Array<{ peerId: string; multiaddrs: string[] }>> {
    try {
      return await getP2p().getDiscoveredNodes()
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P getDiscoveredNodes failed: ${message}`)
    }
  }

  async cidFromRawString(data: string): Promise<{ str: string }> {
    try {
      const cid = await getP2p().cidFromRawString(data)
      return { str: cid.toString() }
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`P2P cidFromRawString failed: ${message}`)
    }
  }
}
