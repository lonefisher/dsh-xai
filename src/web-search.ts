import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'

export const XAI_WEB_SEARCH_PROVIDER_ID = 'xai-oauth'
export const DEFAULT_XAI_WEB_SEARCH_MODEL = 'grok-build-0.1'
export const XAI_RESPONSES_URL = 'https://api.x.ai/v1/responses'

const USER_AGENT = 'dsh-xai/0.1.0'
const ERROR_BODY_LIMIT = 300

export interface XaiOAuthTokenSource {
  /** Cheap local availability check. Must not refresh or make network calls. */
  available(): boolean
  /** Resolve a current OAuth bearer. Implementations may refresh an expired token under their existing lock. */
  resolve(signal?: AbortSignal): Promise<string | undefined>
  /** Force-refresh after a server-side 401. Must stay OAuth-only and serialize refresh-token rotation. */
  refresh?(rejectedAccessToken: string, signal?: AbortSignal): Promise<string | undefined>
}

export interface XaiOAuthWebSearchProviderOptions {
  model?: string
  fetch?: typeof fetch
}

interface XaiResponsesBody extends Record<string, unknown> {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function validWebUrl(value: unknown): string | undefined {
  const candidate = nonBlankString(value)
  if (candidate === undefined) return undefined
  try {
    const parsed = new URL(candidate)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? candidate : undefined
  } catch {
    return undefined
  }
}

function sourceFromRecord(value: unknown): WebSearchSource | undefined {
  if (!isRecord(value)) return undefined
  const url = validWebUrl(value['url'])
  if (url === undefined) return undefined
  const title = nonBlankString(value['title'])
  const snippet = nonBlankString(value['snippet']) ?? nonBlankString(value['description'])
  const publishedAt = nonBlankString(value['publishedAt']) ?? nonBlankString(value['published_at'])
  return {
    url,
    ...title !== undefined ? { title } : {},
    ...snippet !== undefined ? { snippet } : {},
    ...publishedAt !== undefined ? { publishedAt } : {},
  }
}

function mergeSources(groups: readonly (readonly WebSearchSource[])[]): WebSearchSource[] {
  const byUrl = new Map<string, WebSearchSource>()
  for (const group of groups) {
    for (const source of group) {
      const previous = byUrl.get(source.url)
      if (previous === undefined) {
        byUrl.set(source.url, source)
        continue
      }
      byUrl.set(source.url, {
        url: source.url,
        ...(previous.title ?? source.title) !== undefined ? { title: previous.title ?? source.title } : {},
        ...(previous.snippet ?? source.snippet) !== undefined ? { snippet: previous.snippet ?? source.snippet } : {},
        ...(previous.publishedAt ?? source.publishedAt) !== undefined
          ? { publishedAt: previous.publishedAt ?? source.publishedAt }
          : {},
      })
    }
  }
  return [...byUrl.values()]
}

function outputItems(body: XaiResponsesBody): readonly unknown[] {
  return Array.isArray(body['output']) ? body['output'] : []
}

function collectOutputText(body: XaiResponsesBody): string[] {
  const texts: string[] = []
  for (const item of outputItems(body)) {
    if (!isRecord(item) || item['type'] !== 'message' || !Array.isArray(item['content'])) continue
    for (const chunk of item['content']) {
      if (!isRecord(chunk) || chunk['type'] !== 'output_text') continue
      const text = nonBlankString(chunk['text'])
      if (text !== undefined) texts.push(text)
    }
  }
  return texts
}

function collectActionSources(body: XaiResponsesBody): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  for (const item of outputItems(body)) {
    if (!isRecord(item) || item['type'] !== 'web_search_call' || !isRecord(item['action'])) continue
    const rows = item['action']['sources']
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      const source = sourceFromRecord(row)
      if (source !== undefined) sources.push(source)
    }
  }
  return sources
}

function collectAnnotationSources(body: XaiResponsesBody): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  for (const item of outputItems(body)) {
    if (!isRecord(item) || item['type'] !== 'message' || !Array.isArray(item['content'])) continue
    for (const chunk of item['content']) {
      if (!isRecord(chunk) || chunk['type'] !== 'output_text' || !Array.isArray(chunk['annotations'])) continue
      for (const annotation of chunk['annotations']) {
        if (!isRecord(annotation) || annotation['type'] !== 'url_citation') continue
        const url = validWebUrl(annotation['url'])
        if (url !== undefined) sources.push({ url })
      }
    }
  }
  return sources
}

function collectCitationSources(body: XaiResponsesBody): WebSearchSource[] {
  if (!Array.isArray(body['citations'])) return []
  const sources: WebSearchSource[] = []
  for (const citation of body['citations']) {
    if (typeof citation === 'string') {
      const url = validWebUrl(citation)
      if (url !== undefined) sources.push({ url })
      continue
    }
    const source = sourceFromRecord(citation)
    if (source !== undefined) sources.push(source)
  }
  return sources
}

/** Map an xAI Responses API envelope into DSH's native search result shape. */
export function mapXaiWebSearchResponse(body: XaiResponsesBody): WebSearchResult {
  const content = collectOutputText(body).join('\n\n').trim()
  const sources = mergeSources([
    collectActionSources(body),
    collectAnnotationSources(body),
    collectCitationSources(body),
  ])
  return {
    ...content.length > 0 ? { content } : {},
    sources,
    truncated: false,
  }
}

function xaiApiErrorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  const error = body['error']
  if (typeof error === 'string') return nonBlankString(error)
  if (!isRecord(error)) return undefined
  return nonBlankString(error['message']) ?? nonBlankString(error['code'])
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  return isRecord(error) && error['name'] === 'AbortError'
}

async function parseErrorResponse(response: Response, signal?: AbortSignal): Promise<string> {
  const fallback = `xAI Web Search failed (HTTP ${response.status})`
  try {
    const text = await response.text()
    if (signal?.aborted) throw new XaiOAuthWebSearchError('xAI Web Search aborted', 'WEB_ABORTED')
    if (text.length === 0) return fallback
    try {
      const parsed = JSON.parse(text) as unknown
      const detail = xaiApiErrorMessage(parsed)
      if (detail !== undefined) return `${fallback}: ${detail.slice(0, ERROR_BODY_LIMIT)}`
    } catch {
      // Fall through to a bounded plain-text detail.
    }
    return `${fallback}: ${text.trim().slice(0, ERROR_BODY_LIMIT)}`
  } catch (error) {
    if (error instanceof XaiOAuthWebSearchError) throw error
    if (signal?.aborted || isAbortError(error)) {
      throw new XaiOAuthWebSearchError('xAI Web Search aborted', 'WEB_ABORTED', { cause: error })
    }
    return fallback
  }
}

function buildSearchPrompt(query: string): string {
  return [
    'Use the web_search tool to research the search topic below.',
    'Return a concise factual summary grounded in the web sources you found.',
    `Search topic: ${JSON.stringify(query)}`,
  ].join('\n')
}

export class XaiOAuthWebSearchError extends WebError {}

/** DSH-native search provider using only a SuperGrok/X OAuth bearer. */
export class XaiOAuthWebSearchProvider implements WebSearchProvider {
  readonly id = XAI_WEB_SEARCH_PROVIDER_ID
  private readonly model: string
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly tokens: XaiOAuthTokenSource,
    options: XaiOAuthWebSearchProviderOptions = {},
  ) {
    this.model = options.model?.trim() || DEFAULT_XAI_WEB_SEARCH_MODEL
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  available(): boolean {
    return this.model.length > 0 && this.tokens.available()
  }

  private async request(
    accessToken: string,
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(XAI_RESPONSES_URL, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          model: this.model,
          input: [{ role: 'user', content: buildSearchPrompt(request.query) }],
          tools: [{ type: 'web_search' }],
          include: ['web_search_call.action.sources', 'no_inline_citations'],
          store: false,
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw new XaiOAuthWebSearchError('xAI Web Search aborted', 'WEB_ABORTED', { cause: error })
      }
      throw new XaiOAuthWebSearchError('Could not reach xAI Web Search', 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    let accessToken: string | undefined
    try {
      accessToken = await this.tokens.resolve(signal)
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw new XaiOAuthWebSearchError('xAI Web Search aborted', 'WEB_ABORTED', { cause: error })
      }
      throw new XaiOAuthWebSearchError('Could not resolve the SuperGrok OAuth credential', 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (accessToken === undefined || accessToken.length === 0) {
      throw new XaiOAuthWebSearchError(
        'xAI Web Search requires a SuperGrok/X OAuth sign-in; API-key fallback is intentionally disabled',
        'WEB_PROVIDER_ERROR',
      )
    }

    let response = await this.request(accessToken, request, signal)

    // OAuth access tokens can be revoked or become invalid before their local expiry metadata says so.
    // Retry exactly once after a serialized forced refresh. There is deliberately no API-key path.
    if (response.status === 401 && this.tokens.refresh !== undefined) {
      let refreshed: string | undefined
      try {
        refreshed = await this.tokens.refresh(accessToken, signal)
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          throw new XaiOAuthWebSearchError('xAI Web Search aborted', 'WEB_ABORTED', { cause: error })
        }
        throw new XaiOAuthWebSearchError('Could not refresh the SuperGrok OAuth credential after HTTP 401', 'WEB_PROVIDER_ERROR', { cause: error })
      }
      if (refreshed !== undefined && refreshed.length > 0 && refreshed !== accessToken) {
        accessToken = refreshed
        response = await this.request(accessToken, request, signal)
      }
    }

    if (!response.ok) {
      throw new XaiOAuthWebSearchError(await parseErrorResponse(response, signal), 'WEB_PROVIDER_ERROR')
    }

    let body: unknown
    try {
      body = await response.json()
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw new XaiOAuthWebSearchError('xAI Web Search aborted', 'WEB_ABORTED', { cause: error })
      }
      throw new XaiOAuthWebSearchError('xAI Web Search returned invalid JSON', 'WEB_PROVIDER_ERROR', { cause: error })
    }
    const apiError = xaiApiErrorMessage(body)
    if (apiError !== undefined) {
      throw new XaiOAuthWebSearchError(`xAI Web Search returned an error: ${apiError}`, 'WEB_PROVIDER_ERROR')
    }
    if (!isRecord(body)) {
      throw new XaiOAuthWebSearchError('xAI Web Search returned an invalid response envelope', 'WEB_PROVIDER_ERROR')
    }
    return mapXaiWebSearchResponse(body)
  }
}
