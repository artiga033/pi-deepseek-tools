/**
 * Web search / fetch tools backed by DeepSeek's Search & Fetch APIs.
 *
 *   POST https://api.deepseek.com/v1/tools/search
 *   POST https://api.deepseek.com/v1/tools/fetch
 *
 * Docs: https://api-docs.deepseek.com/zh-cn/guides/search
 *
 * The tools are provider-agnostic: they work with any chat model, and resolve
 * credentials independently of the active model. Credentials and usage stats
 * live in their own user-level file:
 *
 *   <agent-dir>/deepseek-tools.json
 *
 * Manage everything with `/deepseek_tools` (login, tools, stats, status).
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "deepseek-tools.json");
const BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
const MAX_CONTENT_CHARS = 6000;
const MAX_FETCH_CHARS = 30000;

type ToolName = "web_search" | "web_fetch";
const TOOL_NAMES: readonly ToolName[] = ["web_search", "web_fetch"];

type AuthMode = "auto" | "key" | "model";

interface AuthConfig {
	mode: AuthMode;
	apiKey?: string;
	model?: string;
	updatedAt?: string;
}

interface ToolStats {
	calls: number;
	succeeded: number;
	failed: number;
	totalResults: number;
	totalContentChars: number;
	totalLatencyMs: number;
	lastCallAt: string | null;
	lastError: string | null;
}

interface Config {
	version: 1;
	auth: AuthConfig;
	tools: Record<ToolName, boolean>;
	stats: Record<ToolName, ToolStats>;
}

type AnyModel = ReturnType<ExtensionContext["modelRegistry"]["getAll"]>[number];

// ---------------------------------------------------------------------------
// Config file
// ---------------------------------------------------------------------------

function emptyStats(): ToolStats {
	return {
		calls: 0,
		succeeded: 0,
		failed: 0,
		totalResults: 0,
		totalContentChars: 0,
		totalLatencyMs: 0,
		lastCallAt: null,
		lastError: null,
	};
}

function defaultConfig(): Config {
	return {
		version: 1,
		auth: { mode: "auto" },
		tools: { web_search: true, web_fetch: true },
		stats: { web_search: emptyStats(), web_fetch: emptyStats() },
	};
}

function normalize(raw: unknown): Config {
	const cfg = defaultConfig();
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return cfg;
	const record = raw as Record<string, any>;

	const auth = record.auth;
	if (auth && typeof auth === "object") {
		const mode = auth.mode;
		cfg.auth = {
			mode: mode === "key" || mode === "model" || mode === "auto" ? mode : "auto",
			...(typeof auth.apiKey === "string" && auth.apiKey.trim() ? { apiKey: auth.apiKey.trim() } : {}),
			...(typeof auth.model === "string" && auth.model.trim() ? { model: auth.model.trim() } : {}),
			...(typeof auth.updatedAt === "string" ? { updatedAt: auth.updatedAt } : {}),
		};
	}

	if (record.tools && typeof record.tools === "object") {
		for (const name of TOOL_NAMES) {
			if (typeof record.tools[name] === "boolean") cfg.tools[name] = record.tools[name];
		}
	}

	if (record.stats && typeof record.stats === "object") {
		for (const name of TOOL_NAMES) {
			const stats = record.stats[name];
			if (stats && typeof stats === "object") {
				cfg.stats[name] = { ...emptyStats(), ...stats, lastError: stats.lastError ?? null };
			}
		}
	}

	return cfg;
}

function loadConfig(): Config {
	try {
		return normalize(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
	} catch {
		return defaultConfig();
	}
}

function configExists(): boolean {
	try {
		return existsSync(CONFIG_PATH);
	} catch {
		return false;
	}
}

function saveConfig(cfg: Config): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
	renameSync(tmp, CONFIG_PATH);
}

// Serialize read-modify-write cycles so parallel tool calls cannot clobber stats.
let writeQueue: Promise<unknown> = Promise.resolve();

function mutateConfig(mutator: (cfg: Config) => void): Promise<Config> {
	const next = writeQueue.then(() => {
		const cfg = loadConfig();
		mutator(cfg);
		saveConfig(cfg);
		return cfg;
	});
	writeQueue = next.catch(() => undefined);
	return next;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

interface ResolvedAuth {
	apiKey: string;
	headers: Record<string, string>;
	source: string;
}

function findModel(ctx: ExtensionContext, ref: string): AnyModel | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0) return undefined;
	return ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
}

async function resolveAuth(ctx: ExtensionContext, cfg: Config): Promise<ResolvedAuth> {
	const auth = cfg.auth;

	if (auth.mode === "key" && auth.apiKey) {
		return { apiKey: auth.apiKey, headers: {}, source: "config:key" };
	}

	if (auth.mode === "model" && auth.model) {
		const model = findModel(ctx, auth.model);
		if (!model) {
			throw new Error(`Configured credential model "${auth.model}" is not registered. Run /deepseek_tools login again.`);
		}
		const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!resolved.ok || !resolved.apiKey) {
			throw new Error(`Cannot resolve credentials from "${auth.model}": ${resolved.error ?? "no API key found"}`);
		}
		return { apiKey: resolved.apiKey, headers: resolved.headers ?? {}, source: `model:${auth.model}` };
	}

	// auto: prefer the active deepseek model, then any registered deepseek model,
	// then the environment variable.
	const candidates: AnyModel[] = [];
	if (ctx.model?.provider === "deepseek") candidates.push(ctx.model);
	for (const model of ctx.modelRegistry.getAll()) {
		if (model.provider === "deepseek" && !candidates.some((c) => c.provider === model.provider && c.id === model.id)) {
			candidates.push(model);
		}
	}
	for (const model of candidates) {
		const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (resolved.ok && resolved.apiKey) {
			return {
				apiKey: resolved.apiKey,
				headers: resolved.headers ?? {},
				source: `model:${model.provider}/${model.id}`,
			};
		}
	}

	const envKey = process.env.DEEPSEEK_API_KEY?.trim();
	if (envKey) return { apiKey: envKey, headers: {}, source: "env:DEEPSEEK_API_KEY" };

	throw new Error(
		"No DeepSeek credentials found. Run /deepseek_tools login, /login deepseek, or set DEEPSEEK_API_KEY.",
	);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function post<T>(path: string, body: unknown, auth: ResolvedAuth, signal?: AbortSignal): Promise<T> {
	const response = await fetch(`${BASE_URL}${path}`, {
		method: "POST",
		headers: {
			...auth.headers,
			Authorization: `Bearer ${auth.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal,
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Request to ${path} failed: HTTP ${response.status} ${text.slice(0, 500)}`);
	}
	return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

async function recordResult(
	name: ToolName,
	startedAt: number,
	result: { ok: boolean; results?: number; chars?: number; error?: string },
): Promise<void> {
	await mutateConfig((cfg) => {
		const stats = cfg.stats[name];
		stats.calls += 1;
		stats.totalLatencyMs += Date.now() - startedAt;
		stats.lastCallAt = new Date().toISOString();
		if (result.ok) {
			stats.succeeded += 1;
			if (result.results) stats.totalResults += result.results;
			if (result.chars) stats.totalContentChars += result.chars;
		} else {
			stats.failed += 1;
			stats.lastError = (result.error ?? "unknown error").slice(0, 500);
		}
	});
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

interface SearchResult {
	rerank_score?: number;
	title?: string;
	url?: string;
	snippet?: string;
	summary?: string;
	content?: string;
	site_name?: string | null;
	date?: string | null;
	authority?: number;
}

interface SearchResponse {
	results?: SearchResult[];
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated, original length ${text.length} characters)`;
}

function formatResults(results: SearchResult[], withContent: boolean): string {
	if (results.length === 0) return "No search results found.";
	const blocks = results.map((item, index) => {
		const meta = [
			item.date ? item.date.slice(0, 10) : undefined,
			item.site_name ?? undefined,
			typeof item.authority === "number" && item.authority >= 0 ? `authority ${item.authority}/4` : undefined,
			typeof item.rerank_score === "number" ? `relevance ${item.rerank_score.toFixed(2)}` : undefined,
		].filter(Boolean);
		const lines = [`${index + 1}. ${item.title || "(untitled)"}`, `   ${item.url ?? "(no URL)"}`];
		if (meta.length > 0) lines.push(`   ${meta.join(" · ")}`);
		const summary = item.summary || item.snippet;
		if (summary) lines.push(`   ${summary}`);
		if (withContent && item.content) lines.push(`   Content:\n${truncate(item.content, MAX_CONTENT_CHARS)}`);
		return lines.join("\n");
	});
	return `Found ${results.length} result(s):\n\n${blocks.join("\n\n")}`;
}

function applyToolState(pi: ExtensionAPI, cfg: Config): void {
	const active = new Set(pi.getActiveTools());
	for (const name of TOOL_NAMES) {
		if (cfg.tools[name]) active.add(name);
		else active.delete(name);
	}
	pi.setActiveTools([...active]);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function webSearchToolsExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the live web. Returns titles, URLs, summaries, publish dates, authority and relevance scores. Use it when the answer needs current or external information; a snippet/summary is usually enough, set need_content only when you must read full pages. Supports query operators site:, -site:, \"exact phrase\", lang:zh,en, after:2025-01-01, before:2026.",
		promptSnippet: "Search the web (titles, URLs, summaries, dates, relevance)",
		promptGuidelines: [
			"Use web_search for current facts, documentation, releases, or anything outside the working directory.",
			"Use operators such as site:github.com, lang:zh, after:2025 to narrow web_search queries.",
			"Prefer web_search summaries; set need_content: true or use web_fetch only when full page text is required.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query, 1-128 characters" }),
			count: Type.Optional(Type.Number({ description: "Number of results, 1-50 (default 10)", minimum: 1, maximum: 50 })),
			need_content: Type.Optional(Type.Boolean({ description: "Return page body text in each result (default false)" })),
			ori_question: Type.Optional(Type.String({ description: "The user's original question, helps intent understanding" })),
			localization: Type.Optional(Type.String({ description: "IP address used to prefer localized results" })),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const startedAt = Date.now();
			try {
				const cfg = loadConfig();
				const auth = await resolveAuth(ctx, cfg);
				const body: Record<string, unknown> = {
					query: params.query,
					count: params.count ?? 10,
					need_content: params.need_content ?? false,
				};
				if (params.ori_question) body.ori_question = params.ori_question;
				if (params.localization) body.localization = params.localization;

				const data = await post<SearchResponse>("/v1/tools/search", body, auth, signal);
				const results = data.results ?? [];
				await recordResult("web_search", startedAt, { ok: true, results: results.length }).catch(() => undefined);

				return {
					content: [{ type: "text" as const, text: formatResults(results, params.need_content ?? false) }],
					details: {
						query: params.query,
						count: results.length,
						source: auth.source,
						results: results.map((item) => ({
							title: item.title ?? null,
							url: item.url ?? null,
							date: item.date ?? null,
							site: item.site_name ?? null,
							authority: item.authority ?? null,
							rerankScore: item.rerank_score ?? null,
							summary: item.summary ?? item.snippet ?? null,
							contentLength: item.content ? item.content.length : 0,
						})),
					},
				};
			} catch (error) {
				const message = errorMessage(error);
				await recordResult("web_search", startedAt, { ok: false, error: message }).catch(() => undefined);
				throw error;
			}
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a single web page and return its main content as Markdown. Use after web_search when a result's summary is insufficient. Works on http(s) URLs without credentials.",
		promptSnippet: "Fetch a web page as Markdown",
		parameters: Type.Object({
			url: Type.String({ description: "Absolute http(s) URL, max 8192 characters" }),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const startedAt = Date.now();
			try {
				const cfg = loadConfig();
				const auth = await resolveAuth(ctx, cfg);
				const data = await post<{ title?: string; content?: string }>("/v1/tools/fetch", { url: params.url }, auth, signal);
				const title = data.title || params.url;
				const content = data.content || "(the page had no extractable content)";
				await recordResult("web_fetch", startedAt, { ok: true, chars: data.content?.length ?? 0 }).catch(() => undefined);

				return {
					content: [{ type: "text" as const, text: `# ${title}\n\n${truncate(content, MAX_FETCH_CHARS)}` }],
					details: {
						url: params.url,
						title: data.title ?? null,
						source: auth.source,
						contentLength: data.content?.length ?? 0,
						truncated: (data.content?.length ?? 0) > MAX_FETCH_CHARS,
					},
				};
			} catch (error) {
				const message = errorMessage(error);
				await recordResult("web_fetch", startedAt, { ok: false, error: message }).catch(() => undefined);
				throw error;
			}
		},
	});

	// Apply saved tool switches when a session starts. Only when the user has
	// actually created the config file, so a first run keeps both tools active.
	pi.on("session_start", () => {
		if (!configExists()) return;
		applyToolState(pi, loadConfig());
	});

	pi.registerCommand("deepseek_tools", {
		description: "Manage web_search/web_fetch: login, toggles, stats, status",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
			switch (sub) {
				case "login":
					await handleLogin(ctx);
					return;
				case "logout":
					await handleLogout(ctx);
					return;
				case "tools":
					await handleTools(pi, ctx);
					return;
				case "stats":
					handleStats(ctx);
					return;
				case "status":
					await handleStatus(ctx);
					return;
				case "help":
				case "":
					await handleMenu(pi, ctx);
					return;
				default:
					ctx.ui.notify(`Unknown subcommand: ${sub}\nAvailable: login | logout | tools | stats | status | help`, "warning");
			}
		},
	});
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

const HELP = [
	"/deepseek_tools subcommands:",
	"  login   configure DeepSeek credentials (enter an API key or inherit from a model)",
	"  logout  clear the credentials saved by this extension",
	"  tools   toggle web_search / web_fetch independently",
	"  stats   show call statistics",
	"  status  show the credential source and tool switches",
].join("\n");

async function handleMenu(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(HELP, "info");
		return;
	}
	const choice = await ctx.ui.select("deepseek_tools", [
		"login — configure DeepSeek credentials",
		"tools — toggle web_search / web_fetch",
		"stats — show call statistics",
		"status — show current status",
		"help — show help",
	]);
	if (!choice) return;
	const sub = choice.split(" ")[0];
	if (sub === "login") return handleLogin(ctx);
	if (sub === "tools") return handleTools(pi, ctx);
	if (sub === "stats") return handleStats(ctx);
	if (sub === "status") return handleStatus(ctx);
	ctx.ui.notify(HELP, "info");
}

async function handleLogin(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("login requires an interactive TUI. Run it inside pi's interactive interface.", "error");
		return;
	}

	const mode = await ctx.ui.select("DeepSeek credential source", [
		"Enter an API key",
		"Inherit credentials from a model",
		"Automatic (use pi's deepseek login / environment variable)",
		"Clear saved credentials",
	]);
	if (!mode) return;

	if (mode.startsWith("Enter")) {
		const key = (await ctx.ui.input("DeepSeek API key", "sk-..."))?.trim();
		if (!key) return;
		await mutateConfig((cfg) => {
			cfg.auth = { mode: "key", apiKey: key, updatedAt: new Date().toISOString() };
		});
		ctx.ui.notify("DeepSeek API key saved.", "info");
		return;
	}

	if (mode.startsWith("Inherit")) {
		const available = ctx.modelRegistry.getAvailable();
		if (available.length === 0) {
			ctx.ui.notify("No available models. Run /login for a provider first.", "warning");
			return;
		}
		const refs = available.map((model) => `${model.provider}/${model.id}`);
		// Put DeepSeek models first: their keys are the ones the API accepts.
		refs.sort((a, b) => Number(!a.startsWith("deepseek/")) - Number(!b.startsWith("deepseek/")));

		const picked = await ctx.ui.select("Select a model to inherit credentials from (DeepSeek models first)", refs);
		if (!picked) return;

		const model = findModel(ctx, picked);
		if (!model) {
			ctx.ui.notify(`Model ${picked} does not exist.`, "error");
			return;
		}
		const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!resolved.ok || !resolved.apiKey) {
			ctx.ui.notify(`Cannot resolve credentials from ${picked}: ${resolved.error ?? "no API key found"}`, "error");
			return;
		}
		await mutateConfig((cfg) => {
			cfg.auth = { mode: "model", model: picked, updatedAt: new Date().toISOString() };
		});
		ctx.ui.notify(`Credentials inherited from ${picked} (resolved at runtime, no key copied).`, "info");
		return;
	}

	if (mode.startsWith("Automatic")) {
		await mutateConfig((cfg) => {
			cfg.auth = { mode: "auto", updatedAt: new Date().toISOString() };
		});
		ctx.ui.notify("Switched to automatic resolution (pi's deepseek credentials first, then DEEPSEEK_API_KEY).", "info");
		return;
	}

	await mutateConfig((cfg) => {
		cfg.auth = { mode: "auto" };
	});
	ctx.ui.notify("Saved credential configuration cleared.", "info");
}

async function handleLogout(ctx: ExtensionContext): Promise<void> {
	await mutateConfig((cfg) => {
		cfg.auth = { mode: "auto" };
	});
	ctx.ui.notify("Cleared the credentials saved by deepseek_tools (pi's /login credentials are untouched).", "info");
}

async function handleTools(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("tools requires an interactive TUI. Edit the config file directly or use /tools.", "error");
		return;
	}

	const cfg = loadConfig();
	const choice = await ctx.ui.select("Tool switches", [
		`${cfg.tools.web_search ? "✓" : "✗"} web_search`,
		`${cfg.tools.web_fetch ? "✓" : "✗"} web_fetch`,
		"Enable all",
		"Disable all",
	]);
	if (!choice) return;

	if (choice === "Enable all" || choice === "Disable all") {
		const enabled = choice === "Enable all";
		const next = await mutateConfig((current) => {
			for (const name of TOOL_NAMES) current.tools[name] = enabled;
		});
		applyToolState(pi, next);
		ctx.ui.notify(`web_search / web_fetch ${enabled ? "enabled" : "disabled"}.`, "info");
		return;
	}

	const name: ToolName = choice.includes("web_search") ? "web_search" : "web_fetch";
	const next = await mutateConfig((current) => {
		current.tools[name] = !current.tools[name];
	});
	applyToolState(pi, next);
	ctx.ui.notify(`${name} ${next.tools[name] ? "enabled" : "disabled"}.`, "info");
}

function handleStats(ctx: ExtensionContext): void {
	const cfg = loadConfig();
	const lines = TOOL_NAMES.map((name) => {
		const stats = cfg.stats[name];
		const avg = stats.calls > 0 ? Math.round(stats.totalLatencyMs / stats.calls) : 0;
		const extra =
			name === "web_search" ? `${stats.totalResults} results total` : `${stats.totalContentChars} content characters total`;
		const error = stats.lastError ? `\n  Last error: ${stats.lastError}` : "";
		return `${name}: calls ${stats.calls}, succeeded ${stats.succeeded}, failed ${stats.failed}, avg ${avg}ms, ${extra}\n  Last call: ${stats.lastCallAt ?? "never"}${error}`;
	});
	ctx.ui.notify(`Call statistics (${CONFIG_PATH})\n\n${lines.join("\n\n")}`, "info");
}

async function handleStatus(ctx: ExtensionContext): Promise<void> {
	const cfg = loadConfig();
	let authLine: string;
	try {
		const auth = await resolveAuth(ctx, cfg);
		authLine = `ready (source: ${auth.source})`;
	} catch (error) {
		authLine = `not ready: ${errorMessage(error)}`;
	}

	const toolLine = TOOL_NAMES.map((name) => `${name}=${cfg.tools[name] ? "on" : "off"}`).join(", ");
	ctx.ui.notify(
		[
			`Config file: ${CONFIG_PATH}`,
			`Credential mode: ${cfg.auth.mode}${cfg.auth.model ? ` (${cfg.auth.model})` : ""}`,
			`Credential status: ${authLine}`,
			`Tool switches: ${toolLine}`,
		].join("\n"),
		"info",
	);
}
