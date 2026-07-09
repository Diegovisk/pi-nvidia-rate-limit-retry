import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getApiProvider } from "@earendil-works/pi-ai/compat";

// ─── Configuration ───────────────────────────────────────────────────────────
//
// Tunable via env vars (no settings.json edit required):
//   NVIDIA_RETRY_MAX        — max attempts per burst (default 20)
//   NVIDIA_RETRY_BASE_MS    — base backoff in ms (default 2000)
//   NVIDIA_RETRY_CAP_MS     — max single-delay in ms (default 60_000)
//   NVIDIA_RETRY_JITTER     — jitter fraction 0.0–1.0 (default 0.2)
//
// 20 attempts with 2s→4s→8s→…→60s capped + 20% jitter lands at ~5–6 min
// of retry wall-clock after which we give up and surface the error.

const MAX_ATTEMPTS = parseIntEnv(process.env.NVIDIA_RETRY_MAX, 20);
const BASE_MS = parseIntEnv(process.env.NVIDIA_RETRY_BASE_MS, 2_000);
const CAP_MS = parseIntEnv(process.env.NVIDIA_RETRY_CAP_MS, 60_000);
const JITTER = Math.max(
	0,
	Math.min(1, parseFloatEnv(process.env.NVIDIA_RETRY_JITTER, 0.2)),
);

const NVIDIA_PROVIDER_ID = "nvidia";
const RETRY_TAG = "[nvidia-rate-limit-retry]";

// Stable marker used as the prefix of the final-exhaustion errorMessage and
// matched by the `message_end` rewrite handler. MUST NOT contain any substring
// that pi's `isRetryableAssistantError` retry/non-retry pattern sets match,
// otherwise pi will re-enter our wrapper or classify the failure as a billing
// limit. We verified this against the regex sets in
// `@earendil-works/pi-ai/dist/utils/retry.js`.
const EXHAUSTION_MARKER = "nvidia-nim-retry-budget-exhausted";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseIntEnv(v: string | undefined, fallback: number): number {
	if (!v) return fallback;
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseFloatEnv(v: string | undefined, fallback: number): number {
	if (!v) return fallback;
	const n = Number.parseFloat(v);
	return Number.isFinite(n) ? n : fallback;
}

function isRateLimitErrorMessage(text: string | undefined): boolean {
	if (!text) return false;
	const err = text.toLowerCase();
	return (
		err.includes("429") ||
		err.includes("rate limit") ||
		err.includes("too many requests") ||
		err.includes("throttl") ||
		err.includes("please wait")
	);
}

function backoffMs(attempt: number, abortSignal?: AbortSignal): Promise<void> {
	const ideal = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, attempt - 1));
	const jitterRange = ideal * JITTER;
	const offset = (Math.random() * 2 - 1) * jitterRange;
	const delay = Math.max(0, Math.round(ideal + offset));
	return new Promise<void>((resolve, reject) => {
		if (abortSignal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		// We use an `AbortListener` we'd otherwise leak on the resolve path, so
		// wrap the resolver to detach it once the timer fires naturally.
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		const onTimer = () => {
			abortSignal?.removeEventListener("abort", onAbort);
			resolve();
		};
		const timer = setTimeout(onTimer, delay);
		abortSignal?.addEventListener("abort", onAbort, { once: true });
	});
}

// ─── Minimal inline event-stream ─────────────────────────────────────────────
//
// We can't subpath-import `@earendil-works/pi-ai/utils/event-stream` here
// because that path isn't aliased by pi's jiti loader. The class is small
// enough to inline. Mirrors `AssistantMessageEventStream` byte-for-byte.

type AssistantMessageEvent =
	| { type: "start"; partial: any }
	| { type: "text_start"; contentIndex: number; partial: any }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: any }
	| { type: "text_end"; contentIndex: number; content: string; partial: any }
	| { type: "thinking_start"; contentIndex: number; partial: any }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: any }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: any }
	| { type: "toolcall_start"; contentIndex: number; partial: any }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: any }
	| { type: "toolcall_end"; contentIndex: number; toolCall: any; partial: any }
	| { type: "done"; reason: "stop" | "length" | "toolUse"; message: any }
	| { type: "error"; reason: "aborted" | "error"; error: any };

interface OuterStream extends AsyncIterable<AssistantMessageEvent> {
	push(event: AssistantMessageEvent): void;
	end(result?: any): void;
	result(): Promise<any>;
}

function createAssistantMessageEventStream(): OuterStream {
	let resolved = false;
	let resolveResult: (v: any) => void = () => {};
	const finalResultPromise = new Promise<any>((res) => (resolveResult = res));

	const queue: AssistantMessageEvent[] = [];
	const waiting: Array<(v: IteratorResult<AssistantMessageEvent>) => void> = [];
	let done = false;

	const isComplete = (ev: AssistantMessageEvent) => ev.type === "done" || ev.type === "error";
	const extractResult = (ev: AssistantMessageEvent): any => {
		if (ev.type === "done") return ev.message;
		if (ev.type === "error") return ev.error;
		throw new Error("Unexpected event type for final result");
	};

	return {
		push(event) {
			if (done) return;
			if (isComplete(event)) {
				done = true;
				if (!resolved) {
					resolved = true;
					resolveResult(extractResult(event));
				}
			}
			const waiter = waiting.shift();
			if (waiter) waiter({ value: event, done: false });
			else queue.push(event);
		},
		end(result) {
			done = true;
			if (result !== undefined && !resolved) {
				resolved = true;
				resolveResult(result);
			}
			while (waiting.length > 0) {
				const waiter = waiting.shift();
				waiter!({ value: undefined as never, done: true });
			}
		},
		result() {
			return finalResultPromise;
		},
		async *[Symbol.asyncIterator]() {
			while (true) {
				if (queue.length > 0) {
					yield queue.shift()!;
				} else if (done) {
					return;
				} else {
					const result = await new Promise<IteratorResult<AssistantMessageEvent>>(
						(resolve) => waiting.push(resolve),
					);
					if (result.done) return;
					yield result.value;
				}
			}
		},
	};
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Capture the original `openai-completions` streamSimple BEFORE we register
	// our wrapper, because registering replaces the api-registry entry. The
	// wrapper then gates on `model.provider === "nvidia"` and passes everything
	// else through to the captured original — keeping openai/deepseek/groq/etc.
	// behaviour identical.
	const originalOpenAI = getApiProvider("openai-completions");
	if (!originalOpenAI || typeof originalOpenAI.streamSimple !== "function") {
		console.error(
			`${RETRY_TAG} could not capture original openai-completions streamSimple. ` +
			"NVIDIA retry wrapper is not active.",
		);
		return;
	}
	const passthrough: any = originalOpenAI.streamSimple;

	pi.registerProvider(NVIDIA_PROVIDER_ID, {
		api: "openai-completions",
		streamSimple: (model: any, context: any, options: any) => {
			if (model?.provider !== NVIDIA_PROVIDER_ID) {
				return passthrough(model, context, options);
			}
			return nvidiaRetryStream(passthrough, model, context, options);
		},
	});

	// One-time startup banner — proof of life after /reload.
	let startupBannerShown = false;
	const startupBanner = () => {
		if (startupBannerShown) return;
		startupBannerShown = true;
		console.log(
			`${RETRY_TAG} loaded — NVIDIA NIM retries: ` +
			`max ${MAX_ATTEMPTS}, base ${BASE_MS}ms, cap ${CAP_MS}ms, jitter ${JITTER * 100}%.`,
		);
	};

	pi.on("session_start", async () => {
		startupBanner();
	});

	// Trim the final "gave up" message in the session file so the conversation
	// stays readable. The wrapper above already prevents every 429 from reaching
	// pi as an error, so this only fires when MAX_ATTEMPTS is hit.
	pi.on("message_end", async (event) => {
		const msg = event.message as any;
		if (!msg || msg.role !== "assistant") return;
		if (msg.stopReason !== "error") return;
		const provider = msg.provider as string | undefined;
		if (provider !== NVIDIA_PROVIDER_ID) return;
		// Match the exhaustion marker emitted by the stream wrapper. Don't
		// rely on `isRateLimitErrorMessage` here -- the sentinel
		// errorMessage we emit (in `isLast`) deliberately avoids those
		// substrings so pi won't retry the call. A marker-based check
		// keeps this rewrite decoupled from the human-readable text.
		if (!msg.errorMessage?.includes(EXHAUSTION_MARKER)) return;

		const fallthrough =
			`⏳ _NVIDIA rate limit — gave up after ${MAX_ATTEMPTS} retries on the same request. ` +
			`Try again in a minute or switch models._`;
		return {
			message: {
				...msg,
				content: [{ type: "text" as const, text: fallthrough }],
			},
		};
	});
}

// ─── Stream wrapper ──────────────────────────────────────────────────────────

function nvidiaRetryStream(
	passthrough: (model: any, context: any, options: any) => any,
	model: any,
	context: any,
	options: any,
): any {
	const outer = createAssistantMessageEventStream();
	const signal: AbortSignal | undefined = options?.signal;

	// Drive the loop async. The outer stream returns immediately so callers
	// can iterate events mid-flight.
	(async () => {
		let forwardedContent = false;
		// Hoisted out of the per-attempt loop so a duplicate `start` on retry
		// (when !forwardedContent) is not re-forwarded. Otherwise the
		// second forward would be a second stream from the consumer's POV.
		let startPushed = false;

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			// If the signal lands here, push a terminal error so the outer
			// stream's async iterator doesn't hang waiting for a waiter to
			// resolve. Without this, callers would await forever.
			if (signal?.aborted) {
				const aborted: AssistantMessageEvent = {
					type: "error",
					reason: "aborted",
					error: {
						stopReason: "aborted",
						errorMessage: "aborted",
						provider: model?.provider,
						model: model?.id,
						api: model?.api,
					},
				};
				outer.push(aborted);
				outer.end(aborted.error);
				return;
			}

			let innerError: any | undefined;

			// Helper to forward ONE event, deciding per-type whether to drop.
			const fwd = (ev: AssistantMessageEvent) => {
				if (ev.type === "start") {
					if (startPushed) return; // only first start gets through
					startPushed = true;
					outer.push(ev);
					return;
				}
				if (
					ev.type === "text_start" ||
					ev.type === "text_delta" ||
					ev.type === "text_end" ||
					ev.type === "thinking_start" ||
					ev.type === "thinking_delta" ||
					ev.type === "thinking_end" ||
					ev.type === "toolcall_start" ||
					ev.type === "toolcall_delta" ||
					ev.type === "toolcall_end"
				) {
					forwardedContent = true;
					outer.push(ev);
					return;
				}
				outer.push(ev);
			};

			try {
				const inner = passthrough(model, context, {
					...options,
					maxRetries: 0, // Force sub-SDK retries off; we own the budget.
				});

				for await (const ev of inner as AsyncIterable<AssistantMessageEvent>) {
					fwd(ev);
					if (ev.type === "done") {
						outer.end(ev.message);
						return;
					}
					if (ev.type === "error") {
						innerError = ev.error;
						break;
					}
				}
			} catch (err) {
				innerError = err && typeof err === "object"
					? err
					: { stopReason: "error", errorMessage: String(err) };
			}

			if (!innerError) {
				innerError = {
					stopReason: "error",
					errorMessage: "stream closed without done or error",
				};
			}

			const errorMessage: string | undefined = innerError?.errorMessage;
			const is429 = isRateLimitErrorMessage(errorMessage);

			// Only retry on rate limits that arrived BEFORE content.
			if (!is429 || forwardedContent) {
				const reason =
					innerError?.stopReason === "aborted" ? "aborted" : "error";
				const errMsg: AssistantMessageEvent = {
					type: "error",
					reason,
					error: {
						...innerError,
						stopReason: reason,
						errorMessage: errorMessage ?? "unknown error",
						provider: model?.provider,
						model: model?.id,
						api: model?.api,
					},
				};
				outer.push(errMsg);
				outer.end(errMsg.error);
				return;
			}

			const isLast = attempt >= MAX_ATTEMPTS;
			const remaining = MAX_ATTEMPTS - attempt;
			console.log(
				`${RETRY_TAG} ${model?.id ?? "<model>"} — 429 on attempt ${attempt}/${MAX_ATTEMPTS}; ` +
				`${isLast ? "giving up." : `${remaining} attempt(s) left after backoff.`}`,
			);
			if (isLast) {
				const errMsg: AssistantMessageEvent = {
					type: "error",
					reason: "error",
					error: {
						...innerError,
						// WRAP with sentinel text that does NOT match pi's
						// `isRetryableAssistantError` regex set (rate.?limit,
						// 429, too many requests, overloaded, server.?error,
						// timeout, socket hang up, …). Otherwise pi's own retry
						// loop would call streamSimple again, our wrapper runs
						// another 20 attempts, and we end up with
						// `maxRetries=3` x `MAX_ATTEMPTS=20` = 60 attempted
						// requests on a single turn. The EXHAUSTION_MARKER
						// prefix additionally gives the message_end handler
						// a stable token to recognize this exact case
						// (decoupling the rewrite from the human-readable
						// text and the rate-limit pattern match). This is the
						// single line that keeps our "we own the budget"
						// promise actually true.
						stopReason: "error",
						errorMessage:
							`${EXHAUSTION_MARKER}: ${MAX_ATTEMPTS} consecutive failures, ` +
							`retry budget spent, no further attempts will help right now`,
						provider: model?.provider,
						model: model?.id,
						api: model?.api,
					},
				};
				outer.push(errMsg);
				outer.end(errMsg.error);
				return;
			}

			try {
				await backoffMs(attempt, signal);
			} catch {
				const errMsg: AssistantMessageEvent = {
					type: "error",
					reason: "aborted",
					error: {
						stopReason: "aborted",
						errorMessage: "aborted",
						provider: model?.provider,
						model: model?.id,
						api: model?.api,
					},
				};
				outer.push(errMsg);
				outer.end(errMsg.error);
				return;
			}
		}
	})();

	return outer;
}
