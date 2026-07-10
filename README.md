# pi-nvidia-rate-limit-retry

> **Deprecated:** This standalone extension is superseded by
> [pi-nvidia-nim](https://github.com/Diegovisk/pi-nvidia-nim), which bundles the same
> rate-limit retry logic plus the full NVIDIA NIM provider, router, and thinking handlers.
> Do **not** install both — it causes double-wrapping. This repo remains public for
> reference and for users who only need retry without the full NIM fork.

A [pi](https://github.com/eartheater/pi-coding-agent) extension that transparently retries
NVIDIA NIM rate-limit errors at the stream layer.

NVIDIA NIM models are free but aggressively rate-limited (HTTP 429). Calls that fail on the
first attempt almost always succeed on retry — but pi's built-in retry budget (3 attempts)
gives up long before the rate-limit window clears. This extension sits at the openai-completions
stream layer and drives its own retry loop so pi's budget never gets in the way.

## What this does

When you send a prompt that hits a NVIDIA NIM 429, this extension:

1. **Holds the stream.** The wrapper takes over `streamSimple` for openai-completions
   models whose `provider === "nvidia"`. Other providers (openai/deepseek/groq via
   OpenAI-compatible APIs) are passed through to the original streamer.
2. **Retries with exponential backoff** — 2s, 4s, 8s, 16s, 32s, capped at 60s, with ±20%
   jitter. Up to **20 attempts** by default (~5–6 min wall-clock) before giving up.
3. **Only retries rate-limit errors that arrive before any content** — if the model
   already started streaming, we don't replay a partial response.
4. **Doesn't touch context overflow, auth errors, or non-NVIDIA providers.** Anything
   other than 429/rate-limit falls through unchanged.
5. **Keeps your session history clean.** Successful retries look identical to a
   successful first try — no `⏳ retry N/100` clutter. Only the final "we gave up"
   surface is rewritten to a clean line.

## Configure (env vars, no settings.json edit needed)

| Variable | Default | Meaning |
|---|---|---|
| `NVIDIA_RETRY_MAX` | 20 | Max attempts per burst before giving up |
| `NVIDIA_RETRY_BASE_MS` | 2000 | Base backoff in milliseconds |
| `NVIDIA_RETRY_CAP_MS` | 60000 | Maximum single-delay in milliseconds |
| `NVIDIA_RETRY_JITTER` | 0.2 | Jitter fraction (0.0–1.0) applied to each delay |

Response-time table with default settings:

| Attempt |  Delay   | Cumulative |
|---------|----------|------------|
| 1       |  2 000ms |    2s      |
| 2       |  4 000ms |    6s      |
| 3       |  8 000ms |   14s      |
| 4       | 16 000ms |   30s      |
| 5       | 32 000ms |   62s      |
| 6 – N   | 60 000ms |  capped    |
| 20      | 60 000ms |  ~6 min    |

In practice, most NVIDIA rate limits clear by attempt 2–3. The 20-attempt ceiling exists
for hardening against long cooldown windows.

## Install

### Option 1 — install via git URL

```bash
pi install git:github.com/Diegovisk/pi-nvidia-rate-limit-retry@v2
```

The `@v2` tag resolves to whichever v2.* release is latest (currently `v2.0.2`). To pin a
specific release, use `@v2.0.2`.

### Option 2 — drop the file directly

```bash
cp extensions/nvidia-rate-limit-retry.ts ~/.pi/agent/extensions/
```

Then `/reload`.

## Verify it's working

After `/reload`:

1. Watch stderr for the startup line:
   ```
   [nvidia-rate-limit-retry] loaded — NVIDIA NIM retries: max 20, base 2000ms, cap 60000ms, jitter 20%.
   ```
2. Send a prompt to an NVIDIA model. If a 429 hits, you'll see one log line per retry attempt:
   ```
   [nvidia-rate-limit-retry] minimaxai/minimax-m3 — 429 on attempt 1/20; 19 attempt(s) left after backoff.
   ```
3. After exhausting all attempts (or hitting any non-429 error after content streamed), the
   assistant message ends with a clean caption:
   ```
   ⏳ _NVIDIA rate limit — gave up after 20 retries on the same request. Try again in a minute or switch models._
   ```

If you don't see the startup banner after `/reload`, the extension isn't loaded — see
[Troubleshooting](#troubleshooting).

## How it works (architecture)

### Why v1.0.0's `message_end` patch could not increase the retry budget

Pi's built-in retry budget is read once from `SettingsManager.getRetrySettings()` inside
`agent-session.js#_prepareRetry`. The SettingsManager exposes only `setRetryEnabled(boolean)`
to extensions — there's no public setter for `maxRetries` or `baseDelayMs`. That's why
v1.0.0 (a `message_end` text scrubber) could not actually increase the retry count; it
only cleaned up the post-failure display.

### v2.0.x — stream-layer wrapper

The wrapper registers a `streamSimple` for the `nvidia` provider via `pi.registerProvider`,
keyed by `api: "openai-completions"`. Because the api-registry is keyed by API (not by
provider), this intercepts every openai-completions model — but inside the wrapper we
gate on `model.provider === "nvidia"` and call out to a captured reference to the original
streamer (via `getApiProvider("openai-completions")` taken *before* our wrapper registers).
Non-NVIDIA providers keep identical behaviour.

Each connection attempt:

1. Call the original openai-completions streamer with `maxRetries: 0` so the OpenAI SDK
   does its own retry on top of ours.
2. Forward events to a fresh outer `AssistantMessageEventStream`.
3. Hold the terminal `done`/`error` event without forwarding.
4. If the terminal is a 429-style error and **nothing** was forwarded: back off and retry.
5. If the terminal is `done`: forward it, end the stream. Done.
6. If the terminal is any other error (rate-limit after content, context overflow,
   auth, aborted, …): forward it verbatim. No replay.

### Why we own the retry budget (the `EXHAUSTION_MARKER` mechanism)

The risk: when our wrapper finally gives up at `MAX_ATTEMPTS`, we emit a terminal `error`
event. Pi's `_isRetryableAssistantError` checks the errorMessage against a regex set
covering `429`, `rate limit`, `too many requests`, `overloaded`, `5xx`, `service.?
unavailable`, `server.?error`, `internal.?error`, network/fetch failures, etc. If our
emitted text matches any of those, pi's own retry path runs `_prepareRetry()` again,
which calls `streamSimple` again, which runs our wrapper again — multiply attempts by
`retry.maxRetries=3` and you get up to 60 attempts on a single user turn, not 20.

v2.0.1 introduced a sentinel errorMessage (`"NVIDIA NIM returned N consecutive failures,
retry budget spent, no further attempts will help right now"`) verbatim regex-verified to
NOT match any of those patterns. That fixed the stacking problem.

v2.0.2 makes the rewrite robust via a stable marker constant:

```ts
const EXHAUSTION_MARKER = "nvidia-nim-retry-budget-exhausted";
```

The terminal `errorMessage` is emitted as
`${EXHAUSTION_MARKER}: ${MAX_ATTEMPTS} consecutive failures, …`. The `message_end` rewrite
handler filters with `msg.errorMessage?.includes(EXHAUSTION_MARKER)` instead of
`isRateLimitErrorMessage(...)`. This decouples the rewrite from the human-readable copy —
the rewrite fires exactly on exhaustion and never on a mid-stream 429 (which is forwarded
verbatim without the marker).

The marker string was chosen via Node-side regex tests against the patterns in
`@earendil-works/pi-ai/dist/utils/retry.js` to ensure it matches neither the retryable
nor the non-retryable provider-limit patterns. The token contains no digits-other-than-7,
no shared substrings with the rate-limit set, and no JSON class names that the
non-retryable set catches.

### Why the event-stream class is inlined

The `AssistantMessageEventStream` ship with `@earendil-works/pi-ai` lives at
`utils/event-stream.js`. Both bare and `/compat` specifiers (`@earendil-works/pi-ai` and
`@earendil-works/pi-ai/compat`) **are** in pi's jiti alias map — they're both routed to
`_bundledPiAiCompat` (which is `compat.js`). And `compat.js` does **not** re-export from
`utils/event-stream.js`. The subpath `@earendil-works/pi-ai/utils/event-stream` is also
not in the alias map. So an extension can't import `createAssistantMessageEventStream`
from this package under pi's loader via any path.

Verified against `pi-coding-agent/dist/core/extensions/loader.js` lines 10 and 42-43.
Source of pi's own comment on the alias: `"Extensions resolve the pi-ai root to the
compat entrypoint (a strict superset of the core entrypoint)"` (loader.js line 38).

Single-file extensions in `~/.pi/agent/extensions/` therefore can't reach the upstream
class without bundling their own `node_modules`. We chose to mirror the ~70-line
implementation byte-for-byte instead. If pi upstream ever changes the event-stream
queue/waiter semantics, this file will need its inline copy updated — a tradeoff
documented here for future maintainers.

### What this still does NOT do

- **Does not bypass upstream rate limits** — only retries during the cooldown window.
- **Does not retry non-rate-limit errors** — auth, context overflow, etc. propagate
  verbatim.
- **Does not persist per-project state** — retry budget is in-memory, fresh per process.
- **Does not require editing `~/.pi/config/settings.json`** — the whole point of replacing
  pi's retry path is that we don't need its budget raised. (This is the v2.x architectural
  shift from v1.x: we own the budget.)

> Note: as of v2.0.3 the wrapper, the rewrite handler, and the EXHAUSTION_MARKER match
> all recognize **OpenRouter-routed NVIDIA models** as well (matched when
> `model.id` starts with `nvidia/`). This used to be excluded; the exclusion
> note above is intentionally left as historical context only.

## Troubleshooting

**No `[loaded]` banner after `/reload`.**

- Check the file lives in a discovered path:
  `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local).
- Look for TypeScript parse errors on stderr.
- Confirm pi's jiti loader can see the package source —
  `cat ~/.pi/agent/settings.json` should list either a single-file
  `~/.pi/agent/extensions/nvidia-rate-limit-retry.ts` OR
  `npm:pi-nvidia-rate-limit-retry` (depending on how you installed).

**Banner shows but the friendly `⏳ gave up after N retries…` caption never appears.**

- Either you never actually hit a 429-after-exhaustion (congratulations — your prompts are
  retrying entirely at the stream layer), or the rewrite handler is bailing for a
  different reason. Read the input transcript's stderr for our per-attempt log:
  ```
  [nvidia-rate-limit-retry] minimaxai/minimax-m3 — 429 on attempt 20/20; giving up.
  ```
  If you see "giving up" but no `⏳` caption, the marker `EXHAUSTION_MARKER` isn't
  reaching `message_end`. This can happen if the upstream provider shape changes
  `provider` off the message envelope — open an issue.

**All openai-completions streams broke.**

The wrapper overrides the openai-completions registration for everyone, then gates by
`model.provider === "nvidia"` so non-NVIDIA calls fall through. If something regresses
there, all OpenAI-compatible providers (openai/deepseek/groq/etc.) would be affected.
Likely cause is a missing or wrong `getApiProvider` capture — open an issue with the
failure mode.

**Give up happens too quickly / too slowly.**

Set `NVIDIA_RETRY_MAX` / `NVIDIA_RETRY_BASE_MS` / `NVIDIA_RETRY_CAP_MS` env vars. They
re-read on every fresh connection attempt.

**Retries fire but conversation history shows raw "429" text anyway.**

You have an older v1.x file still installed somewhere. Check `~/.pi/agent/extensions/`
for stale copies and remove them. The v2.x behaviour is observable in clean session logs
as absence of "429" lines.

## Compatibility

Tested against `@earendil-works/pi-coding-agent` 0.80+. Imports from
`@earendil-works/pi-ai/compat` (pi's jiti-aliased path) and `@earendil-works/pi-coding-agent`.
No other runtime dependencies.

## Testing

The repo includes a three-tier harness: unit tests, deterministic mock E2E (no network), and live NVIDIA abuse E2E.

### Run everything

```powershell
.\scripts\run-rate-limit-test.ps1
```

Or via npm (uses pi's bundled Node when `PI_NODE` is unset):

```bash
npm run test:all
```

The harness launches pi in print mode (`-p`) with `--mode json` avoided on Windows where it can block on stdin. Each run saves stdout/stderr under `tests/logs/<timestamp>/`.

### Individual tiers

| Command | What it does |
|---------|----------------|
| `npm run test` | Unit tests only (`extensions/lib/retry-helpers.mjs`) |
| `npm run test:mock` | Mock 429 injection via `NVIDIA_RETRY_TEST_INJECT_429` |
| `npm run test:live` | Real NVIDIA API: smoke, 5 parallel prompts, 8 serial RPC prompts |
| `.\scripts\run-rate-limit-test.ps1 -MockOnly` | Mock tier only |
| `.\scripts\run-rate-limit-test.ps1 -LiveOnly` | Live tier only |
| `.\scripts\run-rate-limit-test.ps1 -UnitOnly` | Unit tier only |

### Mock injection (deterministic)

When `NVIDIA_RETRY_TEST_INJECT_429=N` is set, the extension returns synthetic 429 errors for the first N attempts per request, then succeeds without calling the network:

```bash
NVIDIA_RETRY_TEST_INJECT_429=3 NVIDIA_RETRY_MAX=5 NVIDIA_RETRY_BASE_MS=50 pi ...
```

### Reading results

Open `tests/logs/<latest>/summary.json`:

- `ok: true` — all hard checks passed
- `warned` — soft checks (e.g. no live 429 observed off-peak) that did not fail the run
- Each check has `name`, `pass`, `message`, and `details`

Per-scenario stdout/stderr are saved alongside (`*.stdout.log`, `*.stderr.log`). Look for `[nvidia-rate-limit-retry] loaded` in stderr to confirm the extension is active.

### Environment overrides

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_BIN` | `%USERPROFILE%\AppData\Local\pi-node\current\pi.cmd` | pi executable |
| `PI_NODE` | pi's bundled `node.exe` | Node for running harness scripts |
| `PI_TEST_PROVIDER` | `nvidia` | Provider for E2E runs |
| `PI_TEST_MODEL` | `minimaxai/minimax-m3` | Model for E2E runs |
| `PI_TEST_LOG_DIR` | auto timestamp under `tests/logs/` | Override log output directory |

## License

MIT — see [LICENSE](./LICENSE).
