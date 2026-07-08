# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
