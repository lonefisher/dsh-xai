import { existsSync } from "node:fs";
import z from "@deepseek-ai/schemastery";
import { LlmError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { createModels } from "@earendil-works/pi-ai";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { WebError } from "@deepseek-ai/dsh-web";
//#region src/ids.ts
/** pi-ai provider id used by login, refresh, and the credential store. */
const XAI_PI_PROVIDER = "xai";
/** Harness LLM route. Distinct from the catalog `xai` API-key route. */
const XAI_OAUTH_ROUTE = "xai-oauth";
/** Basename of the OAuth document inside the Harness home. */
const XAI_OAUTH_AUTH_FILENAME = ".xai-oauth-auth.json";
/** Fallback model when the installed pi-ai catalog has no grok-4.6. */
const DEFAULT_XAI_OAUTH_MODEL = "grok-4.5";
/** Provider idle ceiling used by the composite route. */
const XAI_OAUTH_STREAM_IDLE_TIMEOUT_MS = 3e5;
//#endregion
//#region src/catalog.ts
const XAI_MODELS_URL = "https://api.x.ai/v1/models";
const BODY_LIMIT_BYTES = 4194304;
function isRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Pull model ids from an OpenAI-shaped or gateway-shaped listing body. */
function extractModelIds(body) {
	const rows = Array.isArray(body) ? body : isRecord$2(body) && Array.isArray(body["data"]) ? body["data"] : isRecord$2(body) && Array.isArray(body["models"]) ? body["models"] : [];
	const ids = [];
	for (const row of rows) if (typeof row === "string" && row.length > 0) ids.push(row);
	else if (isRecord$2(row) && typeof row["id"] === "string" && row["id"].length > 0) ids.push(row["id"]);
	return [...new Set(ids)];
}
function titleCaseId(id) {
	return id.split(/[-_]/g).map((part) => part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)).join(" ");
}
function catalogModels(baseline = xaiProvider().getModels()) {
	return baseline;
}
function templateFor(id, catalog) {
	const exact = catalog.find((model) => model.id === id);
	if (exact !== void 0) return exact;
	const lower = id.toLowerCase();
	const fallback = catalog.find((model) => model.id === "grok-4.5") ?? catalog[0];
	if (fallback === void 0) throw new Error("xai-oauth: installed xAI catalog is empty");
	if (lower.includes("build") || lower.includes("code-fast")) return catalog.find((model) => model.id === "grok-build-0.1") ?? fallback;
	if (/grok-4\.[56]/.test(lower) || lower.includes("4.20") || lower.includes("reasoning")) return catalog.find((model) => model.api === "openai-responses") ?? fallback;
	return fallback;
}
/** Turn a live id into a pi-ai model, inheriting catalog metadata when possible. */
function materializeLiveModel(id, catalog = catalogModels()) {
	const template = templateFor(id, catalog);
	if (template.id === id) return template;
	return {
		...template,
		id,
		name: titleCaseId(id)
	};
}
/**
* If `liveIds` is missing or empty, serve the installed catalog.
* Otherwise serve only the live ids, each materialized against the catalog.
*/
function mergeLiveCatalog(catalog, liveIds) {
	if (liveIds === void 0 || liveIds.length === 0) return [...catalog];
	return liveIds.map((id) => materializeLiveModel(id, catalog));
}
function preferredXaiOAuthModelFrom(models) {
	const ids = new Set(models.map((model) => model.id));
	if (ids.has("grok-4.6")) return "grok-4.6";
	if (ids.has("grok-4.5")) return DEFAULT_XAI_OAUTH_MODEL;
	return models[0]?.id ?? "grok-4.5";
}
/** Fetch the account-visible model ids. Throws a secret-free error on failure. */
async function fetchLiveModelIds(accessToken, signal) {
	let response;
	try {
		response = await fetch(XAI_MODELS_URL, {
			headers: {
				accept: "application/json",
				authorization: `Bearer ${accessToken}`
			},
			signal
		});
	} catch (error) {
		if (signal?.aborted) throw new Error("Live model listing was cancelled");
		throw new Error("xAI model listing is unreachable");
	}
	const raw = Buffer.from(await response.arrayBuffer());
	if (raw.byteLength > BODY_LIMIT_BYTES) throw new Error("xAI model listing exceeded the 4 MiB read ceiling");
	let body;
	try {
		body = JSON.parse(raw.toString("utf8"));
	} catch {
		throw new Error(`xAI model listing returned invalid JSON (HTTP ${response.status})`);
	}
	if (!response.ok) {
		const code = isRecord$2(body) && typeof body["error"] === "string" ? body["error"] : void 0;
		throw new Error(`xAI model listing failed (HTTP ${response.status})${code === void 0 ? "" : `: ${code}`}`);
	}
	const ids = extractModelIds(body);
	if (ids.length === 0) throw new Error("xAI model listing contained no model ids");
	return ids;
}
//#endregion
//#region src/adapter.ts
/** xAI subscription adapter assembled from public dsh-llm-pi-ai extension points. */
/** Prefer grok-4.6 when the current (live or installed) list has it. */
function preferredXaiOAuthModel(models = xaiProvider().getModels()) {
	return preferredXaiOAuthModelFrom(models);
}
/**
* Create the SuperGrok adapter without a dsh fork.
* The public pi-ai adapter owns streaming, tools, reasoning, and compaction;
* this plugin supplies a refreshable OAuth token and an account model list.
*/
function createXaiOAuthAdapter(session, resolveAttachments) {
	return new PiAiAdapter({
		profiles: () => /* @__PURE__ */ new Map([[XAI_OAUTH_ROUTE, {
			provider: XAI_OAUTH_ROUTE,
			displayName: "xAI Grok",
			streamIdleTimeoutMs: XAI_OAUTH_STREAM_IDLE_TIMEOUT_MS,
			retryPolicy: resolveRetryPolicy(void 0, "dsh-xai retryPolicy"),
			configuredMaxTokens: /* @__PURE__ */ new Map(),
			piProvider: session.provider()
		}]]),
		resolveApiKey: async () => {
			const apiKey = (await session.models.getAuth("xai"))?.auth.apiKey;
			if (apiKey === void 0 || apiKey.length === 0) throw new LlmError("xAI Grok is not signed in. Open Settings → xAI Grok and sign in with SuperGrok or X Premium.", "MISSING_CREDENTIAL");
			return apiKey;
		},
		resolveAttachments
	});
}
//#endregion
//#region src/grok-import.ts
/**
* One-shot import of Grok CLI credentials into the dsh-owned store.
* The source file is never written. Refresh tokens rotate, so later dsh
* refresh may invalidate ~/.grok/auth.json — that is documented, not a bug.
* @module dsh-xai/grok-import
*/
const DEFAULT_TOKEN_LIFETIME_MS = 36e5;
function isENOENT$2(error) {
	return error?.code === "ENOENT";
}
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmptyString(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function firstString(record, keys) {
	for (const key of keys) {
		const value = nonEmptyString(record[key]);
		if (value !== void 0) return value;
	}
}
function parseTime(value) {
	const parsed = Date.parse(value);
	if (Number.isFinite(parsed) && parsed > 0) return parsed;
	const trimmed = value.replace(/(\.\d{3})\d+/, "$1");
	const again = Date.parse(trimmed);
	return Number.isFinite(again) && again > 0 ? again : NaN;
}
function parseExpires(record) {
	const expiresAt = record["expires_at"];
	if (typeof expiresAt === "string" && expiresAt.length > 0) {
		const parsed = parseTime(expiresAt);
		if (Number.isFinite(parsed)) return parsed;
	}
	if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) return expiresAt < 0xe8d4a51000 ? expiresAt * 1e3 : expiresAt;
	const expires = record["expires"];
	if (typeof expires === "number" && Number.isFinite(expires) && expires > 0) return expires < 0xe8d4a51000 ? expires * 1e3 : expires;
	const expiresIn = record["expires_in"];
	if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) return Date.now() + expiresIn * 1e3;
	return Date.now() + DEFAULT_TOKEN_LIFETIME_MS;
}
function walk(value, key) {
	if (Array.isArray(value)) return value.flatMap((item, index) => walk(item, `${key}[${index}]`));
	if (!isRecord$1(value)) return [];
	const access = firstString(value, [
		"key",
		"access",
		"access_token"
	]);
	const refresh = firstString(value, ["refresh_token", "refresh"]);
	if (access !== void 0 && refresh !== void 0) {
		const issuer = firstString(value, ["oidc_issuer", "issuer"]);
		const preferred = key.includes("auth.x.ai") || issuer !== void 0 && issuer.includes("auth.x.ai");
		const accountId = firstString(value, [
			"user_id",
			"accountId",
			"principal_id"
		]);
		return [{
			credential: {
				type: "oauth",
				access,
				refresh,
				expires: parseExpires(value),
				...accountId === void 0 ? {} : { accountId }
			},
			preferred
		}];
	}
	return Object.entries(value).flatMap(([child, nested]) => walk(nested, child));
}
/** Resolve the Grok CLI auth document. */
function grokAuthPath(home = homedir()) {
	return resolve(join(home, ".grok", "auth.json"));
}
/** Parse a Grok CLI / generic OAuth document into a pi-ai credential. */
function parseGrokAuthDocument(text, filename) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`xai-oauth: ${filename} is not valid JSON`);
	}
	const candidates = walk(value, "");
	if (candidates.length === 0) throw new Error(`xai-oauth: ${filename} does not contain a Grok OAuth refresh token`);
	return (candidates.find((candidate) => candidate.preferred) ?? candidates[0]).credential;
}
/** Whether ~/.grok/auth.json exists and looks importable. Never returns secrets. */
async function probeGrokAuth(filename = grokAuthPath()) {
	try {
		await stat(filename);
		parseGrokAuthDocument(await readFile(filename, "utf8"), filename);
		return {
			available: true,
			path: filename
		};
	} catch (error) {
		if (isENOENT$2(error)) return {
			available: false,
			path: filename
		};
		return {
			available: false,
			path: filename
		};
	}
}
/** Copy Grok CLI tokens into the dsh store. Does not write the Grok file. */
async function importGrokAuth(store, filename = grokAuthPath()) {
	let text;
	try {
		text = await readFile(filename, "utf8");
	} catch (error) {
		if (isENOENT$2(error)) throw new Error(`xai-oauth: Grok CLI auth file not found at ${filename}`);
		throw error;
	}
	const credential = parseGrokAuthDocument(text, filename);
	const written = await store.modify("xai", async () => credential);
	if (written === void 0 || written.type !== "oauth") throw new Error("xai-oauth: failed to persist the imported Grok credential");
	return written;
}
//#endregion
//#region src/store.ts
/**
* Owner-only persistent OAuth credential storage for the xAI subscription route.
* @module dsh-xai/store
*/
/** Current on-disk format; readers reject every other version. */
const AUTH_FORMAT_VERSION = 1;
function isENOENT$1(error) {
	return error?.code === "ENOENT";
}
async function assertOwnerOnly(filename) {
	let mode;
	try {
		mode = (await stat(filename)).mode;
	} catch (error) {
		if (isENOENT$1(error)) return;
		throw error;
	}
	if (process.platform === "win32") return;
	if ((mode & 63) !== 0) throw new Error(`xai-oauth: ${filename} is readable beyond its owner (mode ${(mode & 511).toString(8)}); run "chmod 600 ${filename}" before starting again`);
}
function parseDocument(text, filename) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`xai-oauth: ${filename} is not valid JSON`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`xai-oauth: ${filename} must contain an object`);
	const document = value;
	if (document["version"] !== AUTH_FORMAT_VERSION) throw new Error(`xai-oauth: ${filename} has unsupported auth format version ${String(document["version"])}`);
	if (Object.keys(document).some((key) => key !== "version" && key !== "credential")) throw new Error(`xai-oauth: ${filename} contains an unknown top-level field`);
	const raw = document["credential"];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`xai-oauth: ${filename} credential must be an object`);
	const credential = raw;
	const allowed = /* @__PURE__ */ new Set([
		"type",
		"access",
		"refresh",
		"expires",
		"accountId"
	]);
	if (Object.keys(credential).some((key) => !allowed.has(key))) throw new Error(`xai-oauth: ${filename} credential contains an unknown field`);
	if (credential["type"] !== "oauth") throw new Error(`xai-oauth: ${filename} credential type must be oauth`);
	for (const key of ["access", "refresh"]) if (typeof credential[key] !== "string" || credential[key].length === 0) throw new Error(`xai-oauth: ${filename} credential ${key} must be a non-empty string`);
	if (credential["accountId"] !== void 0 && (typeof credential["accountId"] !== "string" || credential["accountId"].length === 0)) throw new Error(`xai-oauth: ${filename} credential accountId must be a non-empty string when present`);
	if (typeof credential["expires"] !== "number" || !Number.isFinite(credential["expires"]) || credential["expires"] <= 0) throw new Error(`xai-oauth: ${filename} credential expires must be a positive finite number`);
	return {
		version: AUTH_FORMAT_VERSION,
		credential
	};
}
function cloneCredential(credential) {
	return structuredClone(credential);
}
/** Resolve the default OAuth document path. */
function xaiOAuthAuthPath(dshHome) {
	return resolve(join(resolveDshHome(dshHome), XAI_OAUTH_AUTH_FILENAME));
}
/** File-backed pi-ai store scoped to the single xAI provider. */
var XaiOAuthCredentialStore = class {
	filename;
	constructor(filename = xaiOAuthAuthPath()) {
		this.filename = resolve(filename);
	}
	async readCurrent() {
		await assertOwnerOnly(this.filename);
		let text;
		try {
			text = await readFile(this.filename, "utf8");
		} catch (error) {
			if (isENOENT$1(error)) return void 0;
			throw error;
		}
		return cloneCredential(parseDocument(text, this.filename).credential);
	}
	async read(providerId) {
		return providerId === "xai" ? this.readCurrent() : void 0;
	}
	async list() {
		return await this.readCurrent() === void 0 ? [] : [{
			providerId: "xai",
			type: "oauth"
		}];
	}
	async modify(providerId, fn) {
		if (providerId !== "xai") throw new Error(`xai-oauth: credential store does not own provider "${providerId}"`);
		await mkdir(dirname(this.filename), {
			recursive: true,
			mode: 448
		});
		return withFileLock(this.filename, async () => {
			const current = await this.readCurrent();
			const candidate = await fn(current);
			if (candidate === void 0) return current;
			const document = parseDocument(JSON.stringify({
				version: AUTH_FORMAT_VERSION,
				credential: candidate
			}), this.filename);
			await writeFileAtomic(this.filename, `${JSON.stringify(document, null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
			return cloneCredential(document.credential);
		});
	}
	async delete(providerId) {
		if (providerId !== "xai") return;
		await mkdir(dirname(this.filename), {
			recursive: true,
			mode: 448
		});
		await withFileLock(this.filename, () => rm(this.filename, { force: true }));
	}
};
//#endregion
//#region src/auth.ts
/**
* xAI OAuth orchestration shared by the plugin and standalone launcher.
* @module dsh-xai/auth
*/
/** Complete provider-native OAuth and persist the resulting credential. */
async function loginXaiOAuth(interaction, store = new XaiOAuthCredentialStore()) {
	const models = createModels({ credentials: store });
	models.setProvider(xaiProvider());
	await models.login("xai", "oauth", interaction);
}
/** Copy ~/.grok/auth.json into the dsh store. Does not modify the Grok file. */
async function importXaiOAuthFromGrok(store = new XaiOAuthCredentialStore(), filename) {
	await importGrokAuth(store, filename);
}
/** Remove the stored xAI OAuth credential. */
async function logoutXaiOAuth(store = new XaiOAuthCredentialStore()) {
	await store.delete("xai");
}
/** Read non-secret login state without refreshing the token. */
async function xaiOAuthAuthStatus(store = new XaiOAuthCredentialStore()) {
	const credential = await store.read("xai");
	return credential?.type === "oauth" ? {
		authenticated: true,
		expiresAt: new Date(credential.expires)
	} : { authenticated: false };
}
/** Login then refresh the account model list when a session is available. */
async function loginXaiOAuthSession(interaction, session) {
	await loginXaiOAuth(interaction, session.store);
	await session.refreshLiveCatalog();
}
async function importXaiOAuthSession(session, filename) {
	await importXaiOAuthFromGrok(session.store, filename);
	await session.refreshLiveCatalog();
}
//#endregion
//#region src/redact.ts
/** Remove token-like strings from an external OAuth diagnostic. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 1e3);
}
//#endregion
//#region src/auth-routes.ts
const XAI_OAUTH_AUTH_STATUS_PATH = "/plugins/dsh-xai/auth/status";
const XAI_OAUTH_AUTH_LOGIN_PATH = "/plugins/dsh-xai/auth/login";
const XAI_OAUTH_AUTH_IMPORT_PATH = "/plugins/dsh-xai/auth/import";
const XAI_OAUTH_AUTH_LOGOUT_PATH = "/plugins/dsh-xai/auth/logout";
const XAI_OAUTH_AUTH_MODELS_PATH = "/plugins/dsh-xai/auth/models";
function waitForPromptAbort(prompt) {
	const signal = prompt.signal;
	if (signal === void 0) return new Promise(() => {});
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((_resolve, reject) => {
		signal.addEventListener("abort", () => {
			reject(signal.reason);
		}, { once: true });
	});
}
async function grokImportAvailable() {
	return (await probeGrokAuth()).available;
}
/** One lifecycle owner for the device-code poller, challenge, and public status. */
var XaiOAuthWebAuth = class {
	session;
	state = {
		status: "signed-out",
		grokImportAvailable: false
	};
	operation;
	cancellation;
	challenge;
	challengeWaiters = [];
	constructor(session) {
		this.session = session;
	}
	async status() {
		if (this.operation !== void 0) return this.state;
		if (this.state.status === "error") return {
			...this.state,
			grokImportAvailable: await grokImportAvailable()
		};
		return this.readStoredStatus();
	}
	async signIn() {
		if (this.operation === void 0) this.start();
		if (this.challenge !== void 0) return this.challenge;
		return new Promise((resolve, reject) => {
			this.challengeWaiters.push({
				resolve,
				reject
			});
		});
	}
	async importGrok() {
		this.cancellation?.abort(/* @__PURE__ */ new Error("xAI Grok sign-in cancelled"));
		await this.operation?.catch(() => void 0);
		await importXaiOAuthSession(this.session);
		this.challenge = void 0;
		this.state = await this.readStoredStatus();
	}
	async setModels(ids) {
		await this.session.setSelectedModels(ids);
		this.state = await this.readStoredStatus();
	}
	async signOut() {
		this.cancellation?.abort(/* @__PURE__ */ new Error("xAI Grok sign-in cancelled"));
		await this.operation?.catch(() => void 0);
		await this.session.logout();
		this.state = {
			status: "signed-out",
			grokImportAvailable: await grokImportAvailable()
		};
		this.challenge = void 0;
	}
	async dispose() {
		this.cancellation?.abort(/* @__PURE__ */ new Error("xAI Grok plugin disposed"));
		await this.operation?.catch(() => void 0);
	}
	start() {
		const cancellation = new AbortController();
		this.cancellation = cancellation;
		this.challenge = void 0;
		this.state = {
			status: "signing-in",
			grokImportAvailable: false
		};
		this.operation = loginXaiOAuthSession({
			signal: cancellation.signal,
			prompt: (prompt) => prompt.type === "select" ? Promise.resolve(prompt.options.some((option) => option.id === "oauth") ? "oauth" : prompt.options[0]?.id ?? "oauth") : waitForPromptAbort(prompt),
			notify: (event) => {
				this.onEvent(event);
			}
		}, this.session).then(async () => {
			this.state = await this.readStoredStatus();
		}, (error) => {
			this.rejectChallenge(error);
			this.state = {
				status: "error",
				message: safeMessage(error),
				grokImportAvailable: false
			};
		}).finally(() => {
			this.operation = void 0;
			this.cancellation = void 0;
		});
	}
	onEvent(event) {
		if (event.type === "device_code") {
			this.acceptChallenge({
				url: event.verificationUri,
				...event.userCode.length > 0 ? { userCode: event.userCode } : {}
			});
			return;
		}
		if (event.type === "auth_url") this.acceptChallenge({ url: event.url });
	}
	acceptChallenge(challenge) {
		try {
			if (new URL(challenge.url).protocol !== "https:") {
				const error = /* @__PURE__ */ new Error("xAI returned an unsafe authorization URL");
				this.cancellation?.abort(error);
				this.rejectChallenge(error);
				return;
			}
		} catch {
			const error = /* @__PURE__ */ new Error("xAI returned an invalid authorization URL");
			this.cancellation?.abort(error);
			this.rejectChallenge(error);
			return;
		}
		this.challenge = challenge;
		this.state = {
			status: "signing-in",
			url: challenge.url,
			grokImportAvailable: false,
			...challenge.userCode === void 0 ? {} : { userCode: challenge.userCode }
		};
		for (const waiter of this.challengeWaiters.splice(0)) waiter.resolve(challenge);
	}
	async readStoredStatus() {
		const [stored, grok] = await Promise.all([xaiOAuthAuthStatus(this.session.store), grokImportAvailable()]);
		if (!stored.authenticated) return {
			status: "signed-out",
			grokImportAvailable: grok
		};
		const available = this.session.availableModels().map((model) => model.id);
		const selected = this.session.selectedModelIds();
		return {
			status: "signed-in",
			models: this.session.visibleModels().map((model) => model.id),
			available,
			selected: selected ?? available,
			catalogSource: this.session.catalogSource,
			grokImportAvailable: grok,
			...this.session.catalogError === void 0 ? {} : { catalogError: this.session.catalogError }
		};
	}
	rejectChallenge(error) {
		for (const waiter of this.challengeWaiters.splice(0)) waiter.reject(error);
	}
};
function trustedRequest(req) {
	const remote = req.socket.remoteAddress;
	if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const host = req.headers.host;
	if (host === void 0) return false;
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === new URL(`http://${host}`).host;
	} catch {
		return false;
	}
}
async function readJson(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text.length === 0) return {};
	return JSON.parse(text);
}
function json(res, status, value) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	res.end(JSON.stringify(value));
}
/** Register the plugin-owned OAuth routes when the Web server is composed. */
function registerXaiOAuthAuthRoutes(ctx, session) {
	const auth = new XaiOAuthWebAuth(session);
	ctx.effect(() => {
		const routes = [
			ctx.webServer.register({
				kind: "exact",
				path: XAI_OAUTH_AUTH_STATUS_PATH,
				handler: async (req, res) => {
					if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
					if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
					json(res, 200, await auth.status());
				}
			}),
			ctx.webServer.register({
				kind: "exact",
				path: XAI_OAUTH_AUTH_LOGIN_PATH,
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
					if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
					try {
						json(res, 200, await auth.signIn());
					} catch (error) {
						json(res, 500, { error: safeMessage(error) });
					}
				}
			}),
			ctx.webServer.register({
				kind: "exact",
				path: XAI_OAUTH_AUTH_IMPORT_PATH,
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
					if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
					try {
						await auth.importGrok();
						json(res, 200, await auth.status());
					} catch (error) {
						json(res, 500, { error: safeMessage(error) });
					}
				}
			}),
			ctx.webServer.register({
				kind: "exact",
				path: XAI_OAUTH_AUTH_MODELS_PATH,
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
					if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
					try {
						const body = await readJson(req);
						const selected = typeof body === "object" && body !== null && "selected" in body ? body.selected : void 0;
						if (!Array.isArray(selected) || selected.some((id) => typeof id !== "string")) return json(res, 400, { error: "selected must be an array of model ids" });
						await auth.setModels(selected);
						json(res, 200, await auth.status());
					} catch (error) {
						json(res, 500, { error: safeMessage(error) });
					}
				}
			}),
			ctx.webServer.register({
				kind: "exact",
				path: XAI_OAUTH_AUTH_LOGOUT_PATH,
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
					if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
					await auth.signOut();
					json(res, 200, { ok: true });
				}
			})
		];
		return async () => {
			for (const dispose of routes) dispose();
			await auth.dispose();
		};
	}, "dsh-xai: Web OAuth routes");
}
//#endregion
//#region src/session.ts
/**
* Shared OAuth store + live catalog for the host plugin and CLI.
* @module dsh-xai/session
*/
const MODELS_CACHE_VERSION = 2;
const MODELS_CACHE_FILENAME = ".xai-oauth-models.json";
function isENOENT(error) {
	return error?.code === "ENOENT";
}
function modelsCachePath(dshHome) {
	return resolve(join(resolveDshHome(dshHome), MODELS_CACHE_FILENAME));
}
function parseIdList(value) {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((id) => typeof id === "string" && id.length > 0))];
}
function parseCache(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const document = value;
	if (document["version"] !== 1 && document["version"] !== MODELS_CACHE_VERSION) return void 0;
	const ids = parseIdList(document["ids"]);
	const selected = parseIdList(document["selected"]);
	if (ids.length === 0 && selected.length === 0) return void 0;
	return {
		ids,
		...selected.length === 0 ? {} : { selected }
	};
}
function asHarnessModels(models) {
	return models.map((model) => model.provider === "xai-oauth" ? model : {
		...model,
		provider: XAI_OAUTH_ROUTE
	});
}
function requestProvider(provider) {
	return {
		...provider,
		auth: {
			...provider.auth,
			apiKey: {
				name: "xAI Grok OAuth bearer token",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "OAuth"
					};
				}
			}
		}
	};
}
/** One process-local owner of the credential and the account model list. */
var XaiOAuthSession = class {
	store;
	models;
	baseline;
	liveIds;
	selectedIds;
	source = "fallback";
	listingError;
	cacheFile;
	onCatalogChange;
	constructor(store = new XaiOAuthCredentialStore(), onCatalogChange) {
		this.store = store;
		this.cacheFile = modelsCachePath();
		this.baseline = xaiProvider();
		this.models = createModels({ credentials: store });
		this.models.setProvider(this.baseline);
		this.onCatalogChange = onCatalogChange;
	}
	/** Secret-free listing diagnostic from the last refresh. */
	get catalogError() {
		return this.listingError;
	}
	get catalogSource() {
		return this.source;
	}
	availableModels() {
		return mergeLiveCatalog(this.baseline.getModels(), this.liveIds);
	}
	selectedModelIds() {
		return this.selectedIds;
	}
	visibleModels() {
		const available = this.availableModels();
		if (this.selectedIds === void 0 || this.selectedIds.length === 0) return available;
		const byId = new Map(available.map((model) => [model.id, model]));
		const catalog = this.baseline.getModels();
		return this.selectedIds.map((id) => byId.get(id) ?? materializeLiveModel(id, catalog));
	}
	/** Provider whose id matches the harness route so PiAiAdapter can list models. */
	provider() {
		return {
			...requestProvider(this.baseline),
			id: XAI_OAUTH_ROUTE,
			name: "xAI Grok",
			getModels: () => asHarnessModels(this.visibleModels())
		};
	}
	async loadCachedCatalog() {
		try {
			const cache = parseCache(await readFile(this.cacheFile, "utf8"));
			if (cache === void 0) return;
			if (cache.ids.length > 0) {
				this.liveIds = cache.ids;
				this.source = "cache";
			}
			this.selectedIds = cache.selected;
		} catch (error) {
			if (!isENOENT(error)) throw error;
		}
	}
	async refreshLiveCatalog(signal) {
		const access = (await this.models.getAuth("xai"))?.auth.apiKey;
		if (access === void 0 || access.length === 0) {
			this.listingError = void 0;
			return;
		}
		try {
			const ids = await fetchLiveModelIds(access, signal);
			this.liveIds = ids;
			this.source = "live";
			this.listingError = void 0;
			await this.writeCache();
			this.onCatalogChange?.();
		} catch (error) {
			this.listingError = error instanceof Error ? error.message : String(error);
			if (this.liveIds === void 0) this.source = "fallback";
		}
	}
	async setSelectedModels(ids) {
		const unique = [...new Set(ids.filter((id) => id.length > 0))];
		this.selectedIds = unique.length === 0 ? void 0 : unique;
		await this.writeCache();
		this.onCatalogChange?.();
	}
	async logout() {
		await this.store.delete("xai");
		this.liveIds = void 0;
		this.selectedIds = void 0;
		this.source = "fallback";
		this.listingError = void 0;
		await mkdir(dirname(this.cacheFile), {
			recursive: true,
			mode: 448
		});
		await rm(this.cacheFile, { force: true });
		this.onCatalogChange?.();
	}
	async writeCache() {
		const document = {
			version: MODELS_CACHE_VERSION,
			ids: this.liveIds === void 0 ? [] : [...this.liveIds],
			fetchedAt: Date.now(),
			...this.selectedIds === void 0 ? {} : { selected: [...this.selectedIds] }
		};
		await mkdir(dirname(this.cacheFile), {
			recursive: true,
			mode: 448
		});
		await writeFileAtomic(this.cacheFile, `${JSON.stringify(document)}\n`, {
			mode: 384,
			dirMode: 448
		});
	}
};
//#endregion
//#region src/web-search.ts
const XAI_WEB_SEARCH_PROVIDER_ID = "xai-oauth";
const DEFAULT_XAI_WEB_SEARCH_MODEL = "grok-build-0.1";
const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";
const USER_AGENT = "dsh-xai/0.1.0";
const ERROR_BODY_LIMIT = 300;
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonBlankString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function validWebUrl(value) {
	const candidate = nonBlankString(value);
	if (candidate === void 0) return void 0;
	try {
		const parsed = new URL(candidate);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? candidate : void 0;
	} catch {
		return;
	}
}
function sourceFromRecord(value) {
	if (!isRecord(value)) return void 0;
	const url = validWebUrl(value["url"]);
	if (url === void 0) return void 0;
	const title = nonBlankString(value["title"]);
	const snippet = nonBlankString(value["snippet"]) ?? nonBlankString(value["description"]);
	const publishedAt = nonBlankString(value["publishedAt"]) ?? nonBlankString(value["published_at"]);
	return {
		url,
		...title !== void 0 ? { title } : {},
		...snippet !== void 0 ? { snippet } : {},
		...publishedAt !== void 0 ? { publishedAt } : {}
	};
}
function mergeSources(groups) {
	const byUrl = /* @__PURE__ */ new Map();
	for (const group of groups) for (const source of group) {
		const previous = byUrl.get(source.url);
		if (previous === void 0) {
			byUrl.set(source.url, source);
			continue;
		}
		byUrl.set(source.url, {
			url: source.url,
			...(previous.title ?? source.title) !== void 0 ? { title: previous.title ?? source.title } : {},
			...(previous.snippet ?? source.snippet) !== void 0 ? { snippet: previous.snippet ?? source.snippet } : {},
			...(previous.publishedAt ?? source.publishedAt) !== void 0 ? { publishedAt: previous.publishedAt ?? source.publishedAt } : {}
		});
	}
	return [...byUrl.values()];
}
function outputItems(body) {
	return Array.isArray(body["output"]) ? body["output"] : [];
}
function collectOutputText(body) {
	const texts = [];
	for (const item of outputItems(body)) {
		if (!isRecord(item) || item["type"] !== "message" || !Array.isArray(item["content"])) continue;
		for (const chunk of item["content"]) {
			if (!isRecord(chunk) || chunk["type"] !== "output_text") continue;
			const text = nonBlankString(chunk["text"]);
			if (text !== void 0) texts.push(text);
		}
	}
	return texts;
}
function collectActionSources(body) {
	const sources = [];
	for (const item of outputItems(body)) {
		if (!isRecord(item) || item["type"] !== "web_search_call" || !isRecord(item["action"])) continue;
		const rows = item["action"]["sources"];
		if (!Array.isArray(rows)) continue;
		for (const row of rows) {
			const source = sourceFromRecord(row);
			if (source !== void 0) sources.push(source);
		}
	}
	return sources;
}
function collectAnnotationSources(body) {
	const sources = [];
	for (const item of outputItems(body)) {
		if (!isRecord(item) || item["type"] !== "message" || !Array.isArray(item["content"])) continue;
		for (const chunk of item["content"]) {
			if (!isRecord(chunk) || chunk["type"] !== "output_text" || !Array.isArray(chunk["annotations"])) continue;
			for (const annotation of chunk["annotations"]) {
				if (!isRecord(annotation) || annotation["type"] !== "url_citation") continue;
				const url = validWebUrl(annotation["url"]);
				if (url !== void 0) sources.push({ url });
			}
		}
	}
	return sources;
}
function collectCitationSources(body) {
	if (!Array.isArray(body["citations"])) return [];
	const sources = [];
	for (const citation of body["citations"]) {
		if (typeof citation === "string") {
			const url = validWebUrl(citation);
			if (url !== void 0) sources.push({ url });
			continue;
		}
		const source = sourceFromRecord(citation);
		if (source !== void 0) sources.push(source);
	}
	return sources;
}
/** Map an xAI Responses API envelope into DSH's native search result shape. */
function mapXaiWebSearchResponse(body) {
	const content = collectOutputText(body).join("\n\n").trim();
	const sources = mergeSources([
		collectActionSources(body),
		collectAnnotationSources(body),
		collectCitationSources(body)
	]);
	return {
		...content.length > 0 ? { content } : {},
		sources,
		truncated: false
	};
}
function xaiApiErrorMessage(body) {
	if (!isRecord(body)) return void 0;
	const error = body["error"];
	if (typeof error === "string") return nonBlankString(error);
	if (!isRecord(error)) return void 0;
	return nonBlankString(error["message"]) ?? nonBlankString(error["code"]);
}
function isAbortError(error) {
	if (error instanceof DOMException && error.name === "AbortError") return true;
	return isRecord(error) && error["name"] === "AbortError";
}
async function parseErrorResponse(response, signal) {
	const fallback = `xAI Web Search failed (HTTP ${response.status})`;
	try {
		const text = await response.text();
		if (signal?.aborted) throw new XaiOAuthWebSearchError("xAI Web Search aborted", "WEB_ABORTED");
		if (text.length === 0) return fallback;
		try {
			const detail = xaiApiErrorMessage(JSON.parse(text));
			if (detail !== void 0) return `${fallback}: ${detail.slice(0, ERROR_BODY_LIMIT)}`;
		} catch {}
		return `${fallback}: ${text.trim().slice(0, ERROR_BODY_LIMIT)}`;
	} catch (error) {
		if (error instanceof XaiOAuthWebSearchError) throw error;
		if (signal?.aborted || isAbortError(error)) throw new XaiOAuthWebSearchError("xAI Web Search aborted", "WEB_ABORTED", { cause: error });
		return fallback;
	}
}
function buildSearchPrompt(query) {
	return [
		"Use the web_search tool to research the search topic below.",
		"Return a concise factual summary grounded in the web sources you found.",
		`Search topic: ${JSON.stringify(query)}`
	].join("\n");
}
var XaiOAuthWebSearchError = class extends WebError {};
/** DSH-native search provider using only a SuperGrok/X OAuth bearer. */
var XaiOAuthWebSearchProvider = class {
	tokens;
	id = XAI_WEB_SEARCH_PROVIDER_ID;
	model;
	fetchImpl;
	constructor(tokens, options = {}) {
		this.tokens = tokens;
		this.model = options.model?.trim() || "grok-build-0.1";
		this.fetchImpl = options.fetch ?? globalThis.fetch;
	}
	available() {
		return this.model.length > 0 && this.tokens.available();
	}
	async request(accessToken, request, signal) {
		try {
			return await this.fetchImpl(XAI_RESPONSES_URL, {
				method: "POST",
				redirect: "error",
				headers: {
					authorization: `Bearer ${accessToken}`,
					"content-type": "application/json",
					accept: "application/json",
					"user-agent": USER_AGENT
				},
				body: JSON.stringify({
					model: this.model,
					input: [{
						role: "user",
						content: buildSearchPrompt(request.query)
					}],
					tools: [{ type: "web_search" }],
					include: ["web_search_call.action.sources", "no_inline_citations"],
					store: false
				}),
				...signal !== void 0 ? { signal } : {}
			});
		} catch (error) {
			if (signal?.aborted || isAbortError(error)) throw new XaiOAuthWebSearchError("xAI Web Search aborted", "WEB_ABORTED", { cause: error });
			throw new XaiOAuthWebSearchError("Could not reach xAI Web Search", "WEB_PROVIDER_ERROR", { cause: error });
		}
	}
	async search(request, signal) {
		let accessToken;
		try {
			accessToken = await this.tokens.resolve(signal);
		} catch (error) {
			if (signal?.aborted || isAbortError(error)) throw new XaiOAuthWebSearchError("xAI Web Search aborted", "WEB_ABORTED", { cause: error });
			throw new XaiOAuthWebSearchError("Could not resolve the SuperGrok OAuth credential", "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (accessToken === void 0 || accessToken.length === 0) throw new XaiOAuthWebSearchError("xAI Web Search requires a SuperGrok/X OAuth sign-in; API-key fallback is intentionally disabled", "WEB_PROVIDER_ERROR");
		let response = await this.request(accessToken, request, signal);
		if (response.status === 401 && this.tokens.refresh !== void 0) {
			let refreshed;
			try {
				refreshed = await this.tokens.refresh(accessToken, signal);
			} catch (error) {
				if (signal?.aborted || isAbortError(error)) throw new XaiOAuthWebSearchError("xAI Web Search aborted", "WEB_ABORTED", { cause: error });
				throw new XaiOAuthWebSearchError("Could not refresh the SuperGrok OAuth credential after HTTP 401", "WEB_PROVIDER_ERROR", { cause: error });
			}
			if (refreshed !== void 0 && refreshed.length > 0 && refreshed !== accessToken) {
				accessToken = refreshed;
				response = await this.request(accessToken, request, signal);
			}
		}
		if (!response.ok) throw new XaiOAuthWebSearchError(await parseErrorResponse(response, signal), "WEB_PROVIDER_ERROR");
		let body;
		try {
			body = await response.json();
		} catch (error) {
			if (signal?.aborted || isAbortError(error)) throw new XaiOAuthWebSearchError("xAI Web Search aborted", "WEB_ABORTED", { cause: error });
			throw new XaiOAuthWebSearchError("xAI Web Search returned invalid JSON", "WEB_PROVIDER_ERROR", { cause: error });
		}
		const apiError = xaiApiErrorMessage(body);
		if (apiError !== void 0) throw new XaiOAuthWebSearchError(`xAI Web Search returned an error: ${apiError}`, "WEB_PROVIDER_ERROR");
		if (!isRecord(body)) throw new XaiOAuthWebSearchError("xAI Web Search returned an invalid response envelope", "WEB_PROVIDER_ERROR");
		return mapXaiWebSearchResponse(body);
	}
};
//#endregion
//#region src/index.ts
/**
* Optional xAI SuperGrok / X Premium bundle with OAuth, Grok models,
* browser account settings, and DSH-native Grok Web Search.
* @module dsh-xai
*/
/** Stable Cordis plugin name. */
const name = "llm-xai-oauth";
/** LLM registry required before the subscription route can register. */
const inject = ["llm"];
const Config = z.object({ webSearchModel: z.string() });
/** Build a token source that is OAuth-only by construction, including forced refresh after a 401. */
function createXaiOAuthWebSearchTokenSource(session) {
	return {
		available: () => existsSync(session.store.filename),
		async resolve(signal) {
			signal?.throwIfAborted();
			const credential = await session.store.read("xai");
			signal?.throwIfAborted();
			if (credential?.type !== "oauth") return void 0;
			const auth = await session.models.getAuth("xai");
			signal?.throwIfAborted();
			if (auth?.source !== "OAuth") return void 0;
			const accessToken = auth.auth.apiKey;
			return accessToken === void 0 || accessToken.length === 0 ? void 0 : accessToken;
		},
		async refresh(rejectedAccessToken, signal) {
			signal?.throwIfAborted();
			const oauth = session.models.getProvider("xai")?.auth.oauth;
			if (oauth === void 0) return void 0;
			const refreshSignal = signal ?? new AbortController().signal;
			const credential = await session.store.modify("xai", async (current) => {
				refreshSignal.throwIfAborted();
				if (current?.type !== "oauth") return void 0;
				if (current.access !== rejectedAccessToken) return void 0;
				return oauth.refresh(current, refreshSignal);
			});
			refreshSignal.throwIfAborted();
			if (credential?.type !== "oauth") return void 0;
			return credential.access.length === 0 ? void 0 : credential.access;
		}
	};
}
/** Register the xai-oauth LLM route and an OAuth-only Grok-backed WebSearchProvider. */
function apply(ctx, config) {
	const session = new XaiOAuthSession(new XaiOAuthCredentialStore(), () => {
		ctx.emit("llm/adapters-updated");
	});
	session.loadCachedCatalog().then(() => session.refreshLiveCatalog());
	ctx.llm.registerAdapter([XAI_OAUTH_ROUTE], createXaiOAuthAdapter(session, () => ctx.get("attachments")));
	ctx.inject(["webServer"], (webCtx) => registerXaiOAuthAuthRoutes(webCtx, session));
	ctx.inject(["web"], (webCtx) => {
		webCtx.web.registerSearchProvider(new XaiOAuthWebSearchProvider(createXaiOAuthWebSearchTokenSource(session), { model: config.webSearchModel ?? "grok-build-0.1" }));
	});
}
//#endregion
export { Config, DEFAULT_XAI_OAUTH_MODEL, DEFAULT_XAI_WEB_SEARCH_MODEL, XAI_MODELS_URL, XAI_OAUTH_AUTH_FILENAME, XAI_OAUTH_AUTH_IMPORT_PATH, XAI_OAUTH_AUTH_LOGIN_PATH, XAI_OAUTH_AUTH_LOGOUT_PATH, XAI_OAUTH_AUTH_MODELS_PATH, XAI_OAUTH_AUTH_STATUS_PATH, XAI_OAUTH_ROUTE, XAI_OAUTH_STREAM_IDLE_TIMEOUT_MS, XAI_PI_PROVIDER, XAI_RESPONSES_URL, XAI_WEB_SEARCH_PROVIDER_ID, XaiOAuthCredentialStore, XaiOAuthSession, XaiOAuthWebSearchError, XaiOAuthWebSearchProvider, apply, createXaiOAuthAdapter, createXaiOAuthWebSearchTokenSource, extractModelIds, fetchLiveModelIds, grokAuthPath, importGrokAuth, importXaiOAuthFromGrok, importXaiOAuthSession, inject, loginXaiOAuth, loginXaiOAuthSession, logoutXaiOAuth, mapXaiWebSearchResponse, materializeLiveModel, mergeLiveCatalog, name, parseGrokAuthDocument, preferredXaiOAuthModel, preferredXaiOAuthModelFrom, probeGrokAuth, registerXaiOAuthAuthRoutes, safeMessage, xaiOAuthAuthPath, xaiOAuthAuthStatus };
