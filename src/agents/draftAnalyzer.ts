// ============================================
// OpenSwarm - Draft Analyzer
// Created: 2026-04-11
// Purpose: Haiku 기반 사전 분석 — 이슈 의도 파악 + 코드베이스 상태 수집
//          Planner/Worker에 enriched context를 제공하여 첫 시도 정확도 향상
// ============================================

import { getAdapter, spawnCli } from '../adapters/index.js';
import { analyzeIssue } from '../knowledge/index.js';
import { getRegistryStore } from '../registry/sqliteStore.js';
import type { ImpactAnalysis } from '../knowledge/types.js';

// ============ 타입 ============

/** Draft 분석 결과 — Planner와 Worker 모두에 주입 */
export interface DraftAnalysis {
  /** 작업 유형 분류 */
  taskType: 'bugfix' | 'feature' | 'refactor' | 'docs' | 'test' | 'config' | 'unknown';
  /** Haiku가 요약한 핵심 의도 (1-2문장) */
  intentSummary: string;
  /** Haiku가 식별한 관련 파일/모듈 목록 */
  relevantFiles: string[];
  /** Haiku가 제안한 접근 방식 (1-3문장) */
  suggestedApproach: string;
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
  /** Haiku 모델명 (기본: claude-haiku-4-5-20251001) */
  model?: string;
  /** 타임아웃 (기본: 30초 — Haiku는 빠름) */
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

// ============ Haiku 의도 분석 ============

/**
 * Haiku에게 이슈 의도를 분석시키는 프롬프트 구성
 * 코드베이스 상태를 컨텍스트로 제공하여 더 정확한 분류 유도
 */
function buildDraftPrompt(
  options: DraftAnalyzerOptions,
  codeContext: { registrySnapshot: RegistryBrief[]; projectStats?: string },
  impactAnalysis?: ImpactAnalysis | null,
): string {
  const parts: string[] = [];

  parts.push(`# Draft Analysis

Analyze this task and provide a structured assessment. Be concise.

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
  "taskType": "bugfix" | "feature" | "refactor" | "docs" | "test" | "config" | "unknown",
  "intentSummary": "What this task is really asking for (1-2 sentences)",
  "relevantFiles": ["file paths that likely need changes"],
  "suggestedApproach": "How to approach this (1-3 sentences)"
}
\`\`\`
`);

  return parts.join('\n');
}

/**
 * Haiku 응답 파싱
 */
function parseDraftResponse(output: string): Partial<DraftAnalysis> {
  // JSON 블록 추출
  const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = jsonMatch?.[1] ?? findJsonObject(output);
  if (!jsonStr) {
    return { taskType: 'unknown', intentSummary: '', relevantFiles: [], suggestedApproach: '' };
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      taskType: ['bugfix', 'feature', 'refactor', 'docs', 'test', 'config'].includes(parsed.taskType)
        ? parsed.taskType
        : 'unknown',
      intentSummary: typeof parsed.intentSummary === 'string' ? parsed.intentSummary : '',
      relevantFiles: Array.isArray(parsed.relevantFiles) ? parsed.relevantFiles : [],
      suggestedApproach: typeof parsed.suggestedApproach === 'string' ? parsed.suggestedApproach : '',
    };
  } catch {
    return { taskType: 'unknown', intentSummary: '', relevantFiles: [], suggestedApproach: '' };
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

// ============ 메인 실행 ============

/**
 * Draft 분석 실행
 *
 * 흐름:
 * 1. Knowledge Graph impact analysis (로컬)
 * 2. Code Registry 상태 수집 (로컬)
 * 3. Haiku에게 의도 분석 (API, ~3초)
 * 4. 결과 병합
 */
export async function runDraftAnalysis(options: DraftAnalyzerOptions): Promise<DraftAnalysis> {
  const startTime = Date.now();
  const { onLog } = options;

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

  // 3. Haiku 의도 분석 (API, ~3초)
  const model = options.model ?? 'claude-haiku-4-5-20251001';
  const prompt = buildDraftPrompt(options, codeContext, impactAnalysis);

  let haikuResult: Partial<DraftAnalysis> = {
    taskType: 'unknown',
    intentSummary: '',
    relevantFiles: [],
    suggestedApproach: '',
  };

  try {
    const adapter = getAdapter('claude');
    const raw = await spawnCli(adapter, {
      prompt,
      cwd: '/tmp',  // 중립 디렉토리 (Planner와 동일)
      timeoutMs: options.timeoutMs ?? 30000,
      model,
      maxTurns: 1,
    });

    haikuResult = parseDraftResponse(raw.stdout);
    onLog?.(`[Draft] Haiku: type=${haikuResult.taskType}, files=${haikuResult.relevantFiles?.length ?? 0}`);
  } catch (err) {
    onLog?.(`[Draft] Haiku analysis failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
  }

  const durationMs = Date.now() - startTime;
  onLog?.(`[Draft] Complete in ${durationMs}ms`);

  return {
    taskType: haikuResult.taskType ?? 'unknown',
    intentSummary: haikuResult.intentSummary ?? '',
    relevantFiles: haikuResult.relevantFiles ?? [],
    suggestedApproach: haikuResult.suggestedApproach ?? '',
    impactAnalysis: impactAnalysis ?? undefined,
    registrySnapshot: codeContext.registrySnapshot,
    projectStats: codeContext.projectStats,
    durationMs,
  };
}
