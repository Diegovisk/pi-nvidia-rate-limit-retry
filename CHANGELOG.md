# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.1] - 2026-07-08

### Fixed (after self-review)
- **Retry-stacking bug** (the only one that defeated the v2 promise): on final
  exhaustion the wrapper now emits the errorMessage
  `"NVIDIA NIM returned N consecutive failures, retry budget spent, no further attempts will help right now"`
  which does not match `isRetryableAssistantError`'s `RETRYABLE_PROVIDER_ERROR_PATTERN`
  (verified by Node-side regex test against the source). Without this fix,
  pi's own retry loop would call `streamSimple` again whenever the
  upstream 429 text was forwarded, multiplying attempts by `maxRetries=3`.
- **`startPushed` reset bug**: hoisted out of the per-attempt loop so a
  retry's `start` event is suppressed when the first attempt already
  forwarded one. Previously each attempt re-forwarded `start` — protocol
  violation under pi's event-stream contract.
- **Abort-before-iteration hang**: replaced the bare `if (signal?.aborted) break;`
  at the top of the loop with a full `outer.push(aborted)` +
  `outer.end(aborted.error)` + `return`, matching every other exit path.
  Without this the outer stream's async iterator could hang forever on a
  waiter that never resolves.
- **Abort-listener leak** (minor): `backoffMs` now calls
  `signal.removeEventListener("abort", onAbort)` in the natural-resolve path
  via the `onTimer` wrapper. Cumulative listeners across long-lived
  `ctx.signal` objects no longer accumulate.

### Not changed
- Inline `createAssistantMessageEventStream` retained: pi's jiti loader
  aliases `@earendil-works/pi-ai` and `@earendil-works/pi-ai/compat` to
  `_bundledPiAiCompat` (= `compat.js`), which does NOT re-export
  `createAssistantMessageEventStream`. Only `@earendil-works/pi-ai/utils/event-stream`
  has the symbol, and that subpath isn't aliased. Replacing the inline would
  break loading under pi's actual loader. Verified in
  `pi-coding-agent/dist/core/extensions/loader.js` lines 10 and 42.

## [2.0.0] - 2026-07-08

### Changed (BREAKING)
- **Architecture rewritten:** now wraps the openai-completions `streamSimple` for
  NVIDIA models only. v1.0.0's `message_end` text scrubber only cleaned up the
  *display* of failed attempts; it could not raise pi's retry budget, because
  `SettingsManager` exposes no `setMaxRetries` / `setBaseDelayMs` setter to
  extensions. The new wrapper actually performs up to 20 retries at the stream
  layer with exponential backoff.

### Added
- `streamSimple` wrapper registered via `pi.registerProvider("nvidia", { api: "openai-completions", streamSimple })` — captures the original openai-completions streamer via `getApiProvider(...)` *before* registering, gates on `model.provider === "nvidia"`, passes everything else through unmodified.
- Exponential backoff: `BASE_MS * 2^(attempt-1)` capped at `CAP_MS`, with ±`JITTER` (env-tunable).
- 20 retries by default → ~5–6 min wall-clock before giving up.
- Honors `options.signal` during backoff so Esc / Ctrl-C cancels mid-retry.
- Tunable via env without touching settings.json:
  - `NVIDIA_RETRY_MAX` (default 20)
  - `NVIDIA_RETRY_BASE_MS` (default 2000)
  - `NVIDIA_RETRY_CAP_MS` (default 60_000)
  - `NVIDIA_RETRY_JITTER` (default 0.2)
- Startup banner: `[nvidia-rate-limit-retry] loaded — NVIDIA NIM retries: max 20, base 2000ms, cap 60000ms, jitter 20%.`
- Per-retry log line: `[nvidia-rate-limit-retry] <model> — 429 on attempt N/M; K attempt(s) left after backoff.`
- Slim `message_end` handler that only fires when all 20 retries are exhausted — replaces the raw 429-ish error text with `⏳ _NVIDIA rate limit — gave up after 20 retries...` to keep the conversation readable.

### Implementation notes
- `createAssistantMessageEventStream` is inlined (not imported) because
  `@earendil-works/pi-ai/utils/event-stream` is not in pi's jiti alias list and
  subpath imports fail from `~/.pi/agent/extensions/`. The inline copy mirrors
  the upstream ~70-line implementation byte-for-byte.
- `getApiProvider("openai-completions")` is captured at extension-load time, *before*
  our wrapper registers, so the wrapper can call the original streamer for
  passthrough.
- `maxRetries: 0` is forced into the inner openai-completions options so the
  OpenAI SDK's own 429 retry doesn't double-up on top of ours (defensive — pi's
  default is already 0).
- Only retryable when the 429/rate-limit error arrives *before* any content event.
  Mid-stream rate limits forward through unchanged.

## [1.0.0] - 2026-07-08

### Added
- Initial release.
- `message_end` interception for NVIDIA NIM provider rate-limit errors
  (`429`, "rate limit", "too many requests", "throttle", "please wait").
- Replaces ugly error blobs with a compact `⏳ _NVIDIA rate limit — retry N/M_`
  indicator in session history.
- Preserves `stopReason="error"` and `errorMessage` so pi's built-in retry
  (exponential backoff + agent-state cleanup) still works.
- Default `maxRetries` set to `100` so per-error retry budget exceeds
  pi's default 3-attempt cap.
- Startup + per-turn banner logs (`[nvidia-rate-limit-retry] loaded`, `active`)
  so you can confirm via `/reload` + stderr whether the extension is wired up.
- Per-provider detection via `model_select`. Non-NVIDIA providers pass through
  untouched, including OpenRouter routing of NVIDIA-named models.
