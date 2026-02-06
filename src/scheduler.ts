// ============================================
// Claude Swarm - Dynamic Scheduler
// spawn 기반 실행 (tmux 불필요)
// ============================================

import { Cron } from 'croner';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { homedir } from 'os';
import * as fs from 'fs/promises';
import { checkWorkAllowed } from './timeWindow.js';

// 스케줄 저장 경로
const SCHEDULE_DIR = resolve(homedir(), '.claude-swarm');
const SCHEDULE_FILE = resolve(SCHEDULE_DIR, 'schedules.json');

// 스케줄 작업 인터페이스
export interface ScheduledJob {
  id: string;
  name: string;
  projectPath: string;
  prompt: string;
  schedule: string; // cron 표현식 또는 interval (예: "30m", "1h", "0 9 * * *")
  enabled: boolean;
  createdAt: number;
  lastRun?: number;
  createdBy?: string; // Discord 사용자
}

// 실행 결과 인터페이스
export interface JobResult {
  jobId: string;
  success: boolean;
  output: string;
  error?: string;
  startedAt: number;
  finishedAt: number;
}

// 실행 중인 cron 작업
const activeJobs: Map<string, Cron> = new Map();

// 실행 중인 프로세스 (동시 실행 방지용)
const runningProcesses: Map<string, ReturnType<typeof spawn>> = new Map();

// 최근 실행 결과 (보고용)
const recentResults: JobResult[] = [];
const MAX_RESULTS = 50;

// 결과 리스너 (Discord 보고 등)
type ResultListener = (result: JobResult) => void;
let resultListener: ResultListener | null = null;

/**
 * 결과 리스너 등록
 */
export function setResultListener(listener: ResultListener): void {
  resultListener = listener;
}

/**
 * 스케줄 파일 로드
 */
async function loadSchedules(): Promise<ScheduledJob[]> {
  try {
    await fs.mkdir(SCHEDULE_DIR, { recursive: true });
    const data = await fs.readFile(SCHEDULE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

/**
 * 스케줄 파일 저장
 */
async function saveSchedules(schedules: ScheduledJob[]): Promise<void> {
  await fs.mkdir(SCHEDULE_DIR, { recursive: true });
  await fs.writeFile(SCHEDULE_FILE, JSON.stringify(schedules, null, 2));
}

/**
 * interval 문자열을 cron 표현식으로 변환
 */
function intervalToCron(interval: string): string {
  const match = interval.match(/^(\d+)(m|h|d)$/);
  if (!match) return interval;

  const [, value, unit] = match;
  const num = parseInt(value, 10);

  switch (unit) {
    case 'm':
      return `*/${num} * * * *`;
    case 'h':
      if (num === 1) return '0 * * * *';
      return `0 */${num} * * *`;
    case 'd':
      return `0 9 */${num} * *`;
    default:
      return interval;
  }
}

/**
 * Claude CLI를 spawn으로 실행
 */
async function runClaudeCli(
  projectPath: string,
  prompt: string,
  jobId: string
): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    const expandedPath = projectPath.replace('~', homedir());

    // 프롬프트 파일 저장
    const promptFile = `${SCHEDULE_DIR}/prompt-${jobId}.txt`;
    fs.writeFile(promptFile, prompt).then(() => {
      const cmd = 'bash';
      const args = [
        '-c',
        `cd "${expandedPath}" && claude -p "$(cat ${promptFile})" --output-format stream-json --permission-mode bypassPermissions`,
      ];

      console.log(`[Scheduler] Spawning Claude CLI for ${jobId}...`);
      const proc = spawn(cmd, args, {
        cwd: expandedPath,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      runningProcesses.set(jobId, proc);

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        runningProcesses.delete(jobId);

        // stream-json 출력에서 result 추출
        let resultText = stdout;
        try {
          const lines = stdout.split('\n').filter(Boolean);
          const resultLine = lines.find((l) => l.includes('"type":"result"'));
          if (resultLine) {
            const parsed = JSON.parse(resultLine);
            resultText = parsed.result || stdout;
          }
        } catch {
          // 파싱 실패시 원본 사용
        }

        resolve({
          success: code === 0,
          output: resultText.slice(0, 2000), // 최대 2000자
          error: stderr || undefined,
        });
      });

      proc.on('error', (err) => {
        runningProcesses.delete(jobId);
        resolve({
          success: false,
          output: '',
          error: err.message,
        });
      });
    });
  });
}

/**
 * 스케줄 작업 실행
 */
async function runScheduledJob(job: ScheduledJob): Promise<void> {
  // 시간 윈도우 체크
  const timeCheck = checkWorkAllowed();
  if (!timeCheck.allowed) {
    console.log(
      `[Scheduler] Job "${job.name}" 스킵: ${timeCheck.reason} (현재: ${timeCheck.currentTime})`
    );
    return;
  }

  // 이미 실행 중인지 체크
  if (runningProcesses.has(job.id)) {
    console.log(`[Scheduler] Job "${job.name}" 이미 실행 중, 스킵`);
    return;
  }

  console.log(`[Scheduler] Running job: ${job.name}`);
  const startedAt = Date.now();

  try {
    const { success, output, error } = await runClaudeCli(
      job.projectPath,
      job.prompt,
      job.id
    );

    const result: JobResult = {
      jobId: job.id,
      success,
      output,
      error,
      startedAt,
      finishedAt: Date.now(),
    };

    // 결과 저장
    recentResults.unshift(result);
    if (recentResults.length > MAX_RESULTS) {
      recentResults.pop();
    }

    // 리스너에게 알림
    if (resultListener) {
      resultListener(result);
    }

    // 마지막 실행 시간 업데이트
    const schedules = await loadSchedules();
    const updated = schedules.map((s) =>
      s.id === job.id ? { ...s, lastRun: Date.now() } : s
    );
    await saveSchedules(updated);

    console.log(
      `[Scheduler] Job ${job.name} ${success ? '완료' : '실패'} (${Math.round((result.finishedAt - startedAt) / 1000)}s)`
    );
  } catch (err) {
    console.error(`[Scheduler] Job ${job.name} 에러:`, err);
  }
}

/**
 * 스케줄 작업 등록
 */
export async function addSchedule(
  name: string,
  projectPath: string,
  prompt: string,
  schedule: string,
  createdBy?: string
): Promise<ScheduledJob> {
  const schedules = await loadSchedules();

  // 중복 체크
  const existing = schedules.find((s) => s.name === name);
  if (existing) {
    throw new Error(`Schedule "${name}" already exists`);
  }

  const job: ScheduledJob = {
    id: `job-${Date.now()}`,
    name,
    projectPath,
    prompt,
    schedule,
    enabled: true,
    createdAt: Date.now(),
    createdBy,
  };

  schedules.push(job);
  await saveSchedules(schedules);

  // cron 작업 시작
  await startCronJob(job);

  console.log(`[Scheduler] Added schedule: ${name} (${schedule})`);
  return job;
}

/**
 * 스케줄 작업 삭제
 */
export async function removeSchedule(nameOrId: string): Promise<boolean> {
  const schedules = await loadSchedules();
  const index = schedules.findIndex(
    (s) => s.name === nameOrId || s.id === nameOrId
  );

  if (index === -1) return false;

  const job = schedules[index];

  // cron 작업 중지
  const cron = activeJobs.get(job.id);
  if (cron) {
    cron.stop();
    activeJobs.delete(job.id);
  }

  // 실행 중인 프로세스 종료
  const proc = runningProcesses.get(job.id);
  if (proc) {
    proc.kill('SIGTERM');
    runningProcesses.delete(job.id);
  }

  // 저장
  schedules.splice(index, 1);
  await saveSchedules(schedules);

  console.log(`[Scheduler] Removed schedule: ${job.name}`);
  return true;
}

/**
 * 스케줄 작업 일시 중지/재개
 */
export async function toggleSchedule(
  nameOrId: string
): Promise<ScheduledJob | null> {
  const schedules = await loadSchedules();
  const job = schedules.find((s) => s.name === nameOrId || s.id === nameOrId);

  if (!job) return null;

  job.enabled = !job.enabled;
  await saveSchedules(schedules);

  // cron 작업 토글
  const cron = activeJobs.get(job.id);
  if (job.enabled && !cron) {
    await startCronJob(job);
  } else if (!job.enabled && cron) {
    cron.stop();
    activeJobs.delete(job.id);
  }

  console.log(
    `[Scheduler] ${job.enabled ? 'Enabled' : 'Disabled'} schedule: ${job.name}`
  );
  return job;
}

/**
 * cron 작업 시작
 */
async function startCronJob(job: ScheduledJob): Promise<void> {
  if (!job.enabled) return;

  const cronExpr = intervalToCron(job.schedule);

  try {
    const cron = new Cron(cronExpr, () => {
      void runScheduledJob(job).catch((err) => {
        console.error(`[Scheduler] Job ${job.name} error:`, err);
      });
    });

    activeJobs.set(job.id, cron);
    console.log(`[Scheduler] Started cron for ${job.name}: ${cronExpr}`);
  } catch (err) {
    console.error(`[Scheduler] Failed to start cron for ${job.name}:`, err);
  }
}

/**
 * 모든 스케줄 로드 및 시작
 */
export async function startAllSchedules(): Promise<void> {
  const schedules = await loadSchedules();
  console.log(`[Scheduler] Loading ${schedules.length} schedules...`);

  for (const job of schedules) {
    if (job.enabled) {
      await startCronJob(job);
    }
  }
}

/**
 * 모든 스케줄 중지
 */
export function stopAllSchedules(): void {
  for (const [id, cron] of activeJobs) {
    cron.stop();
    console.log(`[Scheduler] Stopped cron: ${id}`);
  }
  activeJobs.clear();

  // 실행 중인 프로세스도 종료
  for (const [id, proc] of runningProcesses) {
    proc.kill('SIGTERM');
    console.log(`[Scheduler] Killed process: ${id}`);
  }
  runningProcesses.clear();
}

/**
 * 스케줄 목록 조회
 */
export async function listSchedules(): Promise<ScheduledJob[]> {
  return loadSchedules();
}

/**
 * 즉시 실행
 */
export async function runNow(
  nameOrId: string,
  bypassTimeWindow = false
): Promise<boolean> {
  const schedules = await loadSchedules();
  const job = schedules.find((s) => s.name === nameOrId || s.id === nameOrId);

  if (!job) return false;

  if (bypassTimeWindow) {
    console.log(`[Scheduler] Running job: ${job.name} (시간 제한 우회)`);
    const { success } = await runClaudeCli(job.projectPath, job.prompt, job.id);

    const updatedSchedules = await loadSchedules();
    const updated = updatedSchedules.map((s) =>
      s.id === job.id ? { ...s, lastRun: Date.now() } : s
    );
    await saveSchedules(updated);
    return success;
  }

  await runScheduledJob(job);
  return true;
}

/**
 * 최근 실행 결과 조회
 */
export function getRecentResults(limit = 10): JobResult[] {
  return recentResults.slice(0, limit);
}

/**
 * 실행 중인 작업 목록
 */
export function getRunningJobs(): string[] {
  return Array.from(runningProcesses.keys());
}

/**
 * 스케줄 목록 포맷팅
 */
export function formatScheduleList(schedules: ScheduledJob[]): string {
  if (schedules.length === 0) {
    return '등록된 스케줄이 없습니다.';
  }

  return schedules
    .map((s, i) => {
      const status = s.enabled ? '✅' : '⏸️';
      const lastRun = s.lastRun
        ? new Date(s.lastRun).toLocaleString('ko-KR')
        : '없음';
      return `${i + 1}. ${status} **${s.name}**\n   📁 ${s.projectPath}\n   ⏰ ${s.schedule} | 마지막: ${lastRun}`;
    })
    .join('\n\n');
}

/**
 * 자연어에서 스케줄 정보 파싱
 */
export function parseScheduleFromNaturalLanguage(
  text: string
): {
  name?: string;
  schedule?: string;
  projectPath?: string;
  prompt?: string;
} | null {
  const result: {
    name?: string;
    schedule?: string;
    projectPath?: string;
    prompt?: string;
  } = {};

  // 프로젝트 이름 추출
  const nameMatch = text.match(/["']([^"']+)["']|^(\S+)/);
  if (nameMatch) {
    result.name = nameMatch[1] || nameMatch[2];
  }

  // 주기 추출
  const intervalMatch = text.match(/(\d+)\s*(분|시간|일|min|hour|h|m|d)/i);
  if (intervalMatch) {
    const [, num, unit] = intervalMatch;
    const unitMap: Record<string, string> = {
      분: 'm',
      min: 'm',
      m: 'm',
      시간: 'h',
      hour: 'h',
      h: 'h',
      일: 'd',
      d: 'd',
    };
    result.schedule = `${num}${unitMap[unit.toLowerCase()] || 'm'}`;
  }

  // 매일/매주 등
  if (text.includes('매일') || text.includes('daily')) {
    result.schedule = '0 9 * * *';
  }
  if (text.includes('매주') || text.includes('weekly')) {
    result.schedule = '0 9 * * 1';
  }

  return Object.keys(result).length > 0 ? result : null;
}
