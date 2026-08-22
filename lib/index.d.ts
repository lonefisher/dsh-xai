import z from "@deepseek-ai/schemastery";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { Api, AuthInteraction, Credential, CredentialInfo, CredentialStore, Model, MutableModels, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { WebError, WebSearchProvider, WebSearchRequest, WebSearchResult } from "@deepseek-ai/dsh-web";
import { Context } from "@deepseek-ai/cordis";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
//#region src/catalog.d.ts
declare const XAI_MODELS_URL = "https://api.x.ai/v1/models";
type CatalogSource = 'live' | 'cache' | 'fallback';
/** Pull model ids from an OpenAI-shaped or gateway-shaped listing body. */
declare function extractModelIds(body: unknown): string[];
/** Turn a live id into a pi-ai model, inheriting catalog metadata when possible. */
declare function materializeLiveModel(id: string, catalog?: readonly Model<Api>[]): Model<Api>;
/**
 * If `liveIds` is missing or empty, serve the installed catalog.
 * Otherwise serve only the live ids, each materialized against the catalog.
 */
declare function mergeLiveCatalog(catalog: readonly Model<Api>[], liveIds: readonly string[] | undefined): Model<Api>[];
declare function preferredXaiOAuthModelFrom(models: readonly {
  id: string;
}[]): string;
/** Fetch the account-visible model ids. Throws a secret-free error on failure. */
declare function fetchLiveModelIds(accessToken: string, signal?: AbortSignal): Promise<string[]>;
//#endregion
//#region src/store.d.ts
/** Resolve the default OAuth document path. */
declare function xaiOAuthAuthPath(dshHome?: string): string;
/** File-backed pi-ai store scoped to the single xAI provider. */
declare class XaiOAuthCredentialStore implements CredentialStore {
  readonly filename: string;
  constructor(filename?: string);
  private readCurrent;
  read(providerId: string): Promise<Credential | undefined>;
  list(): Promise<readonly CredentialInfo[]>;
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined>;
  delete(providerId: string): Promise<void>;
}
//#endregion
//#region src/session.d.ts
/** One process-local owner of the credential and the account model list. */
declare class XaiOAuthSession {
  readonly store: XaiOAuthCredentialStore;
  readonly models: MutableModels;
  private readonly baseline;
  private liveIds;
  private selectedIds;
  private source;
  private listingError;
  private readonly cacheFile;
  private onCatalogChange;
  constructor(store?: XaiOAuthCredentialStore, onCatalogChange?: () => void);
  /** Secret-free listing diagnostic from the last refresh. */
  get catalogError(): string | undefined;
  get catalogSource(): CatalogSource;
  availableModels(): Model<Api>[];
  selectedModelIds(): string[] | undefined;
  visibleModels(): Model<Api>[];
  /** Provider whose id matches the harness route so PiAiAdapter can list models. */
  provider(): Provider;
  loadCachedCatalog(): Promise<void>;
  refreshLiveCatalog(signal?: AbortSignal): Promise<void>;
  setSelectedModels(ids: readonly string[]): Promise<void>;
  logout(): Promise<void>;
  private writeCache;
}
//#endregion
//#region src/web-search.d.ts
declare const XAI_WEB_SEARCH_PROVIDER_ID = "xai-oauth";
declare const DEFAULT_XAI_WEB_SEARCH_MODEL = "grok-build-0.1";
declare const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";
interface XaiOAuthTokenSource {
  /** Cheap local availability check. Must not refresh or make network calls. */
  available(): boolean;
  /** Resolve a current OAuth bearer. Implementations may refresh an expired token under their existing lock. */
  resolve(signal?: AbortSignal): Promise<string | undefined>;
  /** Force-refresh after a server-side 401. Must stay OAuth-only and serialize refresh-token rotation. */
  refresh?(rejectedAccessToken: string, signal?: AbortSignal): Promise<string | undefined>;
}
interface XaiOAuthWebSearchProviderOptions {
  model?: string;
  fetch?: typeof fetch;
}
interface XaiResponsesBody extends Record<string, unknown> {}
/** Map an xAI Responses API envelope into DSH's native search result shape. */
declare function mapXaiWebSearchResponse(body: XaiResponsesBody): WebSearchResult;
declare class XaiOAuthWebSearchError extends WebError {}
/** DSH-native search provider using only a SuperGrok/X OAuth bearer. */
declare class XaiOAuthWebSearchProvider implements WebSearchProvider {
  private readonly tokens;
  readonly id = "xai-oauth";
  private readonly model;
  private readonly fetchImpl;
  constructor(tokens: XaiOAuthTokenSource, options?: XaiOAuthWebSearchProviderOptions);
  available(): boolean;
  private request;
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
}
//#endregion
//#region src/adapter.d.ts
/** Prefer grok-4.6 when the current (live or installed) list has it. */
declare function preferredXaiOAuthModel(models?: readonly {
  id: string;
}[]): string;
/**
 * Create the SuperGrok adapter without a dsh fork.
 * The public pi-ai adapter owns streaming, tools, reasoning, and compaction;
 * this plugin supplies a refreshable OAuth token and an account model list.
 */
declare function createXaiOAuthAdapter(session: XaiOAuthSession, resolveAttachments: () => AttachmentStore | undefined): PiAiAdapter;
//#endregion
//#region src/auth.d.ts
/** Non-secret login state shown by the launcher. */
interface XaiOAuthAuthStatus {
  authenticated: boolean;
  expiresAt?: Date;
}
/** Complete provider-native OAuth and persist the resulting credential. */
declare function loginXaiOAuth(interaction: AuthInteraction, store?: XaiOAuthCredentialStore): Promise<void>;
/** Copy ~/.grok/auth.json into the dsh store. Does not modify the Grok file. */
declare function importXaiOAuthFromGrok(store?: XaiOAuthCredentialStore, filename?: string): Promise<void>;
/** Remove the stored xAI OAuth credential. */
declare function logoutXaiOAuth(store?: XaiOAuthCredentialStore): Promise<void>;
/** Read non-secret login state without refreshing the token. */
declare function xaiOAuthAuthStatus(store?: XaiOAuthCredentialStore): Promise<XaiOAuthAuthStatus>;
/** Login then refresh the account model list when a session is available. */
declare function loginXaiOAuthSession(interaction: AuthInteraction, session: XaiOAuthSession): Promise<void>;
declare function importXaiOAuthSession(session: XaiOAuthSession, filename?: string): Promise<void>;
//#endregion
//#region src/auth-routes.d.ts
declare const XAI_OAUTH_AUTH_STATUS_PATH = "/plugins/dsh-xai/auth/status";
declare const XAI_OAUTH_AUTH_LOGIN_PATH = "/plugins/dsh-xai/auth/login";
declare const XAI_OAUTH_AUTH_IMPORT_PATH = "/plugins/dsh-xai/auth/import";
declare const XAI_OAUTH_AUTH_LOGOUT_PATH = "/plugins/dsh-xai/auth/logout";
declare const XAI_OAUTH_AUTH_MODELS_PATH = "/plugins/dsh-xai/auth/models";
type XaiOAuthWebAuthStatus = {
  status: 'signed-out';
  grokImportAvailable: boolean;
} | {
  status: 'signing-in';
  url?: string;
  userCode?: string;
  grokImportAvailable: boolean;
} | {
  status: 'signed-in';
  models: string[];
  available: string[];
  selected: string[];
  catalogSource: CatalogSource;
  catalogError?: string;
  grokImportAvailable: boolean;
} | {
  status: 'error';
  message: string;
  grokImportAvailable: boolean;
};
interface LoginChallenge {
  url: string;
  userCode?: string;
}
/** Register the plugin-owned OAuth routes when the Web server is composed. */
declare function registerXaiOAuthAuthRoutes(ctx: Context, session: XaiOAuthSession): void;
//#endregion
//#region src/grok-import.d.ts
interface GrokImportProbe {
  available: boolean;
  path: string;
}
/** Resolve the Grok CLI auth document. */
declare function grokAuthPath(home?: string): string;
/** Parse a Grok CLI / generic OAuth document into a pi-ai credential. */
declare function parseGrokAuthDocument(text: string, filename: string): OAuthCredential;
/** Whether ~/.grok/auth.json exists and looks importable. Never returns secrets. */
declare function probeGrokAuth(filename?: string): Promise<GrokImportProbe>;
/** Copy Grok CLI tokens into the dsh store. Does not write the Grok file. */
declare function importGrokAuth(store: XaiOAuthCredentialStore, filename?: string): Promise<OAuthCredential>;
//#endregion
//#region src/ids.d.ts
/** pi-ai provider id used by login, refresh, and the credential store. */
declare const XAI_PI_PROVIDER = "xai";
/** Harness LLM route. Distinct from the catalog `xai` API-key route. */
declare const XAI_OAUTH_ROUTE = "xai-oauth";
/** Basename of the OAuth document inside the Harness home. */
declare const XAI_OAUTH_AUTH_FILENAME = ".xai-oauth-auth.json";
/** Fallback model when the installed pi-ai catalog has no grok-4.6. */
declare const DEFAULT_XAI_OAUTH_MODEL = "grok-4.5";
/** Provider idle ceiling used by the composite route. */
declare const XAI_OAUTH_STREAM_IDLE_TIMEOUT_MS = 300000;
//#endregion
//#region src/redact.d.ts
/** Remove token-like strings from an external OAuth diagnostic. */
declare function safeMessage(error: unknown): string;
//#endregion
//#region src/index.d.ts
/** Stable Cordis plugin name. */
declare const name = "llm-xai-oauth";
/** LLM registry required before the subscription route can register. */
declare const inject: string[];
interface Config {
  /** Model used for server-side xAI Web Search. Defaults to the OAuth-friendly Grok Build model. */
  webSearchModel?: string;
}
declare const Config: z<Config>;
/** Build a token source that is OAuth-only by construction, including forced refresh after a 401. */
declare function createXaiOAuthWebSearchTokenSource(session: XaiOAuthSession): XaiOAuthTokenSource;
/** Register the xai-oauth LLM route and an OAuth-only Grok-backed WebSearchProvider. */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { type CatalogSource, Config, DEFAULT_XAI_OAUTH_MODEL, DEFAULT_XAI_WEB_SEARCH_MODEL, type GrokImportProbe, type LoginChallenge, XAI_MODELS_URL, XAI_OAUTH_AUTH_FILENAME, XAI_OAUTH_AUTH_IMPORT_PATH, XAI_OAUTH_AUTH_LOGIN_PATH, XAI_OAUTH_AUTH_LOGOUT_PATH, XAI_OAUTH_AUTH_MODELS_PATH, XAI_OAUTH_AUTH_STATUS_PATH, XAI_OAUTH_ROUTE, XAI_OAUTH_STREAM_IDLE_TIMEOUT_MS, XAI_PI_PROVIDER, XAI_RESPONSES_URL, XAI_WEB_SEARCH_PROVIDER_ID, type XaiOAuthAuthStatus, XaiOAuthCredentialStore, XaiOAuthSession, type XaiOAuthTokenSource, type XaiOAuthWebAuthStatus, XaiOAuthWebSearchError, XaiOAuthWebSearchProvider, type XaiOAuthWebSearchProviderOptions, apply, createXaiOAuthAdapter, createXaiOAuthWebSearchTokenSource, extractModelIds, fetchLiveModelIds, grokAuthPath, importGrokAuth, importXaiOAuthFromGrok, importXaiOAuthSession, inject, loginXaiOAuth, loginXaiOAuthSession, logoutXaiOAuth, mapXaiWebSearchResponse, materializeLiveModel, mergeLiveCatalog, name, parseGrokAuthDocument, preferredXaiOAuthModel, preferredXaiOAuthModelFrom, probeGrokAuth, registerXaiOAuthAuthRoutes, safeMessage, xaiOAuthAuthPath, xaiOAuthAuthStatus };