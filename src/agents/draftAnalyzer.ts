// ============================================
// OpenSwarm - Draft Analyzer
// Created: 2026-04-11
// Purpose: drafter 모델 기반 사전 분석 — 이슈 의도 파악 + 코드베이스 상태 수집
//          Planner/Worker에 enriched context를 제공하여 첫 시도 정확도 향상
// ============================================

import { getAdapter, getDefaultAdapterName, spawnCli } from '../adapters/index.js';
import { analyzeIssue } from '../knowledge/index.js';
import { getRegistryStore } from '../registry/sqliteStore.js';
import type { ImpactAnalysis } from '../knowledge/types.js';
import type { AdapterName } from '../adapters/types.js';

// ============ drafter 모델 / 게이트 정책 ============

/**
 * Explicit per-provider drafter model (INT-1915). The draft brief gates every
 * downstream stage, so the drafter must use a capable model — not whatever the
 * adapter CLI happens to default to (claude -p otherwise leans entirely on CLI
 * config; OpenRouter otherwise falls back to a generic default). Adapters not
 * listed fall through to `adapter.getDefaultModel()`. Keep this as the single
 * point of truth rather than a hard-coded catalog (which would rot on provider
 * updates) — it is one constant per provider, easy to bump.
 */
const DRAFT_MODELS: Partial<Record<AdapterName, string>> = {
  // Capable but cost-aware model for the brief (INT-1915): the drafter runs on
  // EVERY task, and claude -p loads the full personal env (~39k tokens/call), so
  // opus on every brief was too costly. sonnet keeps the brief faithful at a
  // fraction of the cost; bump back to 'opus' if brief quality regresses.
  claude: 'sonnet',
  // Strong file:line-accurate non-frontier model (see planner choice, INT-1607).
  openrouter: 'qwen/qwen3-235b-a22b-2507',
};

/** Minimum execution-grounded criteria a sufficient brief must carry. */
const DRAFT_MIN_CRITERIA = 1;
/** Max attempts to coax a sufficient draft out of one adapter before falling back. */
const DRAFT_MAX_ATTEMPTS = 2;

/** Appended on retry when the first brief was too thin (INT-1917 hard gate). */
const DRAFT_RETRY_NUDGE = `

## ⚠️ Your previous brief was insufficient
It was missing a concrete intent, real relevant files, or execution-grounded
completionCriteria. Read the actual code (read_file / search_files) and produce a
FAITHFUL brief: a specific intent, at least one real file path, and 2–5 completion
criteria that are verifiable by evidence (call sites, produced artifacts, before/
after numbers) — never satisfiable by scaffolding alone.`;

/**
 * drafter hard gate (INT-1917): is the brief faithful enough to hand to a worker?
 * A lazy draft (no intent, no files, no criteria) must NOT pass silently.
 */
export function isDraftSufficient(d: Partial<DraftAnalysis>): boolean {
  const intent = (d.intentSummary ?? '').trim();
  const approach = (d.suggestedApproach ?? '').trim();
  const files = d.relevantFiles ?? [];
  const criteria = d.completionCriteria ?? [];
  return (
    intent.length >= 12 &&
    approach.length >= 12 &&
    files.length >= 1 &&
    criteria.length >= DRAFT_MIN_CRITERIA
  );
}

// ============ 타입 ============

/** Draft 분석 결과 — Planner와 Worker 모두에 주입 */
export interface DraftAnalysis {
  /**
   * 작업 유형 분류. Few-shot, not a closed set (INT-1916): the model may return a
   * more specific label than the common bugfix/feature/refactor/docs/test/config.
   */
  taskType: string;
  /** drafter가 요약한 핵심 의도 (1-2문장) */
  intentSummary: string;
  /** drafter가 식별한 관련 파일/모듈 목록 */
  relevantFiles: string[];
  /** drafter가 제안한 접근 방식 (1-3문장) */
  suggestedApproach: string;
  /**
   * Execution-grounded definition of done (INT-1914). Each item must be
   * verifiable with concrete evidence — e.g. "select_model_for_load is called
   * from streaming.py (call site)", "bench.json artifact is produced", "before/
   * after turn counts reported" — NOT "function is defined". The worker is held
   * to these and the reviewer hard-gates on evidence for each.
   */
  completionCriteria: string[];
  /**
   * drafter hard gate (INT-1917): false when the draft failed to produce a
   * faithful brief (empty intent / no relevant files / no criteria) even after
   * retries. Downstream the worker is told the brief is incomplete and must
   * investigate thoroughly itself.
   */
  sufficient: boolean;
  /** Knowledge Graph impact analysis */
  impactAnalysis?: ImpactAnalysis;
  /** Code Registry 요약 (영향 파일별 상태) */
  registrySnapshot: RegistryBrief[];
  /** 프로젝트 전체 통계 요약 */
  projectStats?: string;
  /** 소요 시간 (ms) */
  durationMs: number;
}

export interface RegistryBrief {
  filePath: string;
  summary: string;
  highlights: string[];
  entities?: Array<{
    kind: string;
    name: string;
    signature?: string;
    status: string;
    hasTests: boolean;
  }>;
}

export interface DraftAnalyzerOptions {
  taskTitle: string;
  taskDescription: string;
  projectPath: string;
  projectId?: string;
  /** Fast model for draft analysis (default: gpt-5-codex) */
  model?: string;
  /** 타임아웃 (기본: 30초 — drafter는 빠름) */
  timeoutMs?: number;
  onLog?: (line: string) => void;
}

// ============ 코드베이스 상태 수집 (로컬, LLM 불필요) ============

/**
 * Code Registry + Knowledge Graph에서 코드베이스 상태를 수집
 * LLM 호출 없이 로컬 DB 조회만으로 완료
 */
function collectCodebaseState(
  projectPath: string,
  projectId?: string,
  impactAnalysis?: ImpactAnalysis | null,
): { registrySnapshot: RegistryBrief[]; projectStats?: string } {
  const registrySnapshot: RegistryBrief[] = [];
  let projectStats: string | undefined;

  try {
    const store = getRegistryStore();

    // 1. 프로젝트 전체 통계
    const stats = store.getStats(projectId);
    const statParts: string[] = [`${stats.total} entities`];
    if (stats.deprecated > 0) statParts.push(`${stats.deprecated} deprecated`);
    if (stats.untested > 0) statParts.push(`${stats.untested} untested`);
    if (stats.withWarnings > 0) statParts.push(`${stats.withWarnings} with warnings`);
    if (stats.highRisk > 0) statParts.push(`${stats.highRisk} high-risk`);
    projectStats = statParts.join(', ');

    // 2. 영향받는 파일의 entity 상태
    const affectedFiles = new Set<string>();
    if (impactAnalysis) {
      for (const mod of impactAnalysis.directModules) affectedFiles.add(mod);
      for (const mod of impactAnalysis.dependentModules.slice(0, 8)) affectedFiles.add(mod);
    }

    for (const filePath of affectedFiles) {
      const brief = store.fileBrief(filePath);
      if (brief.entities.length === 0) continue;

      const highlights: string[] = [];
      for (const e of brief.entities) {
        if (e.status === 'deprecated') highlights.push(`${e.name} (deprecated)`);
        else if (e.status === 'broken') highlights.push(`${e.name} (broken)`);
        const critical = e.warnings.filter(w => !w.resolved && w.severity === 'critical');
        if (critical.length > 0) highlights.push(`${e.name} (${critical.length} critical)`);
      }

      // entity 목록 추가 — Worker가 파일을 읽지 않고 구조 파악 가능
      const entities = brief.entities.slice(0, 15).map(e => ({
        kind: e.kind,
        name: e.name,
        signature: e.signature?.slice(0, 80),
        status: e.status,
        hasTests: e.hasTests,
      }));

      registrySnapshot.push({
        filePath: brief.filePath,
        summary: brief.summary,
        highlights,
        entities,
      });
    }

    // 3. 검색으로 못 찾은 high-risk entity가 있으면 추가 (상위 5개)
    if (registrySnapshot.length < 3) {
      const highRisk = store.highRiskEntities(projectId).slice(0, 5);
      for (const e of highRisk) {
        if (!affectedFiles.has(e.filePath)) {
          registrySnapshot.push({
            filePath: e.filePath,
            summary: `high-risk: ${e.name} (complexity ${e.complexityScore}, no tests)`,
            highlights: [`${e.name} (high-risk, untested)`],
          });
        }
      }
    }
  } catch {
    // Registry 미초기화 — 빈 상태로 진행
  }

  return { registrySnapshot, projectStats };
}

// ============ drafter 의도 분석 ============

/**
 * drafter에게 이슈 의도를 분석시키는 프롬프트 구성
 * 코드베이스 상태를 컨텍스트로 제공하여 더 정확한 분류 유도
 */
function buildDraftPrompt(
  options: DraftAnalyzerOptions,
  codeContext: { registrySnapshot: RegistryBrief[]; projectStats?: string },
  impactAnalysis?: ImpactAnalysis | null,
): string {
  const parts: string[] = [];

  parts.push(`# Draft Analysis

You are a senior engineer preparing a COMPLETE work brief for an autonomous worker
that will rely ENTIRELY on this brief. A vague brief causes the worker to scaffold
and stop early, forcing rework — so be specific and grounded in the actual code
(reference real files, functions, call sites; read them when unsure). Do not defer
the hard parts.

## Task
- **Title:** ${options.taskTitle}
- **Description:** ${options.taskDescription || '(none)'}
`);

  // 코드베이스 상태 주입
  if (codeContext.projectStats) {
    parts.push(`## Codebase State
- **Project stats:** ${codeContext.projectStats}`);
  }

  if (impactAnalysis && impactAnalysis.directModules.length > 0) {
    parts.push(`- **Affected modules:** ${impactAnalysis.directModules.join(', ')}`);
    if (impactAnalysis.dependentModules.length > 0) {
      parts.push(`- **Dependents:** ${impactAnalysis.dependentModules.join(', ')}`);
    }
    if (impactAnalysis.testFiles.length > 0) {
      parts.push(`- **Test files:** ${impactAnalysis.testFiles.join(', ')}`);
    }
    parts.push(`- **Scope:** ${impactAnalysis.estimatedScope}`);
  }

  if (codeContext.registrySnapshot.length > 0) {
    parts.push('\n### File Health');
    for (const brief of codeContext.registrySnapshot.slice(0, 10)) {
      parts.push(`- \`${brief.filePath}\`: ${brief.summary}`);
      if (brief.highlights.length > 0) {
        parts.push(`  ⚠️ ${brief.highlights.join(', ')}`);
      }
    }
  }

  parts.push(`
## Output Format (JSON only, no explanation)
\`\`\`json
{
  "taskType": "bugfix" | "feature" | "refactor" | "docs" | "test" | "config" | "<a more specific type if none fit>",
  "intentSummary": "What this task is really asking for (1-2 sentences, concrete)",
  "relevantFiles": ["actual file paths that need changes — at least one"],
  "suggestedApproach": "How to approach this, referencing real files/functions (1-3 sentences)",
  "completionCriteria": ["execution-grounded definition of done — each item independently verifiable with EVIDENCE"]
}
\`\`\`

### taskType
The 6 types above are examples (few-shot), not a closed set — if the task fits a
more precise label (e.g. "perf", "security", "ci", "release"), use it. Avoid
"unknown" unless the task is genuinely unclassifiable.

### completionCriteria (most important)
Write what "done" objectively means, in terms the reviewer can check with EVIDENCE.
Each criterion must be a runtime/observable fact, NOT mere existence of code:
- GOOD: "resolve_turn_model is invoked from streaming.py (cite the call site)",
  "bench.json artifact is produced by one command", "before/after turn counts
  reported for the IKEA example", "added test covers the failure path and passes".
- BAD: "function is defined", "harness is scaffolded", "prompt rule added"
  (these are wiring, not done). Never list a criterion that can be satisfied by
  scaffolding alone. Do NOT defer core work to "follow-up" — fold it into a
  criterion. Produce 2–5 criteria.
`);

  return parts.join('\n');
}

/**
 * drafter 응답 파싱
 */
function parseDraftResponse(output: string): Partial<DraftAnalysis> {
  // JSON 블록 추출
  const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = jsonMatch?.[1] ?? findJsonObject(output);
  if (!jsonStr) {
    return { taskType: 'unknown', intentSummary: '', relevantFiles: [], suggestedApproach: '', completionCriteria: [] };
  }

  try {
    const parsed = JSON.parse(jsonStr);
    // taskType is now few-shot, not a closed set (INT-1916): accept any non-empty
    // string the model returns, only falling back to 'unknown' when truly absent.
    const taskType = typeof parsed.taskType === 'string' && parsed.taskType.trim()
      ? parsed.taskType.trim()
      : 'unknown';
    return {
      taskType: taskType as DraftAnalysis['taskType'],
      intentSummary: typeof parsed.intentSummary === 'string' ? parsed.intentSummary : '',
      relevantFiles: Array.isArray(parsed.relevantFiles) ? parsed.relevantFiles : [],
      suggestedApproach: typeof parsed.suggestedApproach === 'string' ? parsed.suggestedApproach : '',
      completionCriteria: Array.isArray(parsed.completionCriteria)
        ? parsed.completionCriteria.filter((c: unknown): c is string => typeof c === 'string' && c.trim().length > 0)
        : [],
    };
  } catch {
    return { taskType: 'unknown', intentSummary: '', relevantFiles: [], suggestedApproach: '', completionCriteria: [] };
  }
}

function findJsonObject(text: string): string | null {
  const idx = text.indexOf('"taskType"');
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

function getDraftFallbackAdapters(primary: AdapterName): AdapterName[] {
  const fallbackMap: Partial<Record<AdapterName, AdapterName>> = {
    codex: 'claude',
    'codex-responses': 'claude',
    claude: 'codex',
  };

  const fallback = fallbackMap[primary];
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
}

function isProviderQuotaError(message?: string): boolean {
  if (!message) return false;
  const text = message.toLowerCase();

  const hasQuotaSignal = /\bquota\b/.test(text);
  const hasRateLimit = /\brate[-\s]?limit\b/.test(text);
  const hasTooManyRequests = /\btoo many requests\b/.test(text);
  const hasInsufficientQuota = /\binsufficient[_-]?quota\b/.test(text);
  const hasUsageLimit = /\busage\b.*\blimit\b/.test(text) || /\blimit\b.*\busage\b/.test(text);
  const hasExceededPair = /\bexceeded\b/.test(text) && /\b(quota|limit|usage)\b/.test(text);
  const has429 = /\b429\b/.test(text) && (/\brequest\b/.test(text) || /rate/.test(text));
  const hasBilling = /\bbilling\b/.test(text);

  return (
    hasQuotaSignal ||
    hasRateLimit ||
    hasTooManyRequests ||
    hasInsufficientQuota ||
    hasUsageLimit ||
    hasExceededPair ||
    has429 ||
    hasBilling
  );
}

// ============ 메인 실행 ============

/**
 * Draft 분석 실행
 *
 * 흐름:
 * 1. Knowledge Graph impact analysis (로컬)
 * 2. Code Registry 상태 수집 (로컬)
 * 3. drafter에게 의도 분석 (API, ~3초)
 * 4. 결과 병합
 */
export async function runDraftAnalysis(options: DraftAnalyzerOptions): Promise<DraftAnalysis> {
  const startTime = Date.now();
  const { onLog } = options;
  const primaryAdapterName = getDefaultAdapterName();
  const adaptersToTry = [...new Set(getDraftFallbackAdapters(primaryAdapterName))];
  let lastError: unknown;
  let succeeded = false;

  onLog?.('[Draft] Starting pre-analysis...');

  // 1. Knowledge Graph — 영향 분석 (로컬, 즉시)
  let impactAnalysis: ImpactAnalysis | null = null;
  try {
    impactAnalysis = await analyzeIssue(
      options.projectPath,
      options.taskTitle,
      options.taskDescription || '',
    );
    if (impactAnalysis) {
      onLog?.(`[Draft] Impact: ${impactAnalysis.directModules.length} direct, ${impactAnalysis.dependentModules.length} dependent, scope=${impactAnalysis.estimatedScope}`);
    }
  } catch {
    // KG 미초기화 — 무시
  }

  // 2. Code Registry 상태 수집 (로컬, 즉시)
  const codeContext = collectCodebaseState(options.projectPath, options.projectId, impactAnalysis);
  if (codeContext.projectStats) {
    onLog?.(`[Draft] Registry: ${codeContext.projectStats}`);
  }

  // 3. Fast model draft analysis (~3s) — model resolves from the adapter when unset
  const prompt = buildDraftPrompt(options, codeContext, impactAnalysis);

  let haikuResult: Partial<DraftAnalysis> = {
    taskType: 'unknown',
    intentSummary: '',
    relevantFiles: [],
    suggestedApproach: '',
    completionCriteria: [],
  };
  let draftSufficient = false;

  // outer: per-adapter (primary → quota fallback). inner: drafter hard-gate retries.
  outer:
  for (let i = 0; i < adaptersToTry.length; i += 1) {
    const adapterName = adaptersToTry[i];
    const isFallbackAttempt = i > 0;
    const adapter = getAdapter(adapterName);
    // Explicit per-provider drafter model (INT-1915); options.model overrides on the
    // primary adapter only, then DRAFT_MODELS, then the adapter's own default.
    const override = isFallbackAttempt ? undefined : options.model;
    const resolvedModel = override ?? DRAFT_MODELS[adapterName] ?? await adapter.getDefaultModel();

    if (isFallbackAttempt) {
      onLog?.(`[Draft] Usage limit on ${adaptersToTry[i - 1]}, fallback to ${adapterName}`);
    }

    // drafter hard gate (INT-1917): retry until the brief is faithful enough.
    for (let attempt = 1; attempt <= DRAFT_MAX_ATTEMPTS; attempt += 1) {
      const attemptPrompt = attempt === 1 ? prompt : prompt + DRAFT_RETRY_NUDGE;
      try {
        const raw = await spawnCli(adapter, {
          prompt: attemptPrompt,
          cwd: options.projectPath, // read the real repo (INT-1917) — was '/tmp'
          timeoutMs: options.timeoutMs ?? 30000,
          model: resolvedModel,
          maxTurns: 3, // allow read_file/search_files — was 1 (couldn't read code)
        });

        haikuResult = parseDraftResponse(raw.stdout);
        succeeded = true;
        draftSufficient = isDraftSufficient(haikuResult);
        onLog?.(`[Draft] ${adapterName}(${resolvedModel}) attempt ${attempt}: type=${haikuResult.taskType}, files=${haikuResult.relevantFiles?.length ?? 0}, criteria=${haikuResult.completionCriteria?.length ?? 0}, sufficient=${draftSufficient}`);
        if (draftSufficient) break outer;
        if (attempt < DRAFT_MAX_ATTEMPTS) {
          onLog?.('[Draft] Brief insufficient — retrying with a stricter prompt');
        }
      } catch (err) {
        lastError = err;
        const errMsg = err instanceof Error ? err.message : String(err);
        onLog?.(`[Draft] analysis failed (${adapterName}): ${errMsg}`);

        if (!isFallbackAttempt && isProviderQuotaError(errMsg) && adaptersToTry.length > 1) {
          break; // break inner → try the fallback adapter
        }
        // Non-quota failure: stop entirely, continue pipeline with best-effort data.
        break outer;
      }
    }
    // Got a response from this adapter (sufficient or best-effort after retries).
    // Only quota errors (which leave succeeded=false) cascade to the fallback
    // adapter — insufficiency does not, to bound cost.
    if (succeeded) break;
  }

  if (!succeeded && lastError) {
    onLog?.(`[Draft] analysis failed (non-blocking): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
  if (succeeded && !draftSufficient) {
    onLog?.('[Draft] ⚠️ Brief still insufficient after retries — worker will be told to investigate thoroughly itself');
  }

  const durationMs = Date.now() - startTime;
  onLog?.(`[Draft] Complete in ${durationMs}ms`);

  return {
    taskType: haikuResult.taskType ?? 'unknown',
    intentSummary: haikuResult.intentSummary ?? '',
    relevantFiles: haikuResult.relevantFiles ?? [],
    suggestedApproach: haikuResult.suggestedApproach ?? '',
    completionCriteria: haikuResult.completionCriteria ?? [],
    sufficient: draftSufficient,
    impactAnalysis: impactAnalysis ?? undefined,
    registrySnapshot: codeContext.registrySnapshot,
    projectStats: codeContext.projectStats,
    durationMs,
  };
}
