import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { DocIndex } from '../docs/loader.js'
import { listDocsResources } from './resourceCatalog.js'

type Params = {
  server: McpServer
  docsIndex: DocIndex
}

export function registerDocsResources({ server, docsIndex }: Params): void {
  for (const resource of listDocsResources(docsIndex)) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType
      },
      () => ({
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType,
            text: docsIndex.find((entry) => entry.uri === resource.uri)?.content ?? ''
          }
        ]
      })
    )
  }
}
