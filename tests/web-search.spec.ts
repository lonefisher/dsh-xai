import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_XAI_WEB_SEARCH_MODEL,
  XAI_RESPONSES_URL,
  XaiOAuthWebSearchProvider,
  mapXaiWebSearchResponse,
  type XaiOAuthTokenSource,
} from '../src/web-search.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('mapXaiWebSearchResponse', () => {
  it('maps answer text, structured sources, annotations, and citations without inventing titles', () => {
    const result = mapXaiWebSearchResponse({
      output: [
        {
          type: 'web_search_call',
          action: {
            sources: [
              { type: 'url', url: 'https://a.example/news' },
              { type: 'url', url: 'https://b.example/', description: 'B description' },
            ],
          },
        },
        {
          type: 'message',
          content: [{
            type: 'output_text',
            text: 'Current summary.',
            annotations: [
              { type: 'url_citation', url: 'https://a.example/news', title: '1' },
              { type: 'url_citation', url: 'https://c.example/x', title: '2' },
            ],
          }],
        },
      ],
      citations: [
        'https://a.example/news',
        { url: 'https://b.example/', title: 'B title', published_at: '2026-08-22' },
        'javascript:alert(1)',
        'https://d.example/',
      ],
    })

    expect(result).toEqual({
      content: 'Current summary.',
      sources: [
        { url: 'https://a.example/news' },
        {
          url: 'https://b.example/',
          title: 'B title',
          snippet: 'B description',
          publishedAt: '2026-08-22',
        },
        { url: 'https://c.example/x' },
        { url: 'https://d.example/' },
      ],
      truncated: false,
    })
  })

  it('falls back to top-level citations and rejects non-http(s) URLs', () => {
    expect(mapXaiWebSearchResponse({
      citations: ['https://ok.example/x', 'ftp://bad.example/x', 'not a url'],
    }).sources).toEqual([{ url: 'https://ok.example/x' }])
  })
})

describe('XaiOAuthWebSearchProvider', () => {
  const tokens = (accessToken: string | undefined, refresh?: XaiOAuthTokenSource['refresh']): XaiOAuthTokenSource => ({
    available: () => true,
    resolve: vi.fn(async () => accessToken),
    ...refresh === undefined ? {} : { refresh },
  })

  it('uses the fixed xAI Responses endpoint and server-side web_search', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
      citations: ['https://a.example/'],
    }))
    const provider = new XaiOAuthWebSearchProvider(tokens('oauth-secret'), { fetch: fetchMock as typeof fetch })

    await expect(provider.search({ query: 'DeepSeek Harness latest', maxResults: 3 })).resolves.toEqual({
      content: 'ok',
      sources: [{ url: 'https://a.example/' }],
      truncated: false,
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(XAI_RESPONSES_URL)
    expect(init.redirect).toBe('error')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer oauth-secret')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.model).toBe(DEFAULT_XAI_WEB_SEARCH_MODEL)
    expect(body.tools).toEqual([{ type: 'web_search' }])
    expect(body.include).toEqual(['web_search_call.action.sources', 'no_inline_citations'])
    expect(body.store).toBe(false)
  })

  it('never falls back to an API key when OAuth is absent', async () => {
    const fetchMock = vi.fn()
    const provider = new XaiOAuthWebSearchProvider(tokens(undefined), { fetch: fetchMock as typeof fetch })
    await expect(provider.search({ query: 'x' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: expect.stringContaining('API-key fallback is intentionally disabled'),
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('force-refreshes OAuth once after HTTP 401 and retries with the rotated bearer', async () => {
    const refresh = vi.fn(async (rejectedAccessToken: string) => {
      expect(rejectedAccessToken).toBe('old-token')
      return 'new-token'
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'expired' } }, 401))
      .mockResolvedValueOnce(jsonResponse({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'fresh' }] }],
        citations: ['https://fresh.example/'],
      }))
    const provider = new XaiOAuthWebSearchProvider(tokens('old-token', refresh), { fetch: fetchMock as typeof fetch })

    await expect(provider.search({ query: 'x' })).resolves.toMatchObject({ content: 'fresh' })
    expect(refresh).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe('Bearer old-token')
    expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>).authorization).toBe('Bearer new-token')
  })

  it('never loops refresh when the retry also returns HTTP 401', async () => {
    const refresh = vi.fn(async () => 'new-token')
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: 'still invalid' } }, 401)) as typeof fetch
    const provider = new XaiOAuthWebSearchProvider(tokens('old-token', refresh), { fetch: fetchMock })

    await expect(provider.search({ query: 'x' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: expect.stringContaining('still invalid'),
    })
    expect(refresh).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry when a forced refresh cannot rotate the rejected bearer', async () => {
    const refresh = vi.fn(async () => 'old-token')
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: 'invalid bearer' } }, 401)) as typeof fetch
    const provider = new XaiOAuthWebSearchProvider(tokens('old-token', refresh), { fetch: fetchMock })

    await expect(provider.search({ query: 'x' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: expect.stringContaining('HTTP 401'),
    })
    expect(refresh).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('surfaces xAI HTTP and in-band errors', async () => {
    const http = new XaiOAuthWebSearchProvider(tokens('oauth-secret'), {
      fetch: vi.fn(async () => jsonResponse({ error: { message: 'invalid bearer' } }, 401)) as typeof fetch,
    })
    await expect(http.search({ query: 'x' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: expect.stringContaining('HTTP 401'),
    })

    const inBand = new XaiOAuthWebSearchProvider(tokens('oauth-secret'), {
      fetch: vi.fn(async () => jsonResponse({ error: { message: 'subscription limit' } })) as typeof fetch,
    })
    await expect(inBand.search({ query: 'x' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: expect.stringContaining('subscription limit'),
    })
  })

  it('maps AbortError to WEB_ABORTED', async () => {
    const provider = new XaiOAuthWebSearchProvider(tokens('oauth-secret'), {
      fetch: vi.fn(async () => { throw new DOMException('aborted', 'AbortError') }) as typeof fetch,
    })
    await expect(provider.search({ query: 'x' })).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })
})
