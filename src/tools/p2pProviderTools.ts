import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'
import { DDO, ProviderInstance, PROTOCOL_COMMANDS } from '@oceanprotocol/lib'
import { NodeClient } from '../clients/nodeClient.js'
import { stringifyError, textContent, toPrettyJson } from '../utils/format.js'
import { buildC2dProviderSearchContent } from '../utils/c2dProviderSearchString.js'
import { toJsonFriendly } from './evmToolUtils.js'
import {
  completeSignatureSchema,
  findProviderInputSchema,
  nodeTargetSchema,
  parseNodeTarget,
  P2P_ADMIN_CONFIG_WARNING,
  P2P_AUTH_SIGNING_GUIDE,
  P2P_PERSISTENT_STORAGE_PREREQUISITE,
  p2pAuthFieldSchemas,
  resolveAuth,
  timeoutMs
} from './p2pSchemas.js'

type Params = { server: McpServer; nodeClient: NodeClient }

function commandResultPayload(command: string, result: unknown) {
  return textContent(
    toPrettyJson({
      command,
      result: toJsonFriendly(result)
    })
  )
}

export function registerP2pProviderTools({ server, nodeClient }: Params): void {
  server.registerTool(
    'mcp_server_peers',
    {
      title: 'Get all peers for MCP Server',
      description: 'Gets all peers connected to this MCP Server (libp2p peer store).'
    },
    async () => {
      try {
        const result = await ProviderInstance.getLibp2pNode().peerStore.all()
        return commandResultPayload('mcp_server_peers', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'node_status',
    {
      title: 'Get node status',
      description:
        'Gets ocean-node status via the P2P **status** command. Use **nodeId** and/or **multiaddress** to target the peer. The payload may include **persistentStorage** (object, optionally with **accessLists**) only when the node has persistent storage configured—agents must use this to decide if persistent storage bucket/file tools are allowed for that node.',
      inputSchema: { ...nodeTargetSchema }
    },
    async ({ nodeId, multiaddress, timeout }) => {
      try {
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.status(node, timeoutMs(timeout))
        return commandResultPayload('node_status', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'buildFindProviderC2dContent',
    {
      title: 'Build C2D find_provider search string',
      description: `Returns the exact **content** string to pass to **find_provider** for compute (C2D) capacity discovery. Matches ocean-node **p2pAnnounceC2D** and **advertiseString(JSON.stringify({ c2d: obj }))**.

Specify **exactly one** resource: **cpu**, **gpu**, **ramGb**, or **diskGb** (positive integers). **free: true** = free tier announcements; **free: false** = paid.

GPU extras (optional): **description** only with paid GPU (free: false); **kind** only with free GPU (free: true).

**Returns:** command + result with **content** (pass to find_provider) and **inner** (parsed object).

For **multiple** dimensions (e.g. 2 CPUs **and** 8 GB RAM), build one **content** per dimension, run **find_provider** for each, then **intersect** peers by **id**. See resource **ocean://docs/c2d-find-provider-search** (section *Compound requirements*).`,
      inputSchema: {
        free: z
          .boolean()
          .describe('true = free-tier C2D announcements; false = paid-tier.'),
        cpu: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('CPU core count (mutually exclusive with gpu, ramGb, diskGb).'),
        gpu: z.number().int().positive().optional().describe('GPU core count.'),
        ramGb: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('RAM in gigabytes (JSON key in search string is "ram").'),
        diskGb: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Disk in gigabytes (JSON key in search string is "disk").'),
        description: z
          .string()
          .optional()
          .describe(
            'Paid GPU only: matches node second variant with resource.description.'
          ),
        kind: z
          .string()
          .optional()
          .describe('Free GPU only: matches node second variant with resource kind.')
      }
    },
    (args) => {
      try {
        const { content, inner } = buildC2dProviderSearchContent({
          free: args.free,
          cpu: args.cpu,
          gpu: args.gpu,
          ramGb: args.ramGb,
          diskGb: args.diskGb,
          description: args.description,
          kind: args.kind
        })
        return commandResultPayload('buildFindProviderC2dContent', { content, inner })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'find_provider',
    {
      title: 'Find provider for specific string',
      description:
        'DHT lookup: hashes content (SHA-256) and returns peers that provided that exact string. For C2D use **buildFindProviderC2dContent**. For AND across dimensions (e.g. CPU + RAM), run one query per dimension and intersect results by peer **id** — see ocean://docs/c2d-find-provider-search.',
      inputSchema: { ...findProviderInputSchema }
    },
    async ({ content, timeout }) => {
      try {
        const result = await nodeClient.findProviderForString(content, timeoutMs(timeout))
        return commandResultPayload('find_provider', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'getComputeEnvironments',
    {
      title: 'Get compute environments for a specific node',
      description:
        'Calls P2pProvider.getComputeEnvironments — lists compute environments exposed by the target node (no auth).',
      inputSchema: { ...nodeTargetSchema }
    },
    async ({ nodeId, multiaddress, timeout }) => {
      try {
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.getComputeEnvironments(node, timeoutMs(timeout))
        return commandResultPayload('getComputeEnvironments', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'resolveDdo',
    {
      title: 'P2P resolve DDO (getDDO)',
      description: `Fetches a DDO by DID from a target ocean-node over libp2p (\`P2pProvider.resolveDdo\`). No consumer signature.

**Returns:** Raw node response for \`getDDO\` (typically the DDO JSON object or node-specific envelope).`,
      inputSchema: {
        ...nodeTargetSchema,
        did: z.string().describe('Asset DID to resolve (e.g. did:op:...).')
      }
    },
    async ({ nodeId, multiaddress, timeout, did }) => {
      try {
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.resolveDdo(node, did, timeoutMs(timeout))
        return commandResultPayload('resolveDdo', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'validateDdo',
    {
      title: 'P2P validate DDO',
      description: `Runs \`validateDDO\` on the node with a full DDO payload. Requires auth.

${P2P_AUTH_SIGNING_GUIDE}

**protocolCommand for signing:** \`validateDDO\` (PROTOCOL_COMMANDS.VALIDATE_DDO).

**Returns:** Validation metadata (\`valid\`, \`hash\`, \`proof\` with validator fields) or null if the node reports an error.`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        ddo: z
          .record(z.string(), z.unknown())
          .describe(
            'Complete DDO object as JSON (same shape as on-chain / Aquarius DDO).'
          )
      }
    },
    async ({ nodeId, multiaddress, timeout, authToken, completeSignature, ddo }) => {
      try {
        const auth = resolveAuth(authToken, completeSignature)
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.validateDdo(
          node,
          ddo as unknown as DDO,
          auth,
          timeoutMs(timeout)
        )
        return commandResultPayload('validateDdo', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'getNodeJobs',
    {
      title: 'P2P list node compute jobs',
      description: `Calls \`jobs\` on the node (\`P2pProvider.getNodeJobs\`). No auth.

**Inputs:** optional \`fromTimestamp\` filters jobs (Unix ms) when supported by the node.

**Returns:** Array of \`NodeComputeJob\` objects (jobId, status, environment, payment, etc.) or empty array on failure paths inside the library.`,
      inputSchema: {
        ...nodeTargetSchema,
        fromTimestamp: z
          .number()
          .optional()
          .describe('Optional Unix timestamp (ms) — only jobs after this time.')
      }
    },
    async ({ nodeId, multiaddress, timeout, fromTimestamp }) => {
      try {
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.getNodeJobs(
          node,
          timeoutMs(timeout),
          fromTimestamp
        )
        return commandResultPayload('getNodeJobs', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'getNonce',
    {
      title: 'P2P get consumer nonce',
      description: `Returns the node’s current nonce for an address (\`P2pProvider.getNonce\`). **No auth.** Use this before building a \`completeSignature\`: the value you sign with must use **nonce = String(returnedNonce + 1)** (see auth guide).

**Returns:** Integer nonce (number).`,
      inputSchema: {
        ...nodeTargetSchema,
        consumerAddress: z
          .string()
          .describe('Ethereum address (0x...) for which the node tracks nonces.')
      }
    },
    async ({ nodeId, multiaddress, timeout, consumerAddress }) => {
      try {
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.getNonce(
          node,
          consumerAddress,
          timeoutMs(timeout)
        )
        return commandResultPayload('getNonce', { nonce: result })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'getFileInfo',
    {
      title: 'P2P get file info',
      description: `Resolves file metadata via \`fileInfo\` (\`P2pProvider.getFileInfo\`). No consumer signature. \`file\` must be a \`StorageObject\` (url, ipfs, arweave, s3, ftp, or nodePersistentStorage).

**Returns:** Array of \`FileInfo\` entries (length 1 for a single object).`,
      inputSchema: {
        ...nodeTargetSchema,
        file: z
          .record(z.string(), z.unknown())
          .describe(
            'StorageObject JSON, e.g. { type: "url", url, method, headers } or { type: "ipfs", hash }.'
          ),
        withChecksum: z
          .boolean()
          .optional()
          .describe('Request checksum in file info when true. Default: false.')
      }
    },
    async ({ nodeId, multiaddress, timeout, file, withChecksum }) => {
      try {
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.getFileInfo(
          file as never,
          node,
          withChecksum ?? false,
          timeoutMs(timeout)
        )
        return commandResultPayload('getFileInfo', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  const computeAssetList = z
    .array(z.record(z.string(), z.unknown()))
    .describe(
      'ComputeAsset[]: each needs documentId, serviceId; optional fileObject, transferTxId, userdata.'
    )

  const computeAlgorithmSchema = z
    .record(z.string(), z.unknown())
    .describe(
      'ComputeAlgorithm: meta.container (image, tag, entrypoint, checksum), optional documentId, serviceId, transferTxId, envs, etc.'
    )

  const computeResourcesSchema = z
    .array(z.record(z.string(), z.unknown()))
    .describe('ComputeResourceRequest[]: { id, amount } per requested resource.')

  server.registerTool(
    'initializeCompute',
    {
      title: 'P2P initialize compute',
      description: `Price / validation step for compute (\`initializeCompute\`). **Does not require** authToken or signature in ocean.js; the node validates parameters and returns payment / fee hints (\`ProviderComputeInitializeResults\`).

**Returns:** Object with optional \`algorithm\`, \`datasets\`, \`payment\` (escrow, token, amounts) fields.`,
      inputSchema: {
        ...nodeTargetSchema,
        assets: computeAssetList,
        algorithm: computeAlgorithmSchema,
        computeEnv: z
          .string()
          .describe('Compute environment id from getComputeEnvironments.'),
        token: z.string().describe('Fee token address (0x) for payment on chainId.'),
        validUntil: z
          .number()
          .describe(
            'Max job duration / validity window (seconds) as expected by the node.'
          ),
        consumerAddress: z.string(),
        resources: computeResourcesSchema,
        chainId: z.number(),
        policyServer: z.record(z.string(), z.unknown()).optional(),
        queueMaxWaitTime: z.number().optional(),
        dockerRegistryAuthData: z.record(z.string(), z.unknown()).optional(),
        output: z.record(z.string(), z.unknown()).optional()
      }
    },
    async (args) => {
      try {
        const {
          nodeId,
          multiaddress,
          timeout,
          assets,
          algorithm,
          computeEnv,
          token,
          validUntil,
          consumerAddress,
          resources,
          chainId,
          policyServer,
          queueMaxWaitTime,
          dockerRegistryAuthData,
          output
        } = args
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.initializeCompute(node, timeoutMs(timeout), {
          assets: assets as never,
          algorithm: algorithm as never,
          computeEnv,
          token,
          validUntil,
          consumerAddress,
          resources: resources as never,
          chainId,
          policyServer,
          queueMaxWaitTime,
          dockerRegistryAuthData: dockerRegistryAuthData as never,
          output: output as never
        })
        return commandResultPayload('initializeCompute', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'computeStart',
    {
      title: 'P2P start paid compute',
      description: `Starts a paid compute job (\`startCompute\`). Requires auth.

${P2P_AUTH_SIGNING_GUIDE}

**protocolCommand:** \`startCompute\`.

**Returns:** \`ComputeJob\` or array of jobs (node-dependent).`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        computeEnv: z.string(),
        datasets: computeAssetList,
        algorithm: computeAlgorithmSchema,
        maxJobDuration: z.number(),
        token: z.string().describe('Fee token contract address.'),
        resources: computeResourcesSchema,
        chainId: z.number(),
        metadata: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional(),
        additionalViewers: z.array(z.string()).optional(),
        output: z.record(z.string(), z.unknown()).optional(),
        policyServer: z.record(z.string(), z.unknown()).optional(),
        queueMaxWaitTime: z.number().optional(),
        dockerRegistryAuth: z.record(z.string(), z.unknown()).optional()
      }
    },
    async (args) => {
      try {
        const auth = resolveAuth(args.authToken, args.completeSignature)
        const node = parseNodeTarget(args.nodeId, args.multiaddress)
        const result = await nodeClient.computeStart(
          node,
          auth,
          timeoutMs(args.timeout),
          {
            computeEnv: args.computeEnv,
            datasets: args.datasets as never,
            algorithm: args.algorithm as never,
            maxJobDuration: args.maxJobDuration,
            token: args.token,
            resources: args.resources as never,
            chainId: args.chainId,
            metadata: args.metadata,
            additionalViewers: args.additionalViewers,
            output: args.output as never,
            policyServer: args.policyServer,
            queueMaxWaitTime: args.queueMaxWaitTime,
            dockerRegistryAuth: args.dockerRegistryAuth as never
          }
        )
        return commandResultPayload('computeStart', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'freeComputeStart',
    {
      title: 'P2P start free compute',
      description: `Starts a free compute job (\`freeStartCompute\`). Requires auth.

${P2P_AUTH_SIGNING_GUIDE}

**protocolCommand:** \`freeStartCompute\`.

**Returns:** \`ComputeJob\` or array.`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        computeEnv: z.string(),
        datasets: computeAssetList,
        algorithm: computeAlgorithmSchema,
        resources: computeResourcesSchema.optional(),
        metadata: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional(),
        additionalViewers: z.array(z.string()).optional(),
        output: z.record(z.string(), z.unknown()).optional(),
        policyServer: z.record(z.string(), z.unknown()).optional(),
        queueMaxWaitTime: z.number().optional(),
        dockerRegistryAuth: z.record(z.string(), z.unknown()).optional()
      }
    },
    async (args) => {
      try {
        const auth = resolveAuth(args.authToken, args.completeSignature)
        const node = parseNodeTarget(args.nodeId, args.multiaddress)
        const result = await nodeClient.freeComputeStart(
          node,
          auth,
          timeoutMs(args.timeout),
          {
            computeEnv: args.computeEnv,
            datasets: args.datasets as never,
            algorithm: args.algorithm as never,
            resources: args.resources as never,
            metadata: args.metadata,
            additionalViewers: args.additionalViewers,
            output: args.output as never,
            policyServer: args.policyServer,
            queueMaxWaitTime: args.queueMaxWaitTime,
            dockerRegistryAuth: args.dockerRegistryAuth as never
          }
        )
        return commandResultPayload('freeComputeStart', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'computeStop',
    {
      title: 'P2P stop compute job',
      description: `Stops a running job (\`stopCompute\`). Requires auth.

${P2P_AUTH_SIGNING_GUIDE}

**protocolCommand:** \`stopCompute\`.

**Returns:** Updated \`ComputeJob\` (or array).`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        jobId: z
          .string()
          .describe('Job id returned from computeStart / freeComputeStart.'),
        agreementId: z
          .string()
          .optional()
          .describe('Optional agreement id if the node expects it.')
      }
    },
    async ({
      nodeId,
      multiaddress,
      timeout,
      authToken,
      completeSignature,
      jobId,
      agreementId
    }) => {
      try {
        const auth = resolveAuth(authToken, completeSignature)
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.computeStop(
          jobId,
          node,
          auth,
          timeoutMs(timeout),
          agreementId
        )
        return commandResultPayload('computeStop', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'computeStatus',
    {
      title: 'P2P compute status',
      description: `Queries job status (\`getComputeStatus\`). Requires auth (JWT or completeSignature so the library can supply \`consumerAddress\` / headers).

${P2P_AUTH_SIGNING_GUIDE}

**Returns:** \`ComputeJob\` or list of jobs for the consumer.`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        jobId: z.string().optional().describe('Filter to a single job when set.'),
        agreementId: z.string().optional()
      }
    },
    async ({
      nodeId,
      multiaddress,
      timeout,
      authToken,
      completeSignature,
      jobId,
      agreementId
    }) => {
      try {
        const auth = resolveAuth(authToken, completeSignature)
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.computeStatus(
          node,
          auth,
          timeoutMs(timeout),
          jobId,
          agreementId
        )
        return commandResultPayload('computeStatus', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'getComputeResult',
    {
      title: 'P2P get compute result (binary)',
      description: `Streams a compute result file and returns it as base64 (\`getComputeResult\`). Requires auth.

${P2P_AUTH_SIGNING_GUIDE}

**protocolCommand:** \`getComputeResult\`.

**Parameters:** \`index\` is the result index from the job’s \`results\` array; \`offset\` resumes a partial download (bytes).

**Returns:** \`{ dataBase64, byteLength }\`. Large outputs can be big JSON; consider \`offset\` for chunking in future tooling.`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        jobId: z.string(),
        index: z
          .number()
          .describe('Result index (0-based) matching ComputeResult.index when present.'),
        offset: z
          .number()
          .optional()
          .describe('Byte offset for resumable download. Default: 0.')
      }
    },
    async ({
      nodeId,
      multiaddress,
      timeout,
      authToken,
      completeSignature,
      jobId,
      index,
      offset
    }) => {
      try {
        const auth = resolveAuth(authToken, completeSignature)
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.getComputeResultBase64(
          node,
          auth,
          jobId,
          index,
          offset ?? 0,
          timeoutMs(timeout)
        )
        return commandResultPayload('getComputeResult', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'downloadNodeLogs',
    {
      title: 'P2P download node logs',
      description: `Fetches operator logs from the node (\`getLogs\`). Requires auth.

${P2P_AUTH_SIGNING_GUIDE}

**protocolCommand:** \`getLogs\`.

**Returns:** \`NodeLogEntry[]\` (timestamp, level, moduleName, message, optional meta).`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        startTime: z
          .string()
          .describe('ISO or node-accepted time string for range start.'),
        endTime: z.string().describe('ISO or node-accepted time string for range end.'),
        maxLogs: z.number().optional(),
        moduleName: z.string().optional(),
        level: z.string().optional(),
        page: z.number().optional()
      }
    },
    async (args) => {
      try {
        const auth = resolveAuth(args.authToken, args.completeSignature)
        const node = parseNodeTarget(args.nodeId, args.multiaddress)
        const result = await nodeClient.downloadNodeLogs(
          node,
          auth,
          timeoutMs(args.timeout),
          {
            startTime: args.startTime,
            endTime: args.endTime,
            maxLogs: args.maxLogs,
            moduleName: args.moduleName,
            level: args.level,
            page: args.page
          }
        )
        return commandResultPayload('downloadNodeLogs', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'createPersistentStorageBucket',
    {
      title: 'P2P create persistent storage bucket',
      description: `Creates a bucket (\`persistentStorageCreateBucket\`). Requires auth.

${P2P_PERSISTENT_STORAGE_PREREQUISITE}

${P2P_AUTH_SIGNING_GUIDE}

**Returns:** \`{ bucketId, owner, accessList }\` (shape per node / ocean.js).`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        accessLists: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe('Access list entries; forwarded as payload.accessLists.')
      }
    },
    async ({
      nodeId,
      multiaddress,
      timeout,
      authToken,
      completeSignature,
      accessLists
    }) => {
      try {
        const auth = resolveAuth(authToken, completeSignature)
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.createPersistentStorageBucket(
          node,
          auth,
          { accessLists: accessLists as never },
          timeoutMs(timeout)
        )
        return commandResultPayload('createPersistentStorageBucket', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'getPersistentStorageBuckets',
    {
      title: 'P2P list persistent storage buckets',
      description: `Lists buckets for an owner (\`persistentStorageGetBuckets\`). Requires auth.

${P2P_PERSISTENT_STORAGE_PREREQUISITE}

${P2P_AUTH_SIGNING_GUIDE}

**Returns:** \`PersistentStorageBucket[]\`.`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        owner: z.string().describe('Ethereum address of the bucket owner to query.')
      }
    },
    async ({ nodeId, multiaddress, timeout, authToken, completeSignature, owner }) => {
      try {
        const auth = resolveAuth(authToken, completeSignature)
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.getPersistentStorageBuckets(
          node,
          auth,
          owner,
          timeoutMs(timeout)
        )
        return commandResultPayload('getPersistentStorageBuckets', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'listPersistentStorageFiles',
    {
      title: 'P2P list persistent storage files',
      description: `Lists files in a bucket (\`persistentStorageListFiles\`). Requires auth.

${P2P_PERSISTENT_STORAGE_PREREQUISITE}

${P2P_AUTH_SIGNING_GUIDE}

**Returns:** \`PersistentStorageFileEntry[]\` (bucketId, name, size, lastModified).`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        bucketId: z.string()
      }
    },
    async ({ nodeId, multiaddress, timeout, authToken, completeSignature, bucketId }) => {
      try {
        const auth = resolveAuth(authToken, completeSignature)
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.listPersistentStorageFiles(
          node,
          auth,
          bucketId,
          timeoutMs(timeout)
        )
        return commandResultPayload('listPersistentStorageFiles', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'getPersistentStorageFileObject',
    {
      title: 'P2P get persistent storage file object',
      description: `Returns metadata / object descriptor for a file (\`persistentStorageGetFileObject\`). Requires auth.

${P2P_PERSISTENT_STORAGE_PREREQUISITE}

${P2P_AUTH_SIGNING_GUIDE}

**Returns:** \`PersistentStorageObject\` (node response).`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        bucketId: z.string(),
        fileName: z.string()
      }
    },
    async ({
      nodeId,
      multiaddress,
      timeout,
      authToken,
      completeSignature,
      bucketId,
      fileName
    }) => {
      try {
        const auth = resolveAuth(authToken, completeSignature)
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.getPersistentStorageFileObject(
          node,
          auth,
          bucketId,
          fileName,
          timeoutMs(timeout)
        )
        return commandResultPayload('getPersistentStorageFileObject', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'deletePersistentStorageFile',
    {
      title: 'P2P delete persistent storage file',
      description: `Deletes a file from a bucket (\`persistentStorageDeleteFile\`). Requires auth.

${P2P_PERSISTENT_STORAGE_PREREQUISITE}

${P2P_AUTH_SIGNING_GUIDE}

**Returns:** \`PersistentStorageDeleteFileResponse\` (\`{ success: boolean }\` or node extension).`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        bucketId: z.string(),
        fileName: z.string()
      }
    },
    async ({
      nodeId,
      multiaddress,
      timeout,
      authToken,
      completeSignature,
      bucketId,
      fileName
    }) => {
      try {
        const auth = resolveAuth(authToken, completeSignature)
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.deletePersistentStorageFile(
          node,
          auth,
          bucketId,
          fileName,
          timeoutMs(timeout)
        )
        return commandResultPayload('deletePersistentStorageFile', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'get_download_fees',
    {
      title: 'P2P get download fees (initialize)',
      description: `Runs \`initialize\` / \`${PROTOCOL_COMMANDS.GET_FEES}\` for a dataset service file. **No auth.** Returns provider pricing / validation (\`ProviderInitialize\`) before download.

**Returns:** Node-dependent fee / initialization object.`,
      inputSchema: {
        ...nodeTargetSchema,
        did: z.string().describe('Asset DID (ddoId).'),
        serviceId: z.string(),
        fileIndex: z.number().int().nonnegative(),
        consumerAddress: z.string(),
        userCustomParameters: z.record(z.string(), z.unknown()).optional(),
        computeEnv: z.string().optional(),
        validUntil: z.number().optional()
      }
    },
    async (args) => {
      try {
        const node = parseNodeTarget(args.nodeId, args.multiaddress)
        const result = await nodeClient.getDownloadFees(node, timeoutMs(args.timeout), {
          did: args.did,
          serviceId: args.serviceId,
          fileIndex: args.fileIndex,
          consumerAddress: args.consumerAddress,
          userCustomParameters: args.userCustomParameters,
          computeEnv: args.computeEnv,
          validUntil: args.validUntil
        })
        return commandResultPayload('get_download_fees', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'download_asset_file',
    {
      title: 'P2P download asset file',
      description: `Streams a file over P2P (\`${PROTOCOL_COMMANDS.DOWNLOAD}\` / \`getDownloadUrl\`). Requires auth. Returns **base64** of file bytes plus length (large assets → large JSON).

${P2P_AUTH_SIGNING_GUIDE}

**protocolCommand:** \`${PROTOCOL_COMMANDS.DOWNLOAD}\`.`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        did: z.string(),
        serviceId: z.string(),
        fileIndex: z.number().int().nonnegative(),
        transferTxId: z.string(),
        policyServer: z.record(z.string(), z.unknown()).optional(),
        userCustomParameters: z.record(z.string(), z.unknown()).optional()
      }
    },
    async (args) => {
      try {
        const auth = resolveAuth(args.authToken, args.completeSignature)
        const node = parseNodeTarget(args.nodeId, args.multiaddress)
        const result = await nodeClient.downloadAssetFileBase64(
          node,
          auth,
          timeoutMs(args.timeout),
          {
            did: args.did,
            serviceId: args.serviceId,
            fileIndex: args.fileIndex,
            transferTxId: args.transferTxId,
            policyServer: args.policyServer,
            userCustomParameters: args.userCustomParameters
          }
        )
        return commandResultPayload('download_asset_file', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'p2p_encrypt',
    {
      title: 'P2P encrypt blob',
      description: `Encrypts data via the node (\`${PROTOCOL_COMMANDS.ENCRYPT}\`). Requires auth.

${P2P_AUTH_SIGNING_GUIDE}

**protocolCommand:** \`${PROTOCOL_COMMANDS.ENCRYPT}\`.

**Returns:** Hex string (ocean.js \`bufToHex\` of ciphertext).`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        chainId: z.number().int(),
        blob: z
          .string()
          .describe('UTF-8 payload to encrypt (sent as blob; non-JSON strings OK).'),
        policyServer: z.record(z.string(), z.unknown()).optional()
      }
    },
    async (args) => {
      try {
        const auth = resolveAuth(args.authToken, args.completeSignature)
        const node = parseNodeTarget(args.nodeId, args.multiaddress)
        const result = await nodeClient.encryptBlob(
          node,
          auth,
          args.chainId,
          args.blob,
          timeoutMs(args.timeout),
          args.policyServer
        )
        return commandResultPayload('p2p_encrypt', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'check_did_files',
    {
      title: 'P2P list files for DID service',
      description: `Lists file entries for a DID + service (\`checkDidFiles\` / \`${PROTOCOL_COMMANDS.FILE_INFO}\`). **No auth.**

**Returns:** \`FileInfo[]\`.`,
      inputSchema: {
        ...nodeTargetSchema,
        did: z.string(),
        serviceId: z.string(),
        withChecksum: z.boolean().optional().describe('Request checksums when true.')
      }
    },
    async (args) => {
      try {
        const node = parseNodeTarget(args.nodeId, args.multiaddress)
        const result = await nodeClient.checkDidFiles(
          node,
          args.did,
          args.serviceId,
          args.withChecksum ?? false,
          timeoutMs(args.timeout)
        )
        return commandResultPayload('check_did_files', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'create_auth_token',
    {
      title: 'P2P create auth token',
      description: `Mints a JWT via \`${PROTOCOL_COMMANDS.CREATE_AUTH_TOKEN}\` (\`generateSignedAuthToken\`). **No existing authToken** — you sign with your wallet.

Use **completeSignature** only: **nonce = String((getNonce) + 1)** and **protocolCommand** \`${PROTOCOL_COMMANDS.CREATE_AUTH_TOKEN}\` per the auth guide.

**Returns:** JWT string to pass as **authToken** on later calls.`,
      inputSchema: {
        ...nodeTargetSchema,
        completeSignature: completeSignatureSchema.describe(
          'Wallet-signed CREATE_AUTH_TOKEN (consumerAddress, nonce, signature).'
        )
      }
    },
    async ({ nodeId, multiaddress, timeout, completeSignature }) => {
      try {
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.createAuthToken(
          node,
          completeSignature.consumerAddress,
          completeSignature.signature,
          completeSignature.nonce,
          timeoutMs(timeout)
        )
        return commandResultPayload('create_auth_token', { token: result })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'policy_server_passthrough',
    {
      title: 'P2P policy server passthrough',
      description: `Forwards a policy-server request over P2P (\`${PROTOCOL_COMMANDS.POLICY_SERVER_PASSTHROUGH}\`). Shape is node- and integration-specific.

**Returns:** Node response object.`,
      inputSchema: {
        ...nodeTargetSchema,
        request: z
          .record(z.string(), z.unknown())
          .describe('PolicyServerPassthroughCommand-compatible JSON.')
      }
    },
    async ({ nodeId, multiaddress, timeout, request }) => {
      try {
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.policyServerPassthrough(
          node,
          request,
          timeoutMs(timeout)
        )
        return commandResultPayload('policy_server_passthrough', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'policy_server_initialize_verification',
    {
      title: 'P2P policy server initialize verification',
      description: `Initializes policy-server verification (\`initializePSVerification\`, \`${PROTOCOL_COMMANDS.POLICY_SERVER_PASSTHROUGH}\`).

**Returns:** Node response object.`,
      inputSchema: {
        ...nodeTargetSchema,
        request: z.record(z.string(), z.unknown())
      }
    },
    async ({ nodeId, multiaddress, timeout, request }) => {
      try {
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.initializePolicyServerVerification(
          node,
          request,
          timeoutMs(timeout)
        )
        return commandResultPayload('policy_server_initialize_verification', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'get_compute_result_url',
    {
      title: 'P2P get compute result URL',
      description: `Non-streaming compute result request (\`getComputeResultUrl\` / \`${PROTOCOL_COMMANDS.COMPUTE_GET_RESULT}\` with consumer address). Returns URL or node payload — not raw file bytes (use **getComputeResult** for base64 stream).

${P2P_AUTH_SIGNING_GUIDE}`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        jobId: z.string(),
        index: z.number().int().nonnegative()
      }
    },
    async (args) => {
      try {
        const auth = resolveAuth(args.authToken, args.completeSignature)
        const node = parseNodeTarget(args.nodeId, args.multiaddress)
        const result = await nodeClient.getComputeResultUrl(
          node,
          auth,
          args.jobId,
          args.index,
          timeoutMs(args.timeout)
        )
        return commandResultPayload('get_compute_result_url', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'compute_streamable_logs',
    {
      title: 'P2P compute streamable logs',
      description: `Fetches streamable job logs (\`${PROTOCOL_COMMANDS.COMPUTE_GET_STREAMABLE_LOGS}\`) and returns **base64** of the collected bytes (same framing as compute result streaming).

${P2P_AUTH_SIGNING_GUIDE}

**protocolCommand:** \`${PROTOCOL_COMMANDS.COMPUTE_GET_STREAMABLE_LOGS}\`.`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        jobId: z.string()
      }
    },
    async (args) => {
      try {
        const auth = resolveAuth(args.authToken, args.completeSignature)
        const node = parseNodeTarget(args.nodeId, args.multiaddress)
        const result = await nodeClient.computeStreamableLogsBase64(
          node,
          auth,
          args.jobId,
          timeoutMs(args.timeout)
        )
        return commandResultPayload('compute_streamable_logs', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'upload_persistent_storage_file',
    {
      title: 'P2P upload persistent storage file',
      description: `Uploads file bytes to a bucket (\`${PROTOCOL_COMMANDS.PERSISTENT_STORAGE_UPLOAD_FILE}\`). Requires auth. Body is sent as one LP chunk from **contentBase64**.

${P2P_PERSISTENT_STORAGE_PREREQUISITE}

${P2P_AUTH_SIGNING_GUIDE}`,
      inputSchema: {
        ...nodeTargetSchema,
        ...p2pAuthFieldSchemas,
        bucketId: z.string(),
        fileName: z.string(),
        contentBase64: z
          .string()
          .describe('File bytes encoded as standard base64 (not data: URLs).')
      }
    },
    async (args) => {
      try {
        const auth = resolveAuth(args.authToken, args.completeSignature)
        const node = parseNodeTarget(args.nodeId, args.multiaddress)
        const result = await nodeClient.uploadPersistentStorageFile(
          node,
          auth,
          args.bucketId,
          args.fileName,
          args.contentBase64,
          timeoutMs(args.timeout)
        )
        return commandResultPayload('upload_persistent_storage_file', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'fetch_node_config',
    {
      title: 'P2P fetch node config',
      description: `Calls \`${PROTOCOL_COMMANDS.FETCH_CONFIG}\`. ${P2P_ADMIN_CONFIG_WARNING}

**Returns:** Node-dependent (often encrypted or signed config blob).`,
      inputSchema: {
        ...nodeTargetSchema,
        payload: z
          .record(z.string(), z.unknown())
          .describe('Pre-built signed request body per ocean-node.')
      }
    },
    async ({ nodeId, multiaddress, timeout, payload }) => {
      try {
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.fetchNodeConfig(node, payload, timeoutMs(timeout))
        return commandResultPayload('fetch_node_config', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'push_node_config',
    {
      title: 'P2P push node config',
      description: `Calls \`${PROTOCOL_COMMANDS.PUSH_CONFIG}\`. ${P2P_ADMIN_CONFIG_WARNING}`,
      inputSchema: {
        ...nodeTargetSchema,
        payload: z.record(z.string(), z.unknown())
      }
    },
    async ({ nodeId, multiaddress, timeout, payload }) => {
      try {
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.pushNodeConfig(node, payload, timeoutMs(timeout))
        return commandResultPayload('push_node_config', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'is_valid_provider',
    {
      title: 'P2P check node reachable',
      description:
        'Returns whether the peer responds to STATUS with a provider address (`isValidProvider`). **No auth.**',
      inputSchema: { ...nodeTargetSchema }
    },
    async ({ nodeId, multiaddress, timeout }) => {
      try {
        const node = parseNodeTarget(nodeId, multiaddress)
        const result = await nodeClient.isValidProvider(node, timeoutMs(timeout))
        return commandResultPayload('is_valid_provider', { valid: result })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'resolve_peer_multiaddr',
    {
      title: 'Resolve peer multiaddr from id',
      description:
        'Looks up a dialable multiaddr for a libp2p peer id (connections, peer store, then DHT). Uses the MCP server’s local P2P stack — **not** a remote ocean-node call.',
      inputSchema: {
        peerId: z.string().describe('Peer id string, with or without /p2p/ prefix.')
      }
    },
    async ({ peerId }) => {
      try {
        const result = await nodeClient.resolvePeerMultiaddr(peerId)
        return commandResultPayload('resolve_peer_multiaddr', { multiaddr: result })
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'list_discovered_peers',
    {
      title: 'List discovered libp2p peers',
      description:
        'Returns peers from the local peer store (`getDiscoveredNodes`). **No remote node target.** Requires P2P initialized on this MCP process.',
      inputSchema: {}
    },
    async () => {
      try {
        const result = await nodeClient.listDiscoveredPeers()
        return commandResultPayload('list_discovered_peers', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )

  server.registerTool(
    'cid_from_raw_string',
    {
      title: 'CID from raw string (DHT key)',
      description:
        'SHA-256 raw CID for a UTF-8 string (`cidFromRawString`) — same hashing as **find_provider** content keys. **No network call.**',
      inputSchema: {
        data: z
          .string()
          .describe('Exact UTF-8 string to hash (e.g. find_provider / advertise key).')
      }
    },
    async ({ data }) => {
      try {
        const result = await nodeClient.cidFromRawString(data)
        return commandResultPayload('cid_from_raw_string', result)
      } catch (error) {
        return { ...textContent(stringifyError(error)), isError: true }
      }
    }
  )
}
