/**
 * Optional xAI SuperGrok / X Premium bundle with OAuth, Grok models,
 * browser account settings, and DSH-native Grok Web Search.
 * @module dsh-xai
 */

import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-web'
import { createXaiOAuthAdapter } from './adapter.ts'
import { registerXaiOAuthAuthRoutes } from './auth-routes.ts'
import { XAI_OAUTH_ROUTE, XAI_PI_PROVIDER } from './ids.ts'
import { XaiOAuthSession } from './session.ts'
import { XaiOAuthCredentialStore } from './store.ts'
import {
  DEFAULT_XAI_WEB_SEARCH_MODEL,
  XaiOAuthWebSearchProvider,
  type XaiOAuthTokenSource,
} from './web-search.ts'

export { createXaiOAuthAdapter, preferredXaiOAuthModel } from './adapter.ts'
export {
  importXaiOAuthFromGrok,
  importXaiOAuthSession,
  loginXaiOAuth,
  loginXaiOAuthSession,
  logoutXaiOAuth,
  xaiOAuthAuthStatus,
} from './auth.ts'
export type { XaiOAuthAuthStatus } from './auth.ts'
export {
  registerXaiOAuthAuthRoutes,
  XAI_OAUTH_AUTH_IMPORT_PATH,
  XAI_OAUTH_AUTH_LOGIN_PATH,
  XAI_OAUTH_AUTH_LOGOUT_PATH,
  XAI_OAUTH_AUTH_MODELS_PATH,
  XAI_OAUTH_AUTH_STATUS_PATH,
} from './auth-routes.ts'
export type { LoginChallenge, XaiOAuthWebAuthStatus } from './auth-routes.ts'
export {
  extractModelIds,
  fetchLiveModelIds,
  materializeLiveModel,
  mergeLiveCatalog,
  preferredXaiOAuthModelFrom,
  XAI_MODELS_URL,
} from './catalog.ts'
export type { CatalogSource } from './catalog.ts'
export { grokAuthPath, importGrokAuth, parseGrokAuthDocument, probeGrokAuth } from './grok-import.ts'
export type { GrokImportProbe } from './grok-import.ts'
export {
  DEFAULT_XAI_OAUTH_MODEL,
  XAI_OAUTH_AUTH_FILENAME,
  XAI_OAUTH_ROUTE,
  XAI_OAUTH_STREAM_IDLE_TIMEOUT_MS,
  XAI_PI_PROVIDER,
} from './ids.ts'
export { safeMessage } from './redact.ts'
export { XaiOAuthSession } from './session.ts'
export { XaiOAuthCredentialStore, xaiOAuthAuthPath } from './store.ts'
export {
  DEFAULT_XAI_WEB_SEARCH_MODEL,
  mapXaiWebSearchResponse,
  XAI_RESPONSES_URL,
  XAI_WEB_SEARCH_PROVIDER_ID,
  XaiOAuthWebSearchError,
  XaiOAuthWebSearchProvider,
} from './web-search.ts'
export type { XaiOAuthTokenSource, XaiOAuthWebSearchProviderOptions } from './web-search.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-xai-oauth'

/** LLM registry required before the subscription route can register. */
export const inject = ['llm']

export interface Config {
  /** Model used for server-side xAI Web Search. Defaults to the OAuth-friendly Grok Build model. */
  webSearchModel?: string
}

export const Config: z<Config> = z.object({
  webSearchModel: z.string(),
})

/** Build a token source that is OAuth-only by construction, including forced refresh after a 401. */
export function createXaiOAuthWebSearchTokenSource(session: XaiOAuthSession): XaiOAuthTokenSource {
  return {
    available: () => existsSync(session.store.filename),
    async resolve(signal?: AbortSignal): Promise<string | undefined> {
      const credential = await session.store.read(XAI_PI_PROVIDER)
      if (credential?.type !== 'oauth') return undefined
      const auth = await session.models.getAuth(
        XAI_PI_PROVIDER,
        signal === undefined ? undefined : { signal },
      )
      if (auth?.source !== 'OAuth') return undefined
      const accessToken = auth.auth.apiKey
      return accessToken === undefined || accessToken.length === 0 ? undefined : accessToken
    },
    async refresh(rejectedAccessToken: string, signal?: AbortSignal): Promise<string | undefined> {
      const oauth = session.models.getProvider(XAI_PI_PROVIDER)?.auth.oauth
      if (oauth === undefined) return undefined
      const refreshSignal = signal ?? new AbortController().signal
      const credential = await session.store.modify(XAI_PI_PROVIDER, async current => {
        if (current?.type !== 'oauth') return undefined
        // Another process may already have refreshed while this request was in flight.
        // Returning undefined leaves that newer credential untouched; modify() returns it.
        if (current.access !== rejectedAccessToken) return undefined
        return oauth.refresh(current, refreshSignal)
      })
      if (credential?.type !== 'oauth') return undefined
      return credential.access.length === 0 ? undefined : credential.access
    },
  }
}

/** Register the xai-oauth LLM route and an OAuth-only Grok-backed WebSearchProvider. */
export function apply(ctx: Context, config: Config): void {
  const session = new XaiOAuthSession(new XaiOAuthCredentialStore(), () => {
    ctx.emit('llm/adapters-updated')
  })
  void session.loadCachedCatalog().then(() => session.refreshLiveCatalog())
  ctx.llm.registerAdapter(
    [XAI_OAUTH_ROUTE],
    createXaiOAuthAdapter(session, () => ctx.get('attachments')),
  )
  ctx.inject(['webServer'], webCtx => registerXaiOAuthAuthRoutes(webCtx, session))
  ctx.inject(['web'], webCtx => {
    webCtx.web.registerSearchProvider(new XaiOAuthWebSearchProvider(
      createXaiOAuthWebSearchTokenSource(session),
      { model: config.webSearchModel ?? DEFAULT_XAI_WEB_SEARCH_MODEL },
    ))
  })
}
