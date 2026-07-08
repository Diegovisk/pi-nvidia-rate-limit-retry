# pi-nvidia-rate-limit-retry

A [pi](https://github.com/eartheater/pi-coding-agent) extension that transparently retries
NVIDIA NIM rate-limit errors and keeps them out of your session history.

NVIDIA NIM models are free but aggressively rate-limited (HTTP 429). Calls that fail on the
first attempt almost always succeed on retry, but pi's default retry budget (3 attempts) is
too low, and the raw error blobs clutter your context.

This extension:

- **Intercepts** assistant error messages from the `nvidia` provider that match `429`,
  `rate limit`, `too many requests`, `throttle`, or `please wait`.
- **Replaces** the ugly error text with a compact indicator so your session file stays clean:
  `⏳ _NVIDIA rate limit — retry 3/100_`
- **Preserves** `stopReason="error"` and `errorMessage` so pi's built-in retry system
  (exponential backoff + agent-state cleanup) still runs.
- **Loosens** the retry budget by counting retries independently — up to **100 attempts**
  per error burst before giving up.

---

## Install

### Option 1 — install via git URL (recommended)

```bash
pi install git:github.com/<owner>/pi-nvidia-rate-limit-retry@v1
```

Replace `<owner>` with the GitHub user/org that hosts this repo.

### Option 2 — drop the file directly

Copy `extensions/nvidia-rate-limit-retry.ts` to one of pi's auto-discovered extension
locations, then `/reload`:

```bash
# Global (every project)
cp extensions/nvidia-rate-limit-retry.ts ~/.pi/agent/extensions/

# Project-local (this repo only)
mkdir -p .pi/extensions && cp extensions/nvidia-rate-limit-retry.ts .pi/extensions/
```

Then in pi:

```
/reload
```

---

## Verify it's working

After install (or after `/reload`):

1. Select any NVIDIA NIM model (`/model`, pick an `nvidia/...` entry).
2. Send a prompt.
3. Watch your pi terminal stderr / logs. You should see **exactly one line per process**:
   ```
   [nvidia-rate-limit-retry] loaded — active for NVIDIA NIM models (max 100 retries, exponential backoff up to 60s).
   ```
4. And **one line per turn** while the NVIDIA provider is active:
   ```
   [nvidia-rate-limit-retry] active — provider="nvidia" awaiting 429/rate-limit errors.
   ```
5. When an actual rate limit fires, you'll see a compact line in the conversation instead
   of the full error blob:
   ```
   ⏳ _NVIDIA rate limit — retry 3/100_
   ```

If you don't see the startup banner after `/reload`, the extension isn't loaded — see
[Troubleshooting](#troubleshooting).

---

## Recommended settings

The extension changes the **per-burst** retry budget it tracks itself, but pi's **built-in**
retry settings still gate how many *real* attempts are made. Default is 3 attempts with a
2s base delay. For NVIDIA NIM, bump it:

`~/.pi/config/settings.json`:

```jsonc
{
  "retry": {
    "enabled": true,
    "maxRetries": 10,     // default is 3
    "baseDelayMs": 2000   // already the default; example shown for clarity
  }
}
```

Response-time table (default 2s base delay, capped at 60s per attempt):

| Attempt |  Delay   | Cumulative |
|---------|----------|------------|
| 1       |  2 000ms |    2s      |
| 2       |  4 000ms |    6s      |
| 3       |  8 000ms |   14s      |
| 4       | 16 000ms |   30s      |
| 5       | 32 000ms |   62s      |
| 6 – 100 | 60 000ms |  capped    |
| 100     | 60 000ms |  ~100 min  |

Practically, most NVIDIA rate limits clear in the first 2–3 attempts. The 100-attempt ceiling
is paranoia for load spikes.

---

## How it works

1. `model_select` — when the active model switches, set a flag if its `provider` matches
   `/nvidia|nim|nvapi/i`.
2. `after_provider_response` — log HTTP 429s for debugging.
3. `message_end` — for assistant messages with `stopReason="error"` where `errorMessage`
   matches a rate-limit pattern AND the provider is NVIDIA:
   - increment an internal counter,
   - return a replacement message with the visible text changed to a small indicator,
   - **leave `stopReason="error"` and `errorMessage` intact** so pi's retry path fires.
4. `message_end` (success case) — reset the internal counter so the next burst gets full budget.

The replacement happens before pi's `sessionManager.appendMessage()`, so the cleaned text is
what lands in the JSONL session file.

---

## What this does NOT do

- Does not bypass rate limits — only retries when the upstream API is in cooldown.
- Does not match NVIDIA models served through **OpenRouter** (provider field is `openrouter`,
  not `nvidia`). If you want that too, open an issue and we'll broaden the matcher.
- Does not retry non-rate-limit errors (auth, context overflow, etc.) — those have their own
  semantics in pi.
- Does not persist per-project state. Retry budget resets per session.

---

## Troubleshooting

**No `[loaded]` banner after `/reload`.**

- Check the extension file is in a discovered path:
  `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local).
- Run `pi --list-extensions` to confirm it's registered.
- Check `pi` stderr for TypeScript compile errors (jiti parses the `.ts` directly).

**`[loaded]` shows but `[active]` doesn't.**

- You selected a non-NVIDIA model. The extension intentionally stays quiet for other providers.

**You still see full 429 error blobs in the conversation.**

- The error isn't matching the regex. Look at the raw `errorMessage` in your session log
  (`.pi/sessions/*.jsonl`) and open an issue with the exact text — we'll broaden the
  pattern.

**Retries give up after 3 attempts.**

- Bump `retry.maxRetries` in `~/.pi/config/settings.json`. pi's built-in retry is what
  actually performs the request retry; this extension's 100-counter just controls how long
  we'll keep scrubbing errors from your session history.

---

## Compatibility

Tested against `@earendil-works/pi-coding-agent` ≥ 0.80 (uses `model_select`, `message_end`,
`after_provider_response`, `session_start`, and `agent_start` events).

---

## License

MIT — see [LICENSE](./LICENSE).
