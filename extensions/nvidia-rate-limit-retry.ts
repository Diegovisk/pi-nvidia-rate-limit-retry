import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * NVIDIA NIM Rate Limit Retry Extension
 *
 * NVIDIA NIM models are free but aggressively rate-limited (429s).
 * They usually succeed on retry, but the default retry budget (3 attempts
 * with 2s base backoff) and visible error messages clutter the conversation.
 *
 * WHAT THIS DOES:
 * 1. Intercepts NVIDIA NIM 429/rate-limit errors at message_end
 * 2. Replaces the ugly error text with a compact retry note so session
 *    history stays clean — you see "⏳ NVIDIA rate limit — retry 2/8"
 * 3. Preserves stopReason="error" and errorMessage so pi's built-in retry
 *    system (exponential backoff + agent state cleanup) still works
 * 4. After built-in retries are exhausted, lets the final error through
 *
 * ── RECOMMENDED settings.json ────────────────────────────────────────────────
 * The default retry budget is 3 attempts x 2s base = ~14s total.
 * For NVIDIA NIM (aggressive rate limiting), increase it:
 *
 *   "retry": {
 *     "enabled": true,
 *     "maxRetries": 10,
 *     "baseDelayMs": 2000
 *   }
 *
 * ── RESPONSE TIMES (with default 2s base delay) ──────────────────────────────
 *   Attempt  |  Delay   |  Cumulative
 *   ─────────┼──────────┼─────────────
 *      1     |  2 000ms |    2s
 *      2     |  4 000ms |    6s
 *      3     |  8 000ms |   14s
 *      4     | 16 000ms |   30s
 *      5     | 32 000ms |   62s  (~1 min)
 *      6-100 | 60 000ms |  cap at 1 min each
 *    100     | 60 000ms |  ~100 min max
 */

// ─── State ───────────────────────────────────────────────────────────────────

const STATE = {
	isNvidiaNim: false,
	retryCount: 0,
	maxRetries: 100, // NVIDIA NIM is aggressively rate-limited
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isNvidiaProvider(provider: string | undefined): boolean {
	if (!provider) return false;
	return /nvidia|nim|nvapi/i.test(provider);
}

function isRateLimitError(msg: { stopReason?: string; errorMessage?: string }): boolean {
	if (msg.stopReason !== "error" || !msg.errorMessage) return false;
	const err = msg.errorMessage.toLowerCase();
	return (
		err.includes("429") ||
		err.includes("rate limit") ||
		err.includes("too many requests") ||
		err.includes("throttl") ||
		err.includes("please wait")
	);
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let notifiedSettings = false;
	let startupBannerShown = false;
	let activeModelProvider: string | undefined;

	/**
	 * startup banner — fires once per process.
	 * If you see this in the logs after `/reload`, the extension is loaded.
	 */
	const showStartupBanner = () => {
		if (startupBannerShown) return;
		startupBannerShown = true;
		console.log(
			`[nvidia-rate-limit-retry] loaded — active for NVIDIA NIM models ` +
			`(max ${STATE.maxRetries} retries, exponential backoff up to 60s).`,
		);
	};

	/**
	 * Per-turn banner — fires once on each agent_start while an NVIDIA
	 * model is selected. If you see this when you send a prompt to an
	 * NVIDIA model, the extension is wired to model_select + message_end.
	 */
	const showActiveBanner = () => {
		if (!STATE.isNvidiaNim) return;
		console.log(
			`[nvidia-rate-limit-retry] active — provider="${activeModelProvider ?? "?"}" ` +
			`awaiting 429/rate-limit errors.`,
		);
	};

	pi.on("session_start", async () => {
		showStartupBanner();
		STATE.retryCount = 0;
	});

	/**
	 * Track whether the active model is NVIDIA NIM so we only
	 * intercept errors from the right provider.
	 */
	pi.on("model_select", async (event) => {
		activeModelProvider = event.model?.provider;
		STATE.isNvidiaNim = isNvidiaProvider(activeModelProvider);
		STATE.retryCount = 0;

		if (STATE.isNvidiaNim && !notifiedSettings) {
			notifiedSettings = true;

			const msg =
				"[nvidia-rate-limit-retry] NVIDIA NIM detected. " +
				"For more aggressive retries, add this to ~/.pi/config/settings.json:\n" +
				'  "retry": { "enabled": true, "maxRetries": 10, "baseDelayMs": 2000 }\n';
			console.log(msg);
		}
	});

	pi.on("agent_start", async () => {
		showStartupBanner();
		showActiveBanner();
	});

	/**
	 * Intercept assistant error messages from NVIDIA NIM.
	 *
	 * This runs AFTER pi's sessionManager.appendMessage() call, so the
	 * agent state already has the error recorded. We replace the visible
	 * text content while keeping stopReason + errorMessage intact, which
	 * lets pi's built-in retry system (exponential backoff + agent state
	 * cleanup) proceed normally.
	 *
	 * The session file stores the REPLACED message (clean text).
	 */
	pi.on("message_end", async (_event) => {
		const msg = _event.message;

		// Only intercept assistant error messages
		if (msg.role !== "assistant" || msg.stopReason !== "error" || !msg.errorMessage) {
			return;
		}

		// Only handle NVIDIA NIM rate limits
		if (!STATE.isNvidiaNim || !isRateLimitError(msg)) {
			return;
		}

		STATE.retryCount++;

		if (STATE.retryCount > STATE.maxRetries) {
			console.log(
				`[nvidia-rate-limit-retry] ${STATE.retryCount - 1} retries exhausted. ` +
				`Giving up: ${msg.errorMessage.slice(0, 120)}`,
			);
			STATE.retryCount = 0;
			return; // let the full error show through
		}

		const label = `${STATE.retryCount}/${STATE.maxRetries}`;

		// Keep stopReason="error" + errorMessage so built-in retry fires.
		// Only replace the visible text with a compact indicator.
		return {
			message: {
				...msg,
				content: [{
					type: "text" as const,
					text: `⏳ _NVIDIA rate limit — retry ${label}_`,
				}],
			},
		};
	});

	/**
	 * Reset the retry budget after a successful assistant response,
	 * so the next burst of rate limits gets full retries.
	 */
	pi.on("message_end", async (_event) => {
		const msg = _event.message;
		if (msg.role !== "assistant") return;
		if (msg.stopReason !== "error" && STATE.retryCount > 0) {
			console.log(
				`[nvidia-rate-limit-retry] Success after ${STATE.retryCount} retries. Budget reset.`,
			);
			STATE.retryCount = 0;
		}
	});
}