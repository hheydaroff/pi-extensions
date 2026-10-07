/**
 * content-filter-repair — Pi Extension
 *
 * DashScope's content filter can't be turned off. Once flagged text sits in
 * history, every later request fails. On a filter error this extension:
 *
 *   Input block (history flagged):
 *     probe context messages one by one against the same model (maxTokens 1),
 *     reword each hit with Haiku (CONTENT_FILTER_REWRITER=provider/id), re-probe,
 *     store as `context_edit` (raw history untouched, /tree back to undo), retry.
 *     Only history from EARLIER turns is reworded; hits in this turn (the user's
 *     own question) or that can't be reworded → fallback turn (no placeholders).
 *   Output block (answer cut mid-stream): drop the partial answer → fallback turn.
 *
 *   Fallback turn: setModel(Sonnet 5.5, CONTENT_FILTER_FALLBACK=provider/id) and
 *   continue at once. When it settles, every message from that turn (plus
 *   unresolved hits) that the original model would reject is replaced, in
 *   context only, by a neutral Haiku summary (or a placeholder if even that is
 *   flagged), so the next turn goes back to the original model cleanly. The
 *   model is restored unless the user switched it meanwhile.
 *
 * ponytail: `pi -p` prints the last message from the model-visible context, so it
 * shows the summary instead of the fallback's answer; the TUI renders raw entries.
 *
 * Measured 2026-09-30: DashScope DeepSeek/GLM/Kimi input-block the same topics,
 * so the fallback must live off DashScope.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// mid-stream output blocks carry only the message, no code
const FILTER = /data_inspection_failed|DataInspectionFailed|data may contain inappropriate content/i;
const OUTPUT_FILTER = /output (text )?data may contain/i;
const MAX_ROUNDS = 3; // reword rounds per prompt before falling back
const MAX_PROBES = 60;
const BATCH = 4;
const MAX_REWRITE_CHARS = 24_000; // ponytail: longer texts count as unrewordable, chunk if that bites
const REWRITER = ["CONTENT_FILTER_REWRITER", "amazon-bedrock", "eu.anthropic.claude-haiku-5-5"] as const;
const FALLBACK = ["CONTENT_FILTER_FALLBACK", "amazon-bedrock", "eu.anthropic.claude-sonnet-5-5"] as const;
const PLACEHOLDER = "[exchange handled by a fallback model because of the provider's content filter; omitted]";

const REWRITE_PROMPT = `Rewrite the text below so it passes a strict mainland-China content filter (Alibaba DashScope), while keeping every technical and factual detail the conversation still needs.
- Remove or neutralise politically sensitive references (Chinese politics and leaders, 1989, Tibet, Xinjiang, Taiwan, Hong Kong protests, etc.), graphic violence, sexual content, slurs and profanity.
- Keep code, file paths, identifiers, numbers, URLs and structure exactly as they are.
- If a passage is only about a sensitive topic, replace it with a short neutral note such as "[sensitive detail omitted]".
- Output only the rewritten text, no preamble.

<text>
{TEXT}
</text>`;

const SUMMARY_PROMPT = `The message below must be replaced in a chat history by a neutral one- or two-sentence summary that passes a strict mainland-China content filter (Alibaba DashScope).
- Describe WHAT kind of exchange it was at a high level (e.g. "The user asked about a 20th-century historical event in China; the assistant gave a factual overview."), never the sensitive specifics: no names of political events, places, dates or figures that such a filter targets.
- If it contains code, file paths or identifiers the conversation may still need, keep those verbatim.
- Output only the summary.

<message role="{ROLE}">
{TEXT}
</message>`;

type Msg = { role: string; content: unknown; stopReason?: string; errorMessage?: string; summary?: string };
type Model = NonNullable<ExtensionContext["model"]>;
type Cand = { id: string; msg: Msg; src: any };

/** Everything the provider sees (probe input). `visible` = text blocks only (rewrite input). */
function textOf(m: Msg, visible = false): string {
	if (m.role === "compactionSummary" || m.role === "branchSummary") return m.summary ?? "";
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return "";
	return m.content
		.map((b: any) =>
			b.type === "text" ? b.text : visible ? "" : b.type === "thinking" ? b.thinking : b.type === "toolCall" ? JSON.stringify(b.arguments ?? {}) : "",
		)
		.filter(Boolean)
		.join("\n");
}

/** Context entry replacing `c` with `text`: keeps tool calls/images (pairing stays valid), drops thinking. */
function editFor(c: Cand, text: string): any {
	// compactions can't be context_edit targets: supersede with an identical one carrying the clean summary
	if (c.src.type === "compaction") return { type: "compaction", summary: text, firstKeptEntryId: c.src.firstKeptEntryId, details: c.src.details };
	const keep = Array.isArray(c.msg.content) ? c.msg.content.filter((b: any) => b.type === "toolCall" || b.type === "image") : [];
	const content = text ? [{ type: "text", text }, ...keep] : keep;
	if (!content.length) return { type: "context_edit", targetId: c.id, replacement: null };
	return { type: "context_edit", targetId: c.id, replacement: { content: Array.isArray(c.msg.content) ? content : text } };
}

function pick(ctx: ExtensionContext, [env, provider, id]: readonly [string, string, string]): Model | undefined {
	const o = process.env[env];
	const slash = o?.indexOf("/") ?? -1;
	return (o && slash > 0 && ctx.modelRegistry.find(o.slice(0, slash), o.slice(slash + 1))) || ctx.modelRegistry.find(provider, id);
}

/** true = filter hit, false = passed, undefined = other failure (unknown). */
async function flagged(ctx: ExtensionContext, model: Model, text: string): Promise<boolean | undefined> {
	try {
		const r: any = await ctx.modelRegistry.complete(
			model,
			{ messages: [{ role: "user", content: text, timestamp: Date.now() }] } as any,
			{ maxTokens: 1, signal: AbortSignal.timeout(30_000) } as any,
		);
		if (r.stopReason !== "error") return false;
		return FILTER.test(r.errorMessage ?? "") ? true : undefined;
	} catch (e: any) {
		return FILTER.test(String(e?.message ?? e)) ? true : undefined;
	}
}

/** Ask the rewriter model; `filtered` is the model whose filter we're dodging (never use it to rewrite). */
async function ask(ctx: ExtensionContext, filtered: Model, prompt: string): Promise<string | undefined> {
	const model = pick(ctx, REWRITER);
	if (!model || model.provider === filtered.provider) return undefined;
	try {
		const r: any = await ctx.modelRegistry.complete(
			model,
			{ messages: [{ role: "user", content: prompt, timestamp: Date.now() }] } as any,
			{ maxTokens: 8192, signal: AbortSignal.timeout(90_000) } as any,
		);
		return r.stopReason === "error" ? undefined : textOf(r).trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Probe `cands` in batches; `all` = don't stop at the first batch with a hit. */
async function scan(ctx: ExtensionContext, model: Model, cands: Cand[], all: boolean) {
	const hits: Cand[] = [];
	let unknown = 0;
	for (let i = 0; i < Math.min(cands.length, MAX_PROBES) && (all || hits.length === 0); i += BATCH) {
		const batch = cands.slice(i, Math.min(i + BATCH, MAX_PROBES));
		const res = await Promise.all(batch.map((c) => flagged(ctx, model, textOf(c.msg))));
		res.forEach((r, j) => (r === true ? hits.push(batch[j]) : r === undefined && unknown++));
	}
	return { hits, unknown };
}

/** Editable context messages, newest first. */
function candidates(contextEntries: any[]): Cand[] {
	const out: Cand[] = [];
	for (const pe of contextEntries) {
		const src: any = pe.sourceEntry;
		if (src.type === "compaction") {
			const msg = (pe.messages as Msg[]).find((m) => m.role === "compactionSummary");
			if (msg?.summary?.trim()) out.push({ id: src.id, msg, src });
			continue;
		}
		const msg = pe.messages[0] as Msg | undefined;
		if (!msg || (src.type !== "message" && src.type !== "custom_message") || msg.stopReason === "error") continue;
		if (["user", "assistant", "toolResult", "custom"].includes(msg.role) && textOf(msg).trim()) out.push({ id: src.id, msg, src });
	}
	return out.reverse();
}

export default function (pi: ExtensionAPI) {
	let pending = false;
	let outputBlocked = false;
	let rounds = 0;
	let runStart: string | null = null; // leaf before this run's prompt
	let lastError = "";
	let fb: { from: Model; to: Model; unresolved: Set<string>; why: string; failed?: string } | undefined;

	pi.on("before_agent_start", (_e, ctx) => {
		rounds = 0;
		runStart = ctx.sessionManager.getLeafId();
	});

	pi.on("message_end", (event) => {
		const m = event.message as Msg;
		if (m.role !== "assistant") return;
		if (fb) {
			fb.failed = m.stopReason === "error" ? m.errorMessage || "unknown error" : undefined;
			return;
		}
		if (m.stopReason !== "error" || !FILTER.test(m.errorMessage ?? "")) return;
		pending = true;
		lastError = m.errorMessage ?? "";
		outputBlocked = OUTPUT_FILTER.test(lastError);
	});

	pi.on("agent_settled", async (_e, ctx) => {
		if (!fb) return;
		const { from, to } = fb;
		fb = undefined;
		// restore only if the user didn't switch model during the fallback turn
		if (ctx.model?.provider === to.provider && ctx.model?.id === to.id) await pi.setModel(from);
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		const say = (msg: string, level: "info" | "warning" | "error" = "info"): undefined => {
			if (ctx.hasUI) ctx.ui.notify(`content-filter: ${msg}`, level);
		};
		const entries = event.context.contextEntries;
		const start = entries.findIndex((pe: any) => pe.sourceEntry.id === runStart);
		const thisRun = new Set(entries.slice(start + 1).map((pe: any) => pe.sourceEntry.id)); // start -1 → all (ponytail: MAX_PROBES caps it)

		// --- end of a fallback turn: make its messages safe for the original model
		if (fb) {
			if (fb.failed) return say(`fallback ${fb.to.id} failed too: ${fb.failed}\n(original: ${fb.why})`, "error");
			const cands = candidates(entries).filter((c) => thisRun.has(c.id) || fb!.unresolved.has(c.id));
			const { hits } = await scan(ctx, fb.from, cands, true);
			const out: any[] = [];
			for (const h of hits) {
				const text = textOf(h.msg, true);
				const sum = text.trim() && text.length <= MAX_REWRITE_CHARS
					? await ask(ctx, fb.from, SUMMARY_PROMPT.replace("{ROLE}", h.msg.role).replace("{TEXT}", () => text))
					: undefined;
				out.push(editFor(h, sum !== undefined && (await flagged(ctx, fb.from, sum)) === false ? sum : PLACEHOLDER));
			}
			if (hits.length) say(`summarised ${hits.length} flagged message(s) so ${fb.from.id} can take over next turn.`);
			return out.length ? { entries: out } : undefined;
		}

		if (!pending || !ctx.model) return;
		pending = false;
		const model = ctx.model;
		// not event.context.canContinue: it's computed before our edits, while the failed attempt is still last
		const edits: any[] = entries
			.filter((pe: any) => (pe.messages[0] as Msg | undefined)?.stopReason === "error" && pe.sourceEntry.type === "message")
			.map((pe: any) => ({ type: "context_edit", targetId: pe.sourceEntry.id, replacement: null })); // partial output can itself be flagged

		const fallBack = async (why: string, unresolved: Cand[] = []) => {
			const to = pick(ctx, FALLBACK);
			if (!to || to.provider === model.provider || !(await pi.setModel(to).catch(() => false)))
				return say(`${why}; fallback model ${FALLBACK[2]} unavailable. Switch model manually.`, "error") ?? { entries: edits };
			fb = { from: model, to, unresolved: new Set(unresolved.map((c) => c.id)), why };
			say(`↻ ${why} → ${to.id} for this turn`, "warning");
			return { entries: edits, continue: true };
		};

		if (outputBlocked) return fallBack("answer blocked mid-stream");
		if (rounds >= MAX_ROUNDS) return fallBack(`still blocked after ${MAX_ROUNDS} reword rounds`);
		rounds++;

		say("provider rejected the context, scanning history…");
		const { hits, unknown } = await scan(ctx, model, candidates(entries), false);
		if (!hits.length) {
			if (unknown) return fallBack(`probing failed for ${unknown} message(s)`);
			const sys = event.context.llmMessages
				.filter((m: any) => m.role === "system")
				.map((m: any) => [textOf(m), ...Object.values(m.sections ?? {})].filter(Boolean).join("\n"))
				.join("\n");
			const sysHit = sys.trim() && (await flagged(ctx, model, sys)) === true;
			return fallBack(sysHit ? "system prompt is flagged (AGENTS.md, memories, skills…)" : "no single message is flagged");
		}

		// rewording what the user just asked guts the question (live 2026-09-30: "[sensitive detail omitted]"
		// got answered as-is). This turn's hits go to the fallback; only older history is reworded.
		const unresolved = hits.filter((h) => thisRun.has(h.id));
		for (const h of hits.filter((h) => !thisRun.has(h.id))) {
			const visible = textOf(h.msg, true);
			if (!visible.trim()) {
				edits.push(editFor(h, "")); // flag was in thinking (dropped); flagged tool-call args survive, round cap stops the loop
				continue;
			}
			const text = visible.length <= MAX_REWRITE_CHARS ? await ask(ctx, model, REWRITE_PROMPT.replace("{TEXT}", () => visible)) : undefined;
			if (text !== undefined && (await flagged(ctx, model, text)) === false) edits.push(editFor(h, text));
			else unresolved.push(h);
		}
		if (unresolved.length) return fallBack(`${unresolved.length} flagged message(s) couldn't be reworded`, unresolved);
		say(`reworded ${hits.length} flagged message(s), retrying (round ${rounds}/${MAX_ROUNDS}).`, "warning");
		return { entries: edits, continue: true };
	});
}
