// ============================================
// OpenSwarm - Local Model Adapter
// Created: 2026-04-10
// Purpose: Ollama, LMStudio, llama.cpp 등 로컬 OpenAI 호환 서버 지원
// ============================================

import type {
  CliAdapter,
  CliRunOptions,
  CliRunResult,
  AdapterCapabilities,
  WorkerResult,
  ReviewResult,
} from './types.js';
import { t } from '../locale/index.js';
import { runAgenticLoop, loopResultToCliResult, type ChatMessage, type AgenticLoopOptions } from './agenticLoop.js';
import type { ToolDefinition } from './tools.js';

// 로컬 프로바이더 기본 URL 후보 (우선순위 순)
const DEFAULT_ENDPOINTS = [
  'http://localhost:11434',  // Ollama
  'http://localhost:1234',   // LMStudio
  'http://localhost:8080',   // llama.cpp server
];

const DEFAULT_MODEL = 'gemma3:4b';
const HEALTH_CHECK_TIMEOUT_MS = 2000;

export class LocalModelAdapter implements CliAdapter {
  readonly name = 'local';

  readonly capabilities: AdapterCapabilities = {
    supportsStreaming: false,
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: false,
    supportedSkills: [],
  };

  // 활성 서버 URL (isAvailable에서 감지, run에서 사용)
  private activeUrl: string | null = null;
  private configuredUrl: string | null = null;

  /** config.yaml에서 baseUrl을 주입받을 때 사용 */
  setBaseUrl(url: string): void {
    this.configuredUrl = url;
  }

  async isAvailable(): Promise<boolean> {
    const candidates = this.configuredUrl
      ? [this.configuredUrl, ...DEFAULT_ENDPOINTS]
      : DEFAULT_ENDPOINTS;

    for (const url of candidates) {
      try {
        const res = await fetch(`${url}/v1/models`, {
          signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        });
        if (res.ok) {
          this.activeUrl = url;
          return true;
        }
      } catch {
        // 서버 미실행 — 다음 후보로
      }
    }
    return false;
  }

  /** 현재 활성 서버 URL 반환 (디버깅용) */
  getActiveUrl(): string | null {
    return this.activeUrl;
  }

  /** 사용 가능한 모델 목록 조회 */
  async listModels(): Promise<string[]> {
    if (!this.activeUrl) {
      const available = await this.isAvailable();
      if (!available) return [];
    }

    try {
      const res = await fetch(`${this.activeUrl}/v1/models`, {
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!res.ok) return [];

      const data = (await res.json()) as { data?: Array<{ id: string }> };
      return data.data?.map(m => m.id) ?? [];
    } catch {
      return [];
    }
  }

  buildCommand(_options: CliRunOptions): { command: string; args: string[] } {
    return { command: 'echo', args: ['"Local adapter uses run() — not shell spawn"'] };
  }

  async run(options: CliRunOptions): Promise<CliRunResult> {
    const startTime = Date.now();

    // 서버 연결 확인
    if (!this.activeUrl) {
      const available = await this.isAvailable();
      if (!available) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'No local model server found. Start Ollama, LMStudio, or llama.cpp server first.\n' +
            `Checked: ${(this.configuredUrl ? [this.configuredUrl, ...DEFAULT_ENDPOINTS] : DEFAULT_ENDPOINTS).join(', ')}`,
          durationMs: Date.now() - startTime,
        };
      }
    }

    const model = options.model ?? DEFAULT_MODEL;
    const baseUrl = this.activeUrl!;

    // 도구 지원 여부 감지 (모델에 따라 다를 수 있음)
    const supportsTools = await this.checkToolSupport(baseUrl, model);

    // 에이전틱 루프로 실행
    const callApi = this.createApiCaller(baseUrl, model);

    const loopOptions: AgenticLoopOptions = {
      systemPrompt: options.systemPrompt,
      prompt: options.prompt,
      cwd: options.cwd ?? process.cwd(),
      model,
      callApi,
      maxTurns: options.maxTurns ?? 15,
      timeoutMs: options.timeoutMs || 300000,
      onLog: options.onLog,
      enableTools: supportsTools,
    };

    try {
      const result = await runAgenticLoop(loopOptions);
      if (options.onLog) {
        const toolInfo = supportsTools ? `${result.toolCallCount} tool uses` : 'no tools';
        options.onLog(`[Local] ${result.apiCallCount} API calls, ${toolInfo}, ${result.totalTokens} tokens`);
      }
      return loopResultToCliResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.includes('abort') || message.includes('timeout');

      return {
        exitCode: 1,
        stdout: '',
        stderr: isTimeout
          ? `Local model timeout after ${options.timeoutMs ?? 300000}ms (model: ${model}). Local models can be slow — consider increasing timeout.`
          : `Local model request failed: ${message}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * 모델의 tool_use 지원 여부 확인
   * Ollama는 일부 모델만 지원 (gemma3, llama3.1+, mistral 등)
   */
  private async checkToolSupport(baseUrl: string, model: string): Promise<boolean> {
    // 알려진 tool_use 지원 모델 패턴
    const toolCapablePatterns = [
      /^llama3\.[1-9]/,     // llama3.1+
      /^gemma/,             // gemma 계열
      /^mistral/,           // mistral
      /^qwen/,              // qwen
      /^command-r/,         // cohere command-r
      /^firefunction/,      // fireworks
      /^hermes/,            // hermes
    ];

    const modelLower = model.toLowerCase();
    const knownCapable = toolCapablePatterns.some(p => p.test(modelLower));

    if (knownCapable) return true;

    // 알 수 없는 모델 → 1회 probe 시도
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          tools: [{ type: 'function', function: { name: 'test', description: 'test', parameters: { type: 'object', properties: {} } } }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(5000),
      });
      // 200이면 tool 지원, 에러면 미지원
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * 로컬 API 호출 함수 생성 (에이전틱 루프에 주입)
   */
  private createApiCaller(baseUrl: string, model: string) {
    return async (messages: ChatMessage[], tools: ToolDefinition[]) => {
      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: 0.2,
        stream: false,
      };
      if (tools.length > 0) {
        body.tools = tools;
      }

      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');

        if (res.status === 404 || errText.includes('not found')) {
          const models = await this.listModels();
          const modelList = models.length > 0
            ? `Available: ${models.slice(0, 10).join(', ')}`
            : 'No models loaded';
          throw new Error(`Model "${model}" not found on ${baseUrl}. ${modelList}`);
        }

        throw new Error(`Local API error (${res.status}): ${errText.slice(0, 500)}`);
      }

      return (await res.json()) as OpenAICompatResponse;
    };
  }

  parseWorkerOutput(raw: CliRunResult): WorkerResult {
    const text = raw.stdout;
    return extractWorkerResultJson(text) ?? extractWorkerFromText(text);
  }

  parseReviewerOutput(raw: CliRunResult): ReviewResult {
    const text = raw.stdout;
    return extractReviewerResultJson(text) ?? extractReviewerFromText(text);
  }
}

// OpenAI 호환 응답 타입
interface OpenAICompatResponse {
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
  model?: string;
}

// Worker/Reviewer 출력 파싱 (GPT 어댑터와 동일 로직)

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
      confidencePercent: typeof parsed.confidencePercent === 'number'
        ? parsed.confidencePercent : undefined,
      haltReason: parsed.haltReason || undefined,
    };
  } catch {
    return null;
  }
}

function extractWorkerFromText(text: string): WorkerResult {
  const hasError = /error|fail|exception|cannot/i.test(text);
  const hasSuccess = /success|completed|done|finished/i.test(text);

  return {
    success: !hasError || hasSuccess,
    summary: extractSummary(text),
    filesChanged: [],
    commands: [],
    output: text,
    error: hasError ? extractErrorMessage(text) : undefined,
  };
}

function extractReviewerResultJson(text: string): ReviewResult | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = jsonMatch?.[1] ?? findJsonObject(text, '"decision"');
  if (!jsonStr) return null;

  try {
    const parsed = JSON.parse(jsonStr);
    const decision = parsed.decision === 'approve' || parsed.decision === 'reject'
      ? parsed.decision
      : 'revise';
    return {
      decision,
      feedback: typeof parsed.feedback === 'string' ? parsed.feedback : t('common.fallback.noSummary'),
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
  let start = text.lastIndexOf('{', idx);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function extractSummary(text: string): string {
  const lines = text.split('\n').filter(l => l.trim().length > 10);
  if (lines.length === 0) return t('common.fallback.noSummary');
  const summary = lines[0].trim();
  return summary.length > 200 ? `${summary.slice(0, 200)}...` : summary;
}

function extractErrorMessage(text: string): string {
  const errorMatch = text.match(/(?:error|exception|failed?):\s*(.+)/i);
  if (errorMatch) return errorMatch[1].slice(0, 200);
  const lines = text.split('\n').filter(l => /error|fail/i.test(l));
  return lines.length > 0 ? lines[0].slice(0, 200) : 'Unknown error';
}
