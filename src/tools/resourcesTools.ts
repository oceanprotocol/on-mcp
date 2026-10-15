import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'

import type { DocIndex } from '../docs/loader.js'
import type { EvmProviderRegistry } from '../evm/evmProviderRegistry.js'
import { sliceUtf8, textContent } from '../utils/format.js'
import { commandResultPayload } from './evmToolUtils.js'
import { getResourceContent, listAllResources } from '../resources/resourceCatalog.js'

type Params = {
  server: McpServer
  evmRegistry: EvmProviderRegistry
  docsIndex: DocIndex
}

/** Default byte cap for get_resource so a large doc can't flood the model's context in one read. */
const DEFAULT_RESOURCE_MAX_BYTES = 40 * 1024

export function registerResourceTools({ server, evmRegistry, docsIndex }: Params): void {
  server.registerTool(
    'list_resources',
    {
      title: 'List MCP resources (on-mcp)',
      description:
        'Lists the MCP resources exposed by on-mcp (useful for clients that only surface tools). ' +
        'Returns the built-in resources plus a single docs-catalog summary — not every doc file. ' +
        'Read a specific doc with get_doc/get_resource or browse with list_topics.'
    },
    // eslint-disable-next-line require-await
    () => {
      return commandResultPayload('list_resources', {
        resources: listAllResources({ evmRegistry, docsIndex })
      })
    }
  )

  server.registerTool(
    'get_resource',
    {
      title: 'Get MCP resource content (on-mcp)',
      description:
        'Returns the content for a given resource URI. This mirrors MCP resources for clients ' +
        `that only surface tools. Large text/* content is capped at ~${Math.round(
          DEFAULT_RESOURCE_MAX_BYTES / 1024
        )} KiB (reports truncated:true with a nextOffset; pass offset/maxBytes to page); ` +
        'structured content such as the application/json docs catalog is returned whole.',
      inputSchema: {
        uri: z.string().describe('Resource URI to fetch.'),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'Byte offset to start from (for paging a large resource). Default 0.'
          ),
        maxBytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Max UTF-8 bytes to return (default ${DEFAULT_RESOURCE_MAX_BYTES}). Collection stops there and reports truncated:true.`
          )
      }
    },
    async ({ uri, offset, maxBytes }) => {
      const resource = await getResourceContent({ evmRegistry, docsIndex }, uri)
      if (!resource) {
        return {
          ...textContent(`Unknown resource URI: ${uri}`),
          isError: true
        }
      }

      // Only byte-cap text payloads. Structured resources (e.g. the application/json docs catalog,
      // which runs to ~100 KB across ~900 docs) must come back whole — a mid-structure slice would
      // be unparseable JSON for exactly the tool-only clients this tool serves. They are bounded by
      // construction (compact {uri,title,section} rows) rather than by a byte window.
      const isCappable = resource.mimeType.startsWith('text/')
      const sliced = isCappable
        ? sliceUtf8(resource.text, offset ?? 0, maxBytes ?? DEFAULT_RESOURCE_MAX_BYTES)
        : sliceUtf8(resource.text, 0, undefined)
      return commandResultPayload('get_resource', {
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: sliced.text,
        byteLength: sliced.totalBytes,
        offset: sliced.offset,
        returnedBytes: sliced.returnedBytes,
        ...(sliced.truncated ? { truncated: true } : {}),
        ...(sliced.nextOffset !== undefined
          ? {
              nextOffset: sliced.nextOffset,
              truncationNote:
                'Capped at maxBytes — more content remains. Re-call with offset=nextOffset to continue.'
            }
          : {})
      })
    }
  )
}
