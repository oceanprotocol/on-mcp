import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ServerContext } from '../server/serverContext.js'
import { registerDocsResources } from './registerDocsResources.js'
import { getBuiltinResourceContent, listBuiltinResources } from './resourceCatalog.js'

type RegisterResourcesParams = {
  server: McpServer
} & ServerContext

export function registerResources({
  server,
  evmRegistry,
  docsIndex
}: RegisterResourcesParams): void {
  for (const resource of listBuiltinResources()) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType
      },
      async () => ({
        contents: [await getBuiltinResourceContentOrThrow(evmRegistry, resource.uri)]
      })
    )
  }

  registerDocsResources({ server, docsIndex })
}

async function getBuiltinResourceContentOrThrow(
  evmRegistry: RegisterResourcesParams['evmRegistry'],
  uri: string
) {
  const content = await getBuiltinResourceContent(evmRegistry, uri)
  if (!content) {
    throw new Error(`Unsupported built-in resource URI: ${uri}`)
  }

  return content
}
