import fs from 'node:fs'
import path from 'node:path'
import { glob } from 'glob'

import { getDocSourcesWithResolvedPaths, type DocSection } from './config.js'

export interface DocEntry {
  uri: string
  title: string
  filePath: string
  content: string
  mimeType: string
  section: DocSection
  keywords: string[]
}

export type DocIndex = DocEntry[]

type ResolvedDocSource = ReturnType<typeof getDocSourcesWithResolvedPaths>[number]

const GLOBAL_EXCLUDES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.git/**',
  '**/*.lock',
  '**/*.map',
  '**/*.min.js',
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.ico',
  '**/*.svg',
  '**/*.woff',
  '**/*.woff2',
  '**/*.ttf',
  '**/*.eot',
  '**/*.bin',
  '**/*.zip',
  '**/*.tar',
  '**/*.gz',
  '**/*.docx',
  '**/*.pdf',
  '**/*.html',
  '**/c2d_storage/**',
  '**/databases/**',
  '**/benchmarks/**',
  '**/logs/**',
  '**/imgs/**',
  '**/real-estate-*/**',
  '**/*.postman_collection.json'
] as const

const INDEXED_EXTENSIONS = new Set([
  '.md',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.sol',
  '.json',
  '.yaml',
  '.yml',
  '.py',
  '.sh',
  '.env',
  '.example',
  '.dockerfile'
])

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'from',
  'are',
  'was',
  'will',
  'can',
  'you',
  'your',
  'not',
  'have',
  'has',
  'but',
  'they',
  'all',
  'been',
  'would',
  'their',
  'there',
  'when',
  'what',
  'which',
  'use',
  'used',
  'using',
  'more',
  'also',
  'how',
  'its',
  'each',
  'any'
])

function getMimeType(filePath: string): string {
  const base = path.basename(filePath).toLowerCase()
  const ext = path.extname(filePath).toLowerCase()
  if (base.startsWith('dockerfile')) return 'text/plain'

  switch (ext) {
    case '.md':
      return 'text/markdown'
    case '.ts':
    case '.tsx':
      return 'text/x-typescript'
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'text/javascript'
    case '.sol':
      return 'text/x-solidity'
    case '.json':
      return 'application/json'
    case '.yaml':
    case '.yml':
      return 'text/yaml'
    case '.py':
      return 'text/x-python'
    case '.sh':
      return 'text/x-sh'
    default:
      return 'text/plain'
  }
}

function shouldIndex(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase()
  const ext = path.extname(filePath).toLowerCase()

  if (base.startsWith('dockerfile')) return true
  if (ext === '.env' || base === '.env') return false
  if (base.endsWith('.example')) return true
  if (base.endsWith('.env.example')) return true
  if (base === 'package-lock.json' || base === 'yarn.lock' || base === 'pnpm-lock.yaml')
    return false

  return INDEXED_EXTENSIONS.has(ext)
}

function extractTitle(content: string, filePath: string): string {
  const h1Match = content.match(/^#\s+(.+)$/m)
  if (h1Match) return h1Match[1].trim()
  return path.basename(filePath)
}

function extractKeywords(content: string): string[] {
  return content
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .filter((word) => !STOPWORDS.has(word))
}

function deriveUri(uriPrefix: string, rootPath: string, filePath: string): string {
  const relativePath = path.relative(rootPath, filePath)
  const cleanedPath = relativePath.replace(/^\d+-/, '').replace(/\/\d+-/g, '/')
  return uriPrefix + cleanedPath
}

async function loadSource(source: ResolvedDocSource): Promise<DocEntry[]> {
  const { section, uriPrefix, rootPath, extraExcludes = [] } = source

  if (!fs.existsSync(rootPath)) {
    console.warn(`[docs-loader] Source path not found, skipping: ${rootPath}`)
    return []
  }

  const files = await glob('**/*', {
    cwd: rootPath,
    absolute: true,
    nodir: true,
    ignore: [...GLOBAL_EXCLUDES, ...extraExcludes]
  })

  const entries: DocEntry[] = []

  for (const filePath of files) {
    if (!shouldIndex(filePath)) continue

    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf8')
    } catch {
      continue
    }

    if (content.trim().length === 0) continue

    if (content.length > 512_000) {
      console.warn(
        `[docs-loader] Skipping large file (${Math.round(content.length / 1024)}KB): ${filePath}`
      )
      continue
    }

    entries.push({
      uri: deriveUri(uriPrefix, rootPath, filePath),
      title: extractTitle(content, filePath),
      filePath,
      content,
      mimeType: getMimeType(filePath),
      section,
      keywords: extractKeywords(content)
    })
  }

  return entries
}

export async function loadDocs(): Promise<DocIndex> {
  const sources = getDocSourcesWithResolvedPaths()
  const startedAt = Date.now()
  const entries: DocEntry[] = []

  console.log('[docs-loader] Indexing documentation sources...')

  for (const source of sources) {
    const sourceEntries = await loadSource(source)
    entries.push(...sourceEntries)
    console.log(
      `[docs-loader] ${source.section}: ${sourceEntries.length} files indexed from ${source.rootPath}`
    )
  }

  console.log(
    `[docs-loader] Done. Total: ${entries.length} entries in ${Date.now() - startedAt}ms`
  )

  return entries
}
