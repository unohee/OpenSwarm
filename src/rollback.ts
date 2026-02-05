// ============================================
// Claude Swarm - Git-based Rollback System
// 워크플로우 실패 시 자동 복구
// ============================================

import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'path';
import { homedir } from 'os';
import * as fs from 'fs/promises';

const execAsync = promisify(exec);

// ============================================
// Types
// ============================================

/**
 * 체크포인트 정보
 */
export interface Checkpoint {
  id: string;
  executionId: string;
  projectPath: string;
  createdAt: number;
  commitHash: string;
  stashId?: string;
  branchName: string;
  description: string;
}

/**
 * 롤백 결과
 */
export interface RollbackResult {
  success: boolean;
  checkpoint: Checkpoint;
  action: 'reset' | 'stash_pop' | 'checkout';
  message: string;
  error?: string;
}

/**
 * 롤백 전략
 */
export type RollbackStrategy = 'reset_hard' | 'reset_soft' | 'stash' | 'checkout_files';

// ============================================
// Checkpoint Storage
// ============================================

const CHECKPOINT_DIR = resolve(homedir(), '.claude-swarm/checkpoints');

/**
 * 체크포인트 저장
 */
async function saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
  await fs.mkdir(CHECKPOINT_DIR, { recursive: true });
  const filePath = resolve(CHECKPOINT_DIR, `${checkpoint.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(checkpoint, null, 2));
}

/**
 * 체크포인트 로드
 */
async function loadCheckpoint(checkpointId: string): Promise<Checkpoint | null> {
  try {
    const filePath = resolve(CHECKPOINT_DIR, `${checkpointId}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * 실행 ID로 체크포인트 찾기
 */
export async function findCheckpointByExecution(executionId: string): Promise<Checkpoint | null> {
  try {
    const files = await fs.readdir(CHECKPOINT_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const content = await fs.readFile(resolve(CHECKPOINT_DIR, file), 'utf-8');
        const checkpoint: Checkpoint = JSON.parse(content);
        if (checkpoint.executionId === executionId) {
          return checkpoint;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================
// Git Operations
// ============================================

/**
 * Git 명령 실행 헬퍼
 */
async function gitExec(projectPath: string, command: string): Promise<{ stdout: string; stderr: string }> {
  const expandedPath = projectPath.replace('~', homedir());
  try {
    return await execAsync(`git ${command}`, { cwd: expandedPath });
  } catch (error: any) {
    throw new Error(`Git command failed: git ${command}\n${error.stderr || error.message}`);
  }
}

/**
 * 현재 commit hash 가져오기
 */
async function getCurrentCommit(projectPath: string): Promise<string> {
  const { stdout } = await gitExec(projectPath, 'rev-parse HEAD');
  return stdout.trim();
}

/**
 * 현재 브랜치 이름 가져오기
 */
async function getCurrentBranch(projectPath: string): Promise<string> {
  const { stdout } = await gitExec(projectPath, 'branch --show-current');
  return stdout.trim() || 'HEAD';
}

/**
 * 변경사항 있는지 확인
 */
async function hasChanges(projectPath: string): Promise<boolean> {
  try {
    const { stdout } = await gitExec(projectPath, 'status --porcelain');
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 변경된 파일 목록
 */
async function getChangedFiles(projectPath: string): Promise<string[]> {
  try {
    const { stdout } = await gitExec(projectPath, 'status --porcelain');
    return stdout
      .split('\n')
      .filter(line => line.trim())
      .map(line => line.slice(3).trim());
  } catch {
    return [];
  }
}

// ============================================
// Checkpoint Creation
// ============================================

/**
 * 워크플로우 시작 전 체크포인트 생성
 */
export async function createCheckpoint(
  executionId: string,
  projectPath: string,
  description?: string
): Promise<Checkpoint> {
  console.log(`[Rollback] Creating checkpoint for execution: ${executionId}`);

  const expandedPath = projectPath.replace('~', homedir());
  const commitHash = await getCurrentCommit(expandedPath);
  const branchName = await getCurrentBranch(expandedPath);
  let stashId: string | undefined;

  // 변경사항이 있으면 stash
  if (await hasChanges(expandedPath)) {
    const changedFiles = await getChangedFiles(expandedPath);
    console.log(`[Rollback] Stashing ${changedFiles.length} changed files`);

    const stashMessage = `claude-swarm-checkpoint-${executionId}`;
    await gitExec(expandedPath, `stash push -m "${stashMessage}" --include-untracked`);

    // Stash ID 찾기
    const { stdout } = await gitExec(expandedPath, 'stash list');
    const stashLine = stdout.split('\n').find(line => line.includes(stashMessage));
    if (stashLine) {
      stashId = stashLine.match(/stash@\{(\d+)\}/)?.[0];
    }
  }

  const checkpoint: Checkpoint = {
    id: `ckpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    executionId,
    projectPath: expandedPath,
    createdAt: Date.now(),
    commitHash,
    stashId,
    branchName,
    description: description || `Checkpoint for ${executionId}`,
  };

  await saveCheckpoint(checkpoint);
  console.log(`[Rollback] Checkpoint created: ${checkpoint.id}`);

  return checkpoint;
}

// ============================================
// Rollback Operations
// ============================================

/**
 * 체크포인트로 롤백
 */
export async function rollbackToCheckpoint(
  checkpointId: string,
  strategy: RollbackStrategy = 'reset_hard'
): Promise<RollbackResult> {
  const checkpoint = await loadCheckpoint(checkpointId);
  if (!checkpoint) {
    return {
      success: false,
      checkpoint: null as any,
      action: 'reset',
      message: 'Checkpoint not found',
      error: `Checkpoint ${checkpointId} does not exist`,
    };
  }

  return rollback(checkpoint, strategy);
}

/**
 * 실행 ID로 롤백
 */
export async function rollbackExecution(
  executionId: string,
  strategy: RollbackStrategy = 'reset_hard'
): Promise<RollbackResult> {
  const checkpoint = await findCheckpointByExecution(executionId);
  if (!checkpoint) {
    return {
      success: false,
      checkpoint: null as any,
      action: 'reset',
      message: 'Checkpoint not found for execution',
      error: `No checkpoint found for execution ${executionId}`,
    };
  }

  return rollback(checkpoint, strategy);
}

/**
 * 실제 롤백 수행
 */
async function rollback(
  checkpoint: Checkpoint,
  strategy: RollbackStrategy
): Promise<RollbackResult> {
  console.log(`[Rollback] Rolling back to checkpoint: ${checkpoint.id}`);
  console.log(`[Rollback] Strategy: ${strategy}`);
  console.log(`[Rollback] Target commit: ${checkpoint.commitHash}`);

  try {
    switch (strategy) {
      case 'reset_hard':
        // 모든 변경사항 버리고 체크포인트로 복원
        await gitExec(checkpoint.projectPath, `reset --hard ${checkpoint.commitHash}`);

        // Stash가 있었으면 복원
        if (checkpoint.stashId) {
          try {
            await gitExec(checkpoint.projectPath, `stash pop ${checkpoint.stashId}`);
          } catch {
            console.log('[Rollback] Stash pop failed, may have conflicts');
          }
        }

        return {
          success: true,
          checkpoint,
          action: 'reset',
          message: `Reset to ${checkpoint.commitHash.slice(0, 7)}`,
        };

      case 'reset_soft':
        // 변경사항은 staged 상태로 유지
        await gitExec(checkpoint.projectPath, `reset --soft ${checkpoint.commitHash}`);

        return {
          success: true,
          checkpoint,
          action: 'reset',
          message: `Soft reset to ${checkpoint.commitHash.slice(0, 7)}, changes staged`,
        };

      case 'stash':
        // 현재 변경사항 stash하고 체크포인트로
        if (await hasChanges(checkpoint.projectPath)) {
          const stashMsg = `rollback-preserve-${Date.now()}`;
          await gitExec(checkpoint.projectPath, `stash push -m "${stashMsg}" --include-untracked`);
        }
        await gitExec(checkpoint.projectPath, `checkout ${checkpoint.commitHash}`);

        // 원래 stash 복원
        if (checkpoint.stashId) {
          try {
            await gitExec(checkpoint.projectPath, `stash pop ${checkpoint.stashId}`);
          } catch {
            console.log('[Rollback] Original stash pop failed');
          }
        }

        return {
          success: true,
          checkpoint,
          action: 'stash_pop',
          message: `Checked out ${checkpoint.commitHash.slice(0, 7)}, current changes stashed`,
        };

      case 'checkout_files':
        // 파일만 체크포인트 상태로 (commit은 유지)
        await gitExec(checkpoint.projectPath, `checkout ${checkpoint.commitHash} -- .`);

        return {
          success: true,
          checkpoint,
          action: 'checkout',
          message: `Files restored from ${checkpoint.commitHash.slice(0, 7)}`,
        };

      default:
        throw new Error(`Unknown rollback strategy: ${strategy}`);
    }
  } catch (error: any) {
    console.error('[Rollback] Failed:', error.message);
    return {
      success: false,
      checkpoint,
      action: 'reset',
      message: 'Rollback failed',
      error: error.message,
    };
  }
}

// ============================================
// Cleanup
// ============================================

/**
 * 오래된 체크포인트 정리
 */
export async function cleanupOldCheckpoints(maxAgeDays: number = 7): Promise<number> {
  try {
    await fs.mkdir(CHECKPOINT_DIR, { recursive: true });
    const files = await fs.readdir(CHECKPOINT_DIR);
    const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let deleted = 0;

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const filePath = resolve(CHECKPOINT_DIR, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const checkpoint: Checkpoint = JSON.parse(content);

      if (now - checkpoint.createdAt > maxAge) {
        await fs.unlink(filePath);
        deleted++;
      }
    }

    if (deleted > 0) {
      console.log(`[Rollback] Cleaned up ${deleted} old checkpoints`);
    }

    return deleted;
  } catch {
    return 0;
  }
}

/**
 * 체크포인트 목록
 */
export async function listCheckpoints(): Promise<Checkpoint[]> {
  try {
    await fs.mkdir(CHECKPOINT_DIR, { recursive: true });
    const files = await fs.readdir(CHECKPOINT_DIR);
    const checkpoints: Checkpoint[] = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        const content = await fs.readFile(resolve(CHECKPOINT_DIR, file), 'utf-8');
        checkpoints.push(JSON.parse(content));
      }
    }

    return checkpoints.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

// ============================================
// Utility Functions
// ============================================

/**
 * 현재 git 상태 요약
 */
export async function getGitStatus(projectPath: string): Promise<{
  branch: string;
  commit: string;
  hasChanges: boolean;
  changedFiles: string[];
}> {
  const expandedPath = projectPath.replace('~', homedir());

  return {
    branch: await getCurrentBranch(expandedPath),
    commit: await getCurrentCommit(expandedPath),
    hasChanges: await hasChanges(expandedPath),
    changedFiles: await getChangedFiles(expandedPath),
  };
}
