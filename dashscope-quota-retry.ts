/**
 * dashscope-quota-retry — Pi Extension
 *
 * DashScope returns HTTP 429 with code "insufficient_quota" on a burst quota
 * limit. Pi's auto-retry treats `insufficient_quota` / `quota exceeded` /
 * `billing` as NON-retryable account/billing limits and fails the turn
 * immediately, before its retry-with-backoff can run.
 *
 * For DashScope this is usually a transient burst limit, so reclassify the
 * error as a retryable rate limit. Pi's built-in retry (settings.retry:
 * 3 attempts, baseDelayMs ~20s) then gives it another shot.
 *
 * The sanitized message drops the phrases pi blacklists as non-retryable so
 * the rewrite is stable.
 */

import type { ExtensionAPI, MessageEndEvent } from "@earendil-works/pi-coding-agent";

const DASHSCOPE_QUOTA = /insufficient_quota|quota exceeded|Allocated quota/i;

export default function (pi: ExtensionAPI) {
	pi.on("message_end", (event: MessageEndEvent, ctx) => {
		const m = event.message;
		if (m.role !== "assistant" || m.stopReason !== "error") return;
		if (m.provider !== "dashscope" && ctx.model?.provider !== "dashscope") return;
		const em = m.errorMessage ?? "";
		if (!DASHSCOPE_QUOTA.test(em)) return;

		// Drop phrases pi's non-retryable pattern matches, keep the rest for context.
		// Match case-insensitively so mixed-case provider strings don't leak through.
		const cleaned = em
			.replace(/insufficient_quota/gi, "quota")
			.replace(/quota exceeded/gi, "quota limit hit")
			.replace(/Allocated quota/gi, "Allocated quota limit");

		return {
			message: {
				...m,
				errorMessage: `429 rate limit: DashScope quota burst (${cleaned})`,
			},
		};
	});
}