export function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export function textContent(text: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text
      }
    ]
  }
}

export function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : JSON.stringify(error)
}
