// ============================================
// OpenSwarm - OpenRouter CLI Adapter
// Calls the OpenRouter Chat Completions API (OpenAI-compatible schema)
// using a stored sk-or-* key from `openswarm auth login --provider openrouter`.
// ============================================

import type {
  CliAdapter,
  CliRunOptions,
  CliRunResult,
  AdapterCapabilities,
  WorkerResult,
  ReviewResult,
} from './types.js';
import { AuthProfileStore, ensureValidToken } from '../auth/index.js';
import { t } from '../locale/index.js';
import {
  runAgenticLoop,
  loopResultToCliResult,
  type ChatMessage,
  type AgenticLoopOptions,
} from './agenticLoop.js';
import type { ToolDefinition } from './tools.js';

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'openai/gpt-5';
const PROFILE_KEY = 'openrouter:default';

/** OPENROUTER_API env var → immediate API key (no PKCE needed). */
function getEnvApiKey(): string | undefined {
  return process.env.OPENROUTER_API?.trim() || undefined;
}

// Attribution headers — OpenRouter surfaces these in its analytics UI so
// model providers can see traffic originating from OpenSwarm.
const ATTRIBUTION_HEADERS: Record<string, string> = {
  'HTTP-Referer': 'https://github.com/unohee/openswarm',
  'X-Title': 'OpenSwarm',
};

export class OpenRouterCliAdapter implements CliAdapter {
  readonly name = 'openrouter';

  readonly capabilities: AdapterCapabilities = {
    supportsStreaming: false,
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: false,
    supportedSkills: [],
  };

  async isAvailable(): Promise<boolean> {
    if (getEnvApiKey()) return true;
    try {
      const store = new AuthProfileStore();
      return store.getProfile(PROFILE_KEY) !== null;
    } catch {
      return false;
    }
  }

  buildCommand(_options: CliRunOptions): { command: string; args: string[] } {
    // 어댑터가 직접 fetch하므로 spawn 진입점은 미사용.
    return { command: 'echo', args: ['"OpenRouter adapter uses run() — not shell spawn"'] };
  }

  async run(options: CliRunOptions): Promise<CliRunResult> {
    const startTime = Date.now();

    // Prefer OPENROUTER_API env var (e.g. sourced from VEGA .env)
    let apiKey: string | undefined = getEnvApiKey();
    if (!apiKey) {
      const store = new AuthProfileStore();
      try {
        apiKey = await ensureValidToken(store, PROFILE_KEY);
      } catch (err) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `Auth error: ${err instanceof Error ? err.message : String(err)}. Set OPENROUTER_API env var or run: openswarm auth login --provider openrouter`,
          durationMs: Date.now() - startTime,
        };
      }
    }

    const model = options.model ?? DEFAULT_MODEL;
    const callApi = createApiCaller(apiKey, model, {
      disableReasoning: options.disableReasoning,
    });

    const loopOptions: AgenticLoopOptions = {
      systemPrompt: options.systemPrompt,
      prompt: options.prompt,
      cwd: options.cwd ?? process.cwd(),
      model,
      callApi,
      maxTurns: options.maxTurns ?? 20,
      timeoutMs: options.timeoutMs || 300000,
      onLog: options.onLog,
      enableTools: true,
      nudgeMaxOnNoEdit: options.nudgeMaxOnNoEdit,
      protectedFiles: options.protectedFiles,
      bashTimeoutMs: options.bashTimeoutMs,
    };

    try {
      const result = await runAgenticLoop(loopOptions);
      options.onLog?.(
        `[OpenRouter] ${result.apiCallCount} API calls, ${result.toolCallCount} tool uses, ${result.totalTokens} tokens`,
      );
      return loopResultToCliResult(result);
    } catch (err) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `OpenRouter agentic loop failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  parseWorkerOutput(raw: CliRunResult): WorkerResult {
    return extractWorkerResultJson(raw.stdout) ?? extractWorkerFromText(raw.stdout);
  }

  parseReviewerOutput(raw: CliRunResult): ReviewResult {
    return extractReviewerResultJson(raw.stdout) ?? extractReviewerFromText(raw.stdout);
  }
}

// ----- API caller -----

interface OpenRouterChatResponse {
  choices: Array<{
    message: {
      content: string | null;
      role: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ApiCallerOptions {
  /** worker 등 기계적 역할: 추론 토큰 비활성화 (지원 모델 한정) */
  disableReasoning?: boolean;
}

export function createApiCaller(apiKey: string, model: string, opts: ApiCallerOptions = {}) {
  return async (messages: ChatMessage[], tools: ToolDefinition[]) => {
    const body: Record<string, unknown> = {
      model,
      messages: applyPromptCaching(messages, model),
      temperature: 0.2,
      max_tokens: 16384,
    };
    // ZDR(Zero Data Retention) — 데이터를 보존하지 않는 provider로만 라우팅.
    // 단, OpenAI provider는 data_collection:deny 플래그를 거부("Provider returned
    // error")하므로 제외한다. OpenAI는 API 데이터를 학습에 쓰지 않아(정책상) ZDR
    // 강제가 불필요하다. non-OpenAI 모델에만 적용한다.
    if (!/^openai\//i.test(model)) {
      body.provider = { data_collection: 'deny' };
    }
    // 추론 불필요 역할은 reasoning 토큰을 끈다. glm-4.7-flash처럼 non-thinking
    // 모델엔 무영향, 추론형 모델(glm-5 등)을 worker로 바꿔도 토큰 낭비를 막는다.
    // 단, OpenAI 추론 모델(gpt-5 등)은 "Reasoning is mandatory"로 이 플래그를
    // 거부하므로 제외한다 — worker escalate 대상이 gpt-5라 이걸 안 빼면 escalation이
    // 항상 깨진다. OpenAI는 단순 작업엔 추론을 자동 최소화하므로 끌 필요도 없다.
    if (opts.disableReasoning && !/^openai\//i.test(model)) {
      body.reasoning = { enabled: false };
    }
    if (tools.length > 0) {
      body.tools = tools;
    }

    const res = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...ATTRIBUTION_HEADERS,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenRouter API error (${res.status}): ${errText.slice(0, 500)}`);
    }

    return (await res.json()) as OpenRouterChatResponse;
  };
}

/**
 * Prompt caching breakpoint 삽입.
 *
 * OpenAI/Gemini 모델은 OpenRouter가 자동 캐싱하므로 메시지를 건드리지 않는다.
 * Anthropic 모델은 명시적 cache_control breakpoint가 필요하다 — 매 API 호출마다
 * 전체 히스토리가 재전송되는데, 시스템 프롬프트 + 직전 누적 히스토리는 턴마다
 * 거의 동일하므로 그 경계에 ephemeral 캐시 마커를 두면 입력 토큰이 ~90% 할인된다.
 *
 * breakpoint 2개: (1) 시스템 메시지 끝, (2) 마지막 user/tool 메시지 직전 경계.
 * Anthropic은 최대 4개 breakpoint를 허용하므로 2개는 안전하다.
 */
export function applyPromptCaching(messages: ChatMessage[], model: string): unknown[] {
  // OpenAI/Gemini 등은 자동 캐싱 — 변환 불필요 (cache_control을 넣으면 거부될 수 있음)
  if (!/anthropic\/|claude/i.test(model)) {
    return messages;
  }

  // 캐시 마커를 달 인덱스: 시스템 메시지(있으면) + 마지막 직전 메시지.
  // 마지막 메시지(가장 최근 tool 결과)는 매 턴 바뀌므로 캐시하지 않는다.
  const cacheable = new Set<number>();
  if (messages[0]?.role === 'system') cacheable.add(0);
  if (messages.length >= 2) cacheable.add(messages.length - 2);

  return messages.map((m, i) => {
    if (!cacheable.has(i) || typeof m.content !== 'string' || !m.content) {
      return m;
    }
    // string content → content-part 배열로 변환하며 마지막 파트에 cache_control 부착
    return {
      ...m,
      content: [
        { type: 'text', text: m.content, cache_control: { type: 'ephemeral' } },
      ],
    };
  });
}

// ----- Worker/Reviewer output parsing (mirrors gpt.ts) -----

function extractWorkerResultJson(text: string): WorkerResult | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = jsonMatch?.[1] ?? findJsonObject(text, '"success"');
  if (!jsonStr) return null;

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      success: Boolean(parsed.success),
      summary: parsed.summary || t('common.fallback.noSummary'),
      filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      output: text,
      error: parsed.error,
      confidencePercent:
        typeof parsed.confidencePercent === 'number' ? parsed.confidencePercent : undefined,
      haltReason: parsed.haltReason || undefined,
    };
  } catch {
    return null;
  }
}

function extractWorkerFromText(text: string): WorkerResult {
  // Only an explicit failure phrase marks the run as failed (see gpt.ts).
  // git-diff promotion in worker.ts is the real success signal.
  const failed = isExplicitFailure(text);

  return {
    success: !failed,
    summary: extractSummary(text),
    filesChanged: [],
    commands: [],
    output: text,
    error: failed ? extractErrorMessage(text) : undefined,
  };
}

function extractReviewerResultJson(text: string): ReviewResult | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = jsonMatch?.[1] ?? findJsonObject(text, '"decision"');
  if (!jsonStr) return null;

  try {
    const parsed = JSON.parse(jsonStr);
    const decision =
      parsed.decision === 'approve' || parsed.decision === 'reject' ? parsed.decision : 'revise';
    return {
      decision,
      feedback:
        typeof parsed.feedback === 'string' ? parsed.feedback : t('common.fallback.noSummary'),
      issues: Array.isArray(parsed.issues)
        ? parsed.issues.filter((v: unknown): v is string => typeof v === 'string')
        : [],
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((v: unknown): v is string => typeof v === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

function extractReviewerFromText(text: string): ReviewResult {
  const lower = text.toLowerCase();
  const decision = lower.includes('approve')
    ? 'approve'
    : lower.includes('reject')
      ? 'reject'
      : 'revise';
  return {
    decision,
    feedback: extractSummary(text),
    issues: [],
    suggestions: [],
  };
}

function findJsonObject(text: string, marker: string): string | null {
  const idx = text.indexOf(marker);
  if (idx < 0) return null;

  const start = text.lastIndexOf('{', idx);
  if (start < 0) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

// Detect a real failure declaration, not incidental "error"/"fail" prose (see gpt.ts).
function isExplicitFailure(text: string): boolean {
  if (/"success"\s*:\s*false/i.test(text)) return true;
  return /\b(failed to|unable to|could not|couldn['’]t|cannot (?:complete|finish|proceed|continue)|giving up|abort(?:ed|ing))\b/i.test(text);
}

function extractSummary(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 10);
  if (lines.length === 0) return t('common.fallback.noSummary');
  const summary = lines[0].trim();
  return summary.length > 200 ? `${summary.slice(0, 200)}...` : summary;
}

function extractErrorMessage(text: string): string {
  const errorMatch = text.match(/(?:error|exception|failed?):\s*(.+)/i);
  if (errorMatch) return errorMatch[1].slice(0, 200);
  const lines = text.split('\n').filter((l) => /error|fail/i.test(l));
  return lines.length > 0 ? lines[0].slice(0, 200) : 'Unknown error';
}
