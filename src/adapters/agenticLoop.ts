// ============================================
// OpenSwarm - Agentic Tool Loop
// Created: 2026-04-11
// Purpose: Codex/OpenRouter/Local 어댑터용 범용 에이전틱 루프 엔진.
//          OpenAI function calling 포맷 기반.
//          VEGA token_count.py 패턴 이식 — 토큰 기반 히스토리 압축.
// ============================================

import { TOOL_DEFINITIONS, executeToolCalls, createReadCache, type ToolCall, type ToolResult, type ToolDefinition } from './tools.js';
import { WEB_TOOL_DEFINITIONS } from './webTools.js';
import type { CliRunResult } from './types.js';

// ============ 토큰 카운팅 (VEGA token_count.py 이식) ============

// cl100k_base 근사: 한국어 0.78t/char, 영어 0.27t/char
function countTokensApprox(text: string): number {
  if (!text) return 0;
  const hangul = [...text].filter(c => c >= '가' && c <= '힣').length;
  const korRatio = hangul / Math.max(1, text.length);
  const rate = 0.78 * korRatio + 0.27 * (1 - korRatio);
  return Math.ceil(text.length * rate);
}

function countMessageTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : '';
    total += countTokensApprox(content);
    total += 4; // role overhead
    if ('tool_calls' in m && m.tool_calls) {
      for (const tc of m.tool_calls) {
        total += countTokensApprox(tc.function.arguments) + countTokensApprox(tc.function.name) + 8;
      }
    }
  }
  return total;
}

// 도구 결과 길이 제한: 너무 작게 자르면 모델이 파일 절반만 보고 잘못 수정한다.
// 코딩 작업에 맞춰 넉넉히 보존(2500자), 초과 시 앞 1500 + 뒤 700자 유지.
function truncateToolResult(content: string, maxLen = 2500): string {
  if (content.length <= maxLen) return content;
  const head = content.slice(0, 1500);
  const tail = content.slice(-700);
  return `${head}\n...[${content.length - 2200} chars truncated]...\n${tail}`;
}

// ============ 타입 ============

/** OpenAI Chat Completions API 메시지 포맷 */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ApiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ApiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ApiToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** 에이전틱 루프 설정 */
export interface AgenticLoopOptions {
  /** 시스템 프롬프트 */
  systemPrompt?: string;
  /** 사용자 프롬프트 (작업 지시) */
  prompt: string;
  /** 프로젝트 작업 디렉토리 (도구 실행 cwd) */
  cwd: string;
  /** 모델명 */
  model: string;
  /** API 호출 함수 (어댑터별로 주입) */
  callApi: (messages: ChatMessage[], tools: ToolDefinition[]) => Promise<ChatCompletionResponse>;
  /** 최대 도구 사용 턴 수 (기본: 20) */
  maxTurns?: number;
  /** 전체 타임아웃 (ms, 기본: 300000) */
  timeoutMs?: number;
  /** 실시간 로그 콜백 */
  onLog?: (line: string) => void;
  /** 도구 사용 허용 여부 (기본: true) */
  enableTools?: boolean;
  /** 토큰 기반 압축 트리거 임계값 (기본: 24000) */
  compactTokenThreshold?: number;
  /** 이 메시지 수를 넘어야 압축 후보 (VEGA compact_threshold, 기본: 24) */
  compactAfterMessages?: number;
  /** 압축 시 항상 원본 유지할 최근 메시지 수 (VEGA keep_recent, 기본: 8) */
  keepRecentMessages?: number;
  /**
   * 수정이 필수인 작업의 no-edit 종료 가드. 모델이 edit/write 도구를 한 번도 안 쓰고
   * 최종 텍스트로 끝내려 하면 "아직 수정 안 했다, 계속하라"고 N회까지 되민다.
   * 경량 모델(gemini 등)이 탐색만 하고 일찍 결론 내는 패턴 차단 (SWE 하이브리드에서 발견).
   * 기본 0 (비활성) — 수정 없는 작업(진단·분석)도 정상이므로 옵트인.
   */
  nudgeMaxOnNoEdit?: number;
  /** Verification-harness files for which edit/write are refused (see tools.ts ToolExecOptions) */
  protectedFiles?: string[];
  /** bash tool timeout — docker-based tests need minutes (default 30s) */
  bashTimeoutMs?: number;
  /** Expose web_fetch + web_search tools (default true). Disabled e.g. for SWE-bench integrity. */
  webTools?: boolean;
}

/** 루프 실행 결과 */
export interface AgenticLoopResult {
  /** 최종 텍스트 응답 */
  text: string;
  /** 사용한 도구 호출 횟수 */
  toolCallCount: number;
  /** 총 API 호출 횟수 */
  apiCallCount: number;
  /** 총 토큰 사용량 (추적 가능한 경우) */
  totalTokens: number;
  /** 소요 시간 (ms) */
  durationMs: number;
}

// ============ 에이전틱 루프 ============

/**
 * 에이전틱 도구 루프 실행
 *
 * 흐름:
 * 1. 프롬프트로 API 호출 (도구 정의 포함)
 * 2. 응답에 tool_calls가 있으면 → 도구 실행 → 결과를 메시지에 추가 → 2로
 * 3. 응답에 tool_calls가 없으면 (finish_reason = 'stop') → 최종 텍스트 반환
 */
export async function runAgenticLoop(options: AgenticLoopOptions): Promise<AgenticLoopResult> {
  const {
    systemPrompt,
    prompt,
    cwd,
    callApi,
    maxTurns = 20,
    timeoutMs = 300000,
    onLog,
    enableTools = true,
    // 긴 작업(SWE-bench급 실전 repo)에서 압축이 너무 일찍·자주 터지면 모델이 읽은
    // 파일 컨텍스트를 잃고 같은 파일을 반복 read하다 수정에 도달 못 한다(무한 탐색).
    // 현대 모델 컨텍스트(128k+)에 맞춰 임계를 넉넉히, 최근 보존 블록도 늘린다.
    compactTokenThreshold = 60000,
    compactAfterMessages = 60,
    keepRecentMessages = 16,
    nudgeMaxOnNoEdit = 0,
    protectedFiles,
    bashTimeoutMs,
    webTools = true,
  } = options;

  const startTime = Date.now();
  const deadline = startTime + timeoutMs;

  // 메시지 히스토리 구성
  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  // 작업 루트(cwd)를 명시 — 모델이 모르면 '/'나 repo명 같은 절대경로를 추측해
  // 경로 검증(project 밖 접근)에 막힌다. 실전 repo(pylint 등)에서 search_files가
  // 전부 차단되던 결함(SWE-bench에서 발견). 도구는 이 루트 기준 상대경로를 쓰라고 안내.
  const cwdNote =
    `# Working directory\n` +
    `Your project root is: ${cwd}\n` +
    `All file tools operate within this root. Use paths relative to it (e.g. "src/foo.ts" or ".") ` +
    `or absolute paths under this root. Do NOT use "/" or a bare repo name — those are outside the project and will be rejected.\n\n`;
  messages.push({ role: 'user', content: cwdNote + prompt });

  const tools = enableTools
    ? (webTools ? [...TOOL_DEFINITIONS, ...WEB_TOOL_DEFINITIONS] : TOOL_DEFINITIONS)
    : [];
  const readCache = createReadCache(); // 루프 단위 read 캐시 (중복 read 차단)
  let toolCallCount = 0;
  let editToolCount = 0; // edit_file/write_file 호출 수 (no-edit 가드용)
  let nudgesUsed = 0;
  let apiCallCount = 0;
  let totalTokens = 0;
  let finalText = '';

  for (let turn = 0; turn < maxTurns + 1; turn++) {
    // 타임아웃 체크
    if (Date.now() > deadline) {
      onLog?.(`⏰ Agentic loop timeout after ${turn} turns`);
      break;
    }

    // 히스토리 압축 — VEGA compaction.py 패턴 이식.
    // 트리거: 메시지 수가 compactAfterMessages를 넘고 + 토큰이 임계값 초과일 때만.
    // 과거에는 turn>=2부터 매 턴 무조건 압축해 모델이 방금 읽은 파일·작업 맥락을
    // 즉시 잃고 헛돌았다(루프 재발). 이제 정말 길어질 때만 압축하고, 압축해도
    // 최근 keepRecentMessages 블록은 원본 유지한다.
    if (messages.length > compactAfterMessages) {
      const msgTokens = countMessageTokens(messages);
      if (msgTokens > compactTokenThreshold) {
        onLog?.(`📦 Compacting history (${messages.length} msgs, ${msgTokens} tokens > ${compactTokenThreshold})`);
        compactPriorTurns(messages, keepRecentMessages);
      }
    }

    // API 호출
    apiCallCount++;
    onLog?.(`▸ API call #${apiCallCount}${turn > 0 ? ` (tool turn ${turn})` : ''}`);

    let response: ChatCompletionResponse;
    try {
      response = await callApi(messages, tools);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onLog?.(`✖ API error: ${msg}`);
      finalText = `API error: ${msg}`;
      break;
    }

    if (response.usage) {
      totalTokens += response.usage.prompt_tokens + response.usage.completion_tokens;
    }

    const choice = response.choices?.[0];
    if (!choice) {
      onLog?.('✖ Empty response from API');
      finalText = 'Empty API response';
      break;
    }

    const assistantMsg = choice.message;

    // 도구 호출이 없으면 최종 응답
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      // no-edit 종료 가드 — 수정 필수 작업인데 edit/write를 한 번도 안 하고 끝내려 하면
      // 되밀어 계속하게 한다(경량 모델의 조기 결론 패턴 차단).
      if (editToolCount === 0 && nudgesUsed < nudgeMaxOnNoEdit) {
        nudgesUsed++;
        onLog?.(`↩ No-edit guard: model tried to finish without editing (nudge ${nudgesUsed}/${nudgeMaxOnNoEdit})`);
        messages.push({ role: 'assistant', content: assistantMsg.content ?? '' });
        messages.push({
          role: 'user',
          content:
            'You have not modified any files yet, but this task REQUIRES code changes. ' +
            'Do not conclude with analysis only. Apply the fix now with edit_file, then verify. ' +
            'Continue working.',
        });
        continue;
      }
      finalText = assistantMsg.content ?? '';
      break;
    }

    // 어시스턴트 메시지를 히스토리에 추가 (tool_calls 포함)
    messages.push({
      role: 'assistant',
      content: assistantMsg.content,
      tool_calls: assistantMsg.tool_calls,
    });

    // 도구 실행
    const toolCalls: ToolCall[] = assistantMsg.tool_calls.map(tc => ({
      id: tc.id,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

    for (const tc of toolCalls) {
      try {
        const args = JSON.parse(tc.function.arguments);
        const argSummary = summarizeToolArgs(tc.function.name, args);
        onLog?.(`  🔧 ${tc.function.name}${argSummary ? ': ' + argSummary : ''}`);
      } catch {
        onLog?.(`  🔧 ${tc.function.name}`);
      }
    }

    const results: ToolResult[] = await executeToolCalls(toolCalls, cwd, readCache, { protectedFiles, bashTimeoutMs });
    toolCallCount += toolCalls.length;
    // Count only SUCCESSFUL edits — a model whose edit_file calls all fail
    // (old_string not found, protected file) has not modified anything, and
    // counting attempts would let it slip past the no-edit guard.
    editToolCount += toolCalls.filter((tc, i) =>
      (tc.function.name === 'edit_file' || tc.function.name === 'write_file') && !results[i]?.is_error,
    ).length;

    // 도구 결과를 메시지에 추가 (길이 초과 시 자동 truncate)
    for (const result of results) {
      const content = truncateToolResult(result.content);
      messages.push({
        role: 'tool',
        tool_call_id: result.tool_call_id,
        content,
      });
      if (result.is_error) {
        onLog?.(`  ✖ ${content.slice(0, 100)}`);
      }
    }
  }

  // Final answer turn — maxTurns/타임아웃으로 끊겼는데 모델이 최종 텍스트를 못 낸 경우,
  // 도구 없이 마지막 1회 호출로 결론을 강제한다. 이게 없으면 진단·분석형 작업이
  // 끝까지 도구만 호출하다 빈 결과("(no summary)")로 끝난다 — SWE 하이브리드 진단
  // 단계에서 발견된 결함.
  // Note: an empty-string finalText ('') intentionally triggers this too — an
  // empty final answer is worthless, so the one extra call to salvage a real
  // conclusion is the whole point, not an accidental cost (INT-1442 part 3).
  if (!finalText && apiCallCount > 0) {
    onLog?.('▸ Final answer turn (no tools) — loop ended without a final message');
    messages.push({
      role: 'user',
      content:
        'Tool budget exhausted. Based on everything you have learned above, give your final ' +
        'answer NOW as plain text. Do not request any more tools.',
    });
    try {
      const response = await callApi(messages, []);
      if (response.usage) {
        totalTokens += response.usage.prompt_tokens + response.usage.completion_tokens;
      }
      apiCallCount++;
      finalText = response.choices?.[0]?.message?.content ?? '';
    } catch (err) {
      onLog?.(`✖ Final answer turn failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    text: finalText,
    toolCallCount,
    apiCallCount,
    totalTokens,
    durationMs: Date.now() - startTime,
  };
}

/**
 * AgenticLoopResult → CliRunResult 변환
 */
export function loopResultToCliResult(result: AgenticLoopResult): CliRunResult {
  return {
    exitCode: 0,
    stdout: result.text,
    stderr: '',
    durationMs: result.durationMs,
  };
}

// ============ 히스토리 압축 (VEGA compaction.py 패턴 이식) ============

/**
 * 이전 턴(assistant+tool 쌍)을 요약 1줄로 교체.
 * OpenAI API 제약: tool 메시지는 직전 assistant의 tool_call_id와 대응해야 하므로
 * 오래된 assistant+tool 쌍은 텍스트 요약으로 대체해 API 오류를 방지.
 *
 * 보존 기준 (VEGA keep_recent): 최근 keepRecent개 메시지 블록은 항상 원본 유지.
 * tool 메시지는 직전 assistant의 tool_call_id와 짝이 맞아야 하므로, 보존 경계는
 * keepRecent 지점 이후 첫 assistant로 정렬해 짝이 깨진 tool 메시지가 남지 않게 한다.
 * 기존 [Prior turns compacted] 요약이 있으면 새 요약에 합산 후 교체.
 * (테스트를 위해 export — 외부에서 직접 호출할 일은 없음)
 */
export function compactPriorTurns(messages: ChatMessage[], keepRecent = 8): void {
  const headerCount = messages[0]?.role === 'system' ? 2 : 1;

  // 최근 keepRecent개 메시지는 보존 — 압축 상한 인덱스 산출
  let boundary = Math.max(headerCount, messages.length - keepRecent);
  // 보존 경계를 assistant 시작점으로 정렬 (orphan tool 메시지 방지)
  while (boundary < messages.length && messages[boundary].role === 'tool') {
    boundary++;
  }
  if (boundary <= headerCount) return;

  const summaryParts: string[] = [];
  const toRemove: number[] = [];

  for (let i = headerCount; i < boundary; i++) {
    const msg = messages[i];

    if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const calls = msg.tool_calls.map(tc => {
          try {
            const args = JSON.parse(tc.function.arguments);
            const key = args.path || args.pattern || args.command;
            const short = typeof key === 'string' ? key.slice(0, 40) : '';
            return `${tc.function.name}(${short})`;
          } catch {
            return tc.function.name;
          }
        });
        summaryParts.push(calls.join(', '));
      } else {
        // 기존 compacted 요약이면 내용 그대로 흡수, 아니면 어시스턴트 설명 텍스트 보존
        const text = (msg.content ?? '').trim();
        if (text) summaryParts.push(text.startsWith('[Prior') ? text : `note: ${text.slice(0, 200)}`);
      }
      toRemove.push(i);
    } else if (msg.role === 'tool') {
      const ok = !msg.content.startsWith('BLOCKED') && !msg.content.startsWith('Tool error');
      const firstLine = msg.content.split('\n')[0].slice(0, 50);
      summaryParts.push(ok ? '→ok' : `→err: ${firstLine}`);
      toRemove.push(i);
    }
  }

  if (toRemove.length === 0) return;

  const summaryText = `[Prior turns compacted] ${summaryParts.join(' | ')}`;

  for (let i = toRemove.length - 1; i >= 0; i--) {
    messages.splice(toRemove[i], 1);
  }

  messages.splice(headerCount, 0, {
    role: 'assistant',
    content: summaryText,
  });
}

// ============ 헬퍼 ============

function summarizeToolArgs(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read_file':
      return String(args.path ?? '');
    case 'write_file':
      return String(args.path ?? '');
    case 'edit_file':
      return String(args.path ?? '');
    case 'search_files':
      return `"${args.pattern}" in ${args.path}`;
    case 'bash':
      return String(args.command ?? '').slice(0, 80);
    default:
      return '';
  }
}
