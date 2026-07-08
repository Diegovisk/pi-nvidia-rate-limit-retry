# pi-nvidia-rate-limit-retry

A [pi](https://github.com/eartheater/pi-coding-agent) extension that transparently retries
NVIDIA NIM rate-limit errors at the stream layer.

NVIDIA NIM models are free but aggressively rate-limited (HTTP 429). Calls that fail on the
first attempt almost always succeed on retry — but pi's built-in retry budget (3 attempts)
gives up long before the rate-limit window clears.

## What this does

When you send a prompt that hits a NVIDIA NIM 429, this extension:

1. **Holds the stream.** The wrapper captures `assistantMessageEventStream` from the openai-completions layer before any token reaches pi.
2. **Retries with exponential backoff** — 2s, 4s, 8s, 16s, 32s, capped at 60s, with ±20% jitter. Up to **20 attempts** by default (~5–6 min wall-clock) before giving up.
3. **Only retries rate-limit errors that arrive before any content** — if the model already started streaming, we don't replay a partial response.
4. **Doesn't touch context overflow, auth errors, or non-NVIDIA providers.** Anything other than 429/rate-limit falls through unchanged. Other providers (openai/deepseek/groq via OpenAI-compatible APIs) are also untouched thanks to `model.provider === "nvidia"` gating.
5. **Keeps your session history clean.** Successful retries look identical to a successful first try — no `⏳ retry N/100` clutter in the conversation. Only the final "we gave up" surface is rewritten.

## Configure (env vars, no settings.json edit needed)

| Variable | Default | Meaning |
|---|---|---|
| `NVIDIA_RETRY_MAX` | 20 | Max attempts per burst before giving up |
| `NVIDIA_RETRY_BASE_MS` | 2000 | Base backoff in milliseconds |
| `NVIDIA_RETRY_CAP_MS` | 60000 | Maximum single-delay in milliseconds |
| `NVIDIA_RETRY_JITTER` | 0.2 | Jitter fraction (0.0–1.0) applied to each delay |

## Install

### Option 1 — install via git URL

```bash
pi install git:github.com/Diegovisk/pi-nvidia-rate-limit-retry@v2
```

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
   [nvidia-rate-limit-retry] qwen/qwen3.5-122b-a10b — 429 on attempt 1/20; 19 attempt(s) left after backoff.
   ```
3. The conversation itself stays clean — no `⏳ retry` markers unless we ultimately give up.

If you don't see the startup banner after `/reload`, the extension isn't loaded (see Troubleshooting).

## How it works (architecture)

### Why this couldn't be a `message_end` patch

Pi's built-in retry budget is read once from `SettingsManager.getRetrySettings()` inside
`agent-session.js#_prepareRetry`. The SettingsManager exposes only `setRetryEnabled(boolean)`
to extensions — there's no public setter for `maxRetries` or `baseDelayMs`. That's why
v1.0.0 (a `message_end` text scrubber) couldn't actually increase the retry count; it
only cleaned up the post-failure display.

### v2.0.0 — stream-layer wrapper

The wrapper registers a `streamSimple` for the `nvidia` provider via `pi.registerProvider`,
keyed by `api: "openai-completions"`. The api-registry is keyed by API (not by provider),
so this intercepts every openai-completions model — but inside the wrapper we gate on
`model.provider === "nvidia"` and pass everything else through to the original streamer
(captured via `getApiProvider("openai-completions")` before our wrapper registers).

Each connection attempt:

1. Calls the original openai-completions streamer with `maxRetries: 0` (so the OpenAI SDK's sub-retry doesn't double-retry on top of ours).
2. Forwards events to a fresh outer `AssistantMessageEventStream`.
3. Holds the terminal `done`/`error` event without forwarding yet.
4. If the terminal is a 429-style error and nothing was forwarded: back off and retry.
5. If the terminal is `done`: forward it, end the stream. Done.
6. If the terminal is any other error: forward it verbatim. No replay.

The outer `AssistantMessageEventStream` is inlined because `@earendil-works/pi-ai/utils/event-stream`
isn't in pi's jiti alias list, so extensions can't subpath-import it directly. The inline
copy mirrors the upstream ~70-line implementation byte-for-byte.

## What this still does NOT do

- **Does not bypass upstream rate limits** — only retries during the cooldown window.
- **Does not match NVIDIA models served through OpenRouter** (provider field is `openrouter`).
  Open a follow-up if you want that.
- **Does not retry non-rate-limit errors** — auth, context overflow, etc. propagate verbatim.
- **Does not persist per-project state** — retry budget is in-memory, fresh per process.

## Troubleshooting

**No `[loaded]` banner after `/reload`.**

- Check the file lives in a discovered path:
  `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local).
- Look for TypeScript parse errors on stderr.

**All openai-completions streams broke.**

The wrapper gates by `model.provider === "nvidia"`, but it overrides the openai-completions
registration for everyone. If something regresses there, all OpenAI-compatible providers
(openai/deepseek/groq/etc.) would be affected. Likely cause is a missing or wrong
`getApiProvider` capture — open an issue with the failure mode.

**Give up happens too quickly / too slowly.**

Set `NVIDIA_RETRY_MAX` / `NVIDIA_RETRY_BASE_MS` / `NVIDIA_RETRY_CAP_MS` env vars.

## Compatibility

Tested against `@earendil-works/pi-coding-agent` 0.80+. Imports from
`@earendil-works/pi-ai/compat` (which is pi's jiti-aliased path for the same `compat`
entry point).

## License

MIT — see [LICENSE](./LICENSE).
