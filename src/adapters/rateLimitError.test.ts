import { describe, it, expect } from 'vitest';
import { detectRateLimit, rateLimitFromCodexHeaders, RateLimitError } from './rateLimitError.js';
import { runAgenticLoop } from './agenticLoop.js';

describe('detectRateLimit (INT-1906)', () => {
  it('detects a Codex usage_limit_reached payload and parses resets_at', () => {
    const stdout =
      'API error: Codex responses error (429): {"error":{"type":"usage_limit_reached",' +
      '"message":"The usage limit has been reached","plan_type":"prolite","resets_at":1782343811}}';
    const err = detectRateLimit(stdout, '');
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err?.resetsAt).toBe(1782343811);
    // The label embeds the ISO reset time for operator-facing logs.
    expect(err?.message).toContain('2026'); // 1782343811 → 2026-06-…
  });

  it('detects a rate_limit_error type without resets_at (resetsAt undefined)', () => {
    const err = detectRateLimit('{"type":"rate_limit_error","message":"slow down"}', '');
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err?.resetsAt).toBeUndefined();
  });

  it('detects a 429 paired with rate-limit wording in stderr', () => {
    const err = detectRateLimit('', 'HTTP 429 — rate limit exceeded, retry later');
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it('returns null for ordinary CLI failures (no false positive)', () => {
    expect(detectRateLimit('TypeError: x is not a function', 'exit code 1')).toBeNull();
  });

  it('does not treat a bare "429" without rate-limit wording as a rate limit', () => {
    // e.g. a diff line, a port number, or unrelated numeric output.
    expect(detectRateLimit('listening on port 4290; processed 429 rows', '')).toBeNull();
  });

  it('detects the human-readable Codex usage-limit phrasing (INT-2519)', () => {
    // rateLimitFromCodexHeaders output that reached a CLI/string path.
    expect(detectRateLimit('API error: Codex 100% used of 300min window — resets at 2026-06-30T12:00:00Z', ''))
      .toBeInstanceOf(RateLimitError);
    expect(detectRateLimit('', 'Codex usage limit reached — resets at …')).toBeInstanceOf(RateLimitError);
    expect(detectRateLimit('overageStatus: out_of_credits', '')).toBeInstanceOf(RateLimitError);
  });

  it('does not treat ordinary "used"/"window" wording as a rate limit (no false positive)', () => {
    expect(detectRateLimit('the cache window is 5min; 80% used of the disk', '')).toBeNull();
  });

  it('scans both stdout and stderr (signal split across streams)', () => {
    const err = detectRateLimit('partial output', 'error: usage_limit_reached "resets_at": 1782343811');
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err?.resetsAt).toBe(1782343811);
  });
});

describe('runAgenticLoop rate-limit propagation (INT-1906 blocker)', () => {
  it('re-throws a 429 raised by callApi as a RateLimitError', async () => {
    // The in-process adapters surface a 429 by throwing from callApi. The loop
    // used to swallow it into finalText; it must now propagate so the pipeline
    // pauses instead of returning a normal failed result.
    const callApi = async () => {
      throw new Error('OpenRouter API error (429): {"error":{"message":"Rate limit exceeded"}}');
    };
    await expect(
      runAgenticLoop({ prompt: 'x', cwd: process.cwd(), model: 't', callApi, webTools: false, maxTurns: 2 }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('does NOT re-throw an ordinary (non-rate-limit) API error', async () => {
    const callApi = async () => { throw new Error('500 Internal Server Error'); };
    const res = await runAgenticLoop({ prompt: 'x', cwd: process.cwd(), model: 't', callApi, webTools: false, maxTurns: 2 });
    expect(res.text).toContain('API error');
  });

  it('preserves a TYPED RateLimitError whose human message detectRateLimit would miss (INT-2519)', async () => {
    // codexResponses throws rateLimitFromCodexHeaders → a typed RateLimitError whose
    // message ("Codex 100% used of 300min window — resets at …") lacks the raw tokens
    // detectRateLimit scans for. Before the instanceof guard this was stringified,
    // failed re-detection, and became a 2s empty "success" → 55% HALT → false STUCK.
    const callApi = async () => {
      throw new RateLimitError(1782824950, 'Codex 100% used of 300min window — resets at 2026-06-30T12:00:00.000Z', 100, 300);
    };
    await expect(
      runAgenticLoop({ prompt: 'x', cwd: process.cwd(), model: 't', callApi, webTools: false, maxTurns: 2 }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('propagates an UNTYPED rate limit thrown from the final-answer salvage turn (INT-2519)', async () => {
    // Drive the loop to exhaust maxTurns with no final text (tool calls only), so the
    // final-answer salvage call fires. That call throws an untyped 429 — it must
    // propagate, not be swallowed like an ordinary error.
    let n = 0;
    const callApi = async (_messages: unknown, tools: unknown[]) => {
      if (Array.isArray(tools) && tools.length === 0) {
        // salvage call (tools stripped) → untyped rate-limit error
        throw new Error('HTTP 429 — rate limit exceeded, retry later');
      }
      n += 1;
      return {
        choices: [{
          message: { role: 'assistant', content: null, tool_calls: [
            { id: `c${n}`, type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: `nope${n}.ts` }) } },
          ] },
          finish_reason: 'tool_calls',
        }],
      };
    };
    await expect(
      runAgenticLoop({ prompt: 'x', cwd: process.cwd(), model: 't', callApi: callApi as never, webTools: false, maxTurns: 2 }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('rateLimitFromCodexHeaders (INT-2192)', () => {
  it('extracts reset/used/window from x-codex-* headers', () => {
    const headers = new Headers({
      'x-codex-primary-reset-at': '1782824950',
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-window-minutes': '300',
    });
    const err = rateLimitFromCodexHeaders(headers, '');
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.resetsAt).toBe(1782824950);
    expect(err.usedPercent).toBe(100);
    expect(err.windowMinutes).toBe(300);
    expect(err.message).toContain('100% used');
  });

  it('falls back to the body resets_at when headers are absent', () => {
    const err = rateLimitFromCodexHeaders(new Headers(), '{"error":{"type":"usage_limit_reached","resets_at":1782824949}}');
    expect(err.resetsAt).toBe(1782824949);
    expect(err.usedPercent).toBeUndefined();
  });
});
