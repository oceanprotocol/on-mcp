import type { DocEntry, DocIndex } from './loader.js'

export interface SearchResult {
  uri: string
  title: string
  excerpt: string
  score: number
  mimeType: string
  section: string
}

export interface SearchOptions {
  query: string
  section?: string
  fileType?: 'md' | 'ts' | 'js' | 'json' | 'sol' | 'all'
  limit?: number
}

const MIME_TYPE_FILTERS: Record<string, string[]> = {
  md: ['text/markdown'],
  ts: ['text/x-typescript'],
  js: ['text/javascript'],
  json: ['application/json'],
  sol: ['text/x-solidity']
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2)
}

function extractExcerpt(content: string, queryTokens: string[]): string {
  const lines = content.split('\n')

  for (const line of lines) {
    const lowerLine = line.toLowerCase()
    if (queryTokens.some((token) => lowerLine.includes(token))) {
      const trimmedLine = line.trim()
      if (trimmedLine.length > 10) {
        return trimmedLine.slice(0, 300)
      }
    }
  }

  return content.trim().slice(0, 300)
}

function scoreEntry(entry: DocEntry, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0

  let score = 0
  const keywordSet = new Set(entry.keywords)
  const titleLower = entry.title.toLowerCase()
  const uriLower = entry.uri.toLowerCase()

  for (const token of queryTokens) {
    if (titleLower.includes(token)) score += 10
    if (uriLower.includes(token)) score += 5

    if (keywordSet.has(token)) {
      const frequency = entry.keywords.filter((keyword) => keyword === token).length
      score += Math.log1p(frequency) * 3
    }
  }

  if (entry.mimeType === 'text/markdown') {
    score *= 1.2
  }

  return score
}

export function search(index: DocIndex, options: SearchOptions): SearchResult[] {
  const { query, section, fileType = 'all', limit = 10 } = options
  const queryTokens = tokenize(query)

  let candidates = index

  if (section && section !== 'all') {
    candidates = candidates.filter((entry) => entry.section === section)
  }

  if (fileType !== 'all' && MIME_TYPE_FILTERS[fileType]) {
    candidates = candidates.filter((entry) =>
      MIME_TYPE_FILTERS[fileType].includes(entry.mimeType)
    )
  }

  return candidates
    .map((entry) => ({ entry, score: scoreEntry(entry, queryTokens) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ entry, score }) => ({
      uri: entry.uri,
      title: entry.title,
      excerpt: extractExcerpt(entry.content, queryTokens),
      score: Math.round(score * 10) / 10,
      mimeType: entry.mimeType,
      section: entry.section
    }))
}
