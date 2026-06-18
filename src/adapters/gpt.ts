// ============================================
// OpenSwarm - GPT CLI Adapter
// Calls OpenAI Chat Completions API via OAuth token
// Agentic tool loop 지원 (read/write/edit/search/bash)
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
import { runAgenticLoop, loopResultToCliResult, type ChatMessage, type AgenticLoopOptions } from './agenticLoop.js';
import { parseWorkerResult, parseReviewerResult } from './resultParsing.js';
import type { ToolDefinition } from './tools.js';

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o';
const PROFILE_KEY = 'openai-gpt:default';

export class GptCliAdapter implements CliAdapter {
  readonly name = 'gpt';

  readonly capabilities: AdapterCapabilities = {
    supportsStreaming: false,
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: false,
    supportedSkills: [],
  };

  async isAvailable(): Promise<boolean> {
    try {
      const store = new AuthProfileStore();
      const profile = store.getProfile(PROFILE_KEY);
      return profile !== null;
    } catch {
      return false;
    }
  }

  buildCommand(_options: CliRunOptions): { command: string; args: string[] } {
    // GPT 어댑터는 run()을 사용하므로 이 메서드는 호출되지 않음
    return { command: 'echo', args: ['"GPT adapter uses run() — not shell spawn"'] };
  }

  async run(options: CliRunOptions): Promise<CliRunResult> {
    const store = new AuthProfileStore();
    const startTime = Date.now();

    // 1. 유효한 토큰 획득
    let accessToken: string;
    try {
      accessToken = await ensureValidToken(store, PROFILE_KEY);
    } catch (err) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Auth error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startTime,
      };
    }

    const model = options.model ?? DEFAULT_MODEL;

    // 2. 에이전틱 루프로 실행 (도구 사용 가능)
    const callApi = this.createApiCaller(accessToken, store, model);

    const loopOptions: AgenticLoopOptions = {
      systemPrompt: options.systemPrompt,
      prompt: options.prompt,
      cwd: options.cwd ?? process.cwd(),
      model,
      callApi,
      maxTurns: options.maxTurns ?? 15,
      timeoutMs: options.timeoutMs || 300000,
      onLog: options.onLog,
      enableTools: true,
      nudgeMaxOnNoEdit: options.nudgeMaxOnNoEdit,
      protectedFiles: options.protectedFiles,
      bashTimeoutMs: options.bashTimeoutMs,
    };

    try {
      const result = await runAgenticLoop(loopOptions);
      if (options.onLog) {
        options.onLog(`[GPT] ${result.apiCallCount} API calls, ${result.toolCallCount} tool uses, ${result.totalTokens} tokens`);
      }
      return loopResultToCliResult(result);
    } catch (err) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `GPT agentic loop failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * OpenAI API 호출 함수 생성 (에이전틱 루프에 주입)
   * 401 시 토큰 갱신 + 1회 재시도 포함
   */
  private createApiCaller(
    initialToken: string,
    store: AuthProfileStore,
    model: string,
  ) {
    let token = initialToken;
    let retried = false;

    return async (messages: ChatMessage[], tools: ToolDefinition[]) => {
      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: 0.2,
        max_tokens: 16384,
      };
      if (tools.length > 0) {
        body.tools = tools;
      }

      const doCall = async (accessToken: string) => {
        const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');

          // 401 → 토큰 갱신 후 1회 재시도
          if (res.status === 401 && !retried) {
            retried = true;
            token = await refreshAndRetry(store);
            return doCall(token);
          }

          throw new Error(`OpenAI API error (${res.status}): ${errText.slice(0, 500)}`);
        }

        return (await res.json()) as OpenAIChatResponse;
      };

      return doCall(token);
    };
  }

  parseWorkerOutput(raw: CliRunResult): WorkerResult {
    return parseWorkerResult(raw.stdout);
  }

  parseReviewerOutput(raw: CliRunResult): ReviewResult {
    return parseReviewerResult(raw.stdout);
  }

}

// OpenAI API response type

interface OpenAIChatResponse {
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

async function refreshAndRetry(store: AuthProfileStore): Promise<string> {
  const profile = store.getProfile(PROFILE_KEY);
  if (!profile) {
    throw new Error('No auth profile found');
  }
  // 강제 갱신 (expires를 0으로 설정)
  profile.expires = 0;
  store.setProfile(PROFILE_KEY, profile);
  return ensureValidToken(store, PROFILE_KEY);
}

// Worker/Reviewer output parsing lives in ./resultParsing.ts (shared with the
// local, openrouter, and codex adapters — INT-1441).
