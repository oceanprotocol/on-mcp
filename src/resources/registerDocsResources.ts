import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { DocIndex } from '../docs/loader.js'
import {
  DOCS_INDEX_URI,
  getDocsIndexContent,
  getDocsResourceContent
} from './resourceCatalog.js'

type Params = {
  server: McpServer
  docsIndex: DocIndex
}

/**
 * Register the documentation docs as **two** entries rather than one-resource-per-file:
 *  1. a compact catalog resource (`ocean://docs/index`) listing every doc as {uri,title,section};
 *  2. a single `ResourceTemplate` (`ocean://docs/{+path}`) so any doc can still be read on demand.
 *
 * Previously this registered one MCP resource per indexed file, inflating `resources/list` to
 * ~900–1,500 entries that every client paid for on connect. On-demand reads resolve against the
 * same `docsIndex` via `getDocsResourceContent` (and the `get_doc` / `get_resource` tools), so no
 * fetch capability is lost. `list: undefined` keeps the template itself a single manifest entry
 * instead of expanding back into one-per-file.
 */
export function registerDocsResources({ server, docsIndex }: Params): void {
  server.registerResource(
    'docs-index',
    DOCS_INDEX_URI,
    {
      title: 'Ocean documentation index',
      description: `Catalog of ${docsIndex.length} documentation files as {uri,title,section}. Read one with the ocean://docs/{path} template, get_doc, or get_resource.`,
      mimeType: 'application/json'
    },
    // eslint-disable-next-line require-await
    async () => ({ contents: [getDocsIndexContent(docsIndex)] })
  )

  server.registerResource(
    'docs-file',
    new ResourceTemplate('ocean://docs/{+path}', { list: undefined }),
    {
      title: 'Ocean documentation file',
      description:
        'Read any indexed documentation file by URI (ocean://docs/<path>). Discover paths via the docs index (ocean://docs/index) or list_topics.',
      mimeType: 'text/markdown'
    },
    // eslint-disable-next-line require-await
    async (uri) => {
      const content = getDocsResourceContent(docsIndex, uri.href)
      if (!content) {
        throw new Error(`Document not found: ${uri.href}`)
      }
      return {
        contents: [{ uri: uri.href, mimeType: content.mimeType, text: content.text }]
      }
    }
  )
}
