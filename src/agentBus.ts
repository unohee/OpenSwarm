// ============================================
// Claude Swarm - Agent Message Bus
// 에이전트 간 컨텍스트 공유 시스템
// ============================================

import { resolve } from 'path';
import { homedir } from 'os';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';

// ============================================
// Types
// ============================================

/**
 * 메시지 타입
 */
export type MessageType =
  | 'step_started'
  | 'step_completed'
  | 'step_failed'
  | 'context_update'
  | 'file_changed'
  | 'error'
  | 'log'
  | 'request'
  | 'response';

/**
 * 에이전트 메시지
 */
export interface AgentMessage {
  id: string;
  timestamp: number;
  type: MessageType;
  sender: string;        // Step ID 또는 에이전트 ID
  recipient?: string;    // 특정 수신자 (없으면 broadcast)
  executionId: string;   // 워크플로우 실행 ID
  payload: unknown;
}

/**
 * Step 완료 메시지 페이로드
 */
export interface StepCompletedPayload {
  stepId: string;
  success: boolean;
  output: string;
  changedFiles: string[];
  duration: number;
  metadata?: Record<string, unknown>;
}

/**
 * 컨텍스트 업데이트 페이로드
 */
export interface ContextUpdatePayload {
  key: string;
  value: unknown;
  operation: 'set' | 'append' | 'delete';
}

/**
 * 파일 변경 페이로드
 */
export interface FileChangedPayload {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  diff?: string;
}

/**
 * 공유 컨텍스트
 */
export interface SharedContext {
  executionId: string;
  workflowId: string;
  startedAt: number;

  // Step 결과
  stepOutputs: Record<string, string>;

  // 변경된 파일 목록 (전체 워크플로우에서)
  changedFiles: string[];

  // 에러 로그
  errors: Array<{ stepId: string; message: string; timestamp: number }>;

  // 커스텀 데이터 (step 간 전달)
  data: Record<string, unknown>;
}

// ============================================
// Bus Implementation (File-based)
// ============================================

const BUS_DIR = resolve(homedir(), '.claude-swarm/bus');

/**
 * 메시지 버스 클래스
 */
export class AgentBus {
  private executionId: string;
  private contextPath: string;
  private messagesPath: string;
  private listeners: Map<MessageType, Array<(msg: AgentMessage) => void>> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private lastMessageId: string = '';

  constructor(executionId: string) {
    this.executionId = executionId;
    this.contextPath = resolve(BUS_DIR, executionId, 'context.json');
    this.messagesPath = resolve(BUS_DIR, executionId, 'messages');
  }

  /**
   * 버스 초기화
   */
  async init(workflowId: string): Promise<void> {
    await fs.mkdir(resolve(BUS_DIR, this.executionId, 'messages'), { recursive: true });

    // 초기 컨텍스트 생성
    const context: SharedContext = {
      executionId: this.executionId,
      workflowId,
      startedAt: Date.now(),
      stepOutputs: {},
      changedFiles: [],
      errors: [],
      data: {},
    };

    await this.saveContext(context);
    console.log(`[AgentBus] Initialized for execution: ${this.executionId}`);
  }

  /**
   * 메시지 발행
   */
  async publish(
    type: MessageType,
    sender: string,
    payload: unknown,
    recipient?: string
  ): Promise<string> {
    const message: AgentMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      type,
      sender,
      recipient,
      executionId: this.executionId,
      payload,
    };

    // 메시지 저장
    const messagePath = resolve(this.messagesPath, `${message.id}.json`);
    await fs.writeFile(messagePath, JSON.stringify(message, null, 2));

    // 특수 메시지 처리
    if (type === 'step_completed') {
      await this.handleStepCompleted(payload as StepCompletedPayload);
    } else if (type === 'context_update') {
      await this.handleContextUpdate(payload as ContextUpdatePayload);
    } else if (type === 'file_changed') {
      await this.handleFileChanged(payload as FileChangedPayload);
    } else if (type === 'error') {
      await this.handleError(sender, payload as string);
    }

    console.log(`[AgentBus] Published ${type} from ${sender}`);
    return message.id;
  }

  /**
   * Step 완료 처리
   */
  private async handleStepCompleted(payload: StepCompletedPayload): Promise<void> {
    const context = await this.getContext();
    if (!context) return;

    context.stepOutputs[payload.stepId] = payload.output;

    if (payload.changedFiles) {
      for (const file of payload.changedFiles) {
        if (!context.changedFiles.includes(file)) {
          context.changedFiles.push(file);
        }
      }
    }

    await this.saveContext(context);
  }

  /**
   * 컨텍스트 업데이트 처리
   */
  private async handleContextUpdate(payload: ContextUpdatePayload): Promise<void> {
    const context = await this.getContext();
    if (!context) return;

    switch (payload.operation) {
      case 'set':
        context.data[payload.key] = payload.value;
        break;
      case 'append':
        if (!Array.isArray(context.data[payload.key])) {
          context.data[payload.key] = [];
        }
        (context.data[payload.key] as unknown[]).push(payload.value);
        break;
      case 'delete':
        delete context.data[payload.key];
        break;
    }

    await this.saveContext(context);
  }

  /**
   * 파일 변경 처리
   */
  private async handleFileChanged(payload: FileChangedPayload): Promise<void> {
    const context = await this.getContext();
    if (!context) return;

    if (!context.changedFiles.includes(payload.path)) {
      context.changedFiles.push(payload.path);
    }

    await this.saveContext(context);
  }

  /**
   * 에러 처리
   */
  private async handleError(stepId: string, message: string): Promise<void> {
    const context = await this.getContext();
    if (!context) return;

    context.errors.push({
      stepId,
      message,
      timestamp: Date.now(),
    });

    await this.saveContext(context);
  }

  /**
   * 컨텍스트 조회
   */
  async getContext(): Promise<SharedContext | null> {
    try {
      const content = await fs.readFile(this.contextPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * 컨텍스트 저장
   */
  private async saveContext(context: SharedContext): Promise<void> {
    await fs.writeFile(this.contextPath, JSON.stringify(context, null, 2));
  }

  /**
   * 특정 Step의 출력 조회
   */
  async getStepOutput(stepId: string): Promise<string | null> {
    const context = await this.getContext();
    return context?.stepOutputs[stepId] ?? null;
  }

  /**
   * 모든 변경 파일 조회
   */
  async getChangedFiles(): Promise<string[]> {
    const context = await this.getContext();
    return context?.changedFiles ?? [];
  }

  /**
   * 커스텀 데이터 조회
   */
  async getData<T>(key: string): Promise<T | null> {
    const context = await this.getContext();
    return (context?.data[key] as T) ?? null;
  }

  /**
   * 커스텀 데이터 설정
   */
  async setData(key: string, value: unknown): Promise<void> {
    await this.publish('context_update', 'system', {
      key,
      value,
      operation: 'set',
    } as ContextUpdatePayload);
  }

  /**
   * 메시지 리스너 등록
   */
  on(type: MessageType, callback: (msg: AgentMessage) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(callback);
  }

  /**
   * 폴링 시작 (새 메시지 감지)
   */
  startPolling(intervalMs: number = 1000): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(async () => {
      await this.checkNewMessages();
    }, intervalMs);
  }

  /**
   * 폴링 중지
   */
  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * 새 메시지 확인
   */
  private async checkNewMessages(): Promise<void> {
    try {
      const files = await fs.readdir(this.messagesPath);
      const newFiles = files
        .filter(f => f.endsWith('.json') && f > this.lastMessageId)
        .sort();

      for (const file of newFiles) {
        const content = await fs.readFile(resolve(this.messagesPath, file), 'utf-8');
        const message: AgentMessage = JSON.parse(content);

        // 리스너 호출
        const callbacks = this.listeners.get(message.type);
        if (callbacks) {
          for (const cb of callbacks) {
            cb(message);
          }
        }

        this.lastMessageId = file;
      }
    } catch {
      // 무시
    }
  }

  /**
   * 모든 메시지 조회
   */
  async getAllMessages(): Promise<AgentMessage[]> {
    try {
      const files = await fs.readdir(this.messagesPath);
      const messages: AgentMessage[] = [];

      for (const file of files.filter(f => f.endsWith('.json')).sort()) {
        const content = await fs.readFile(resolve(this.messagesPath, file), 'utf-8');
        messages.push(JSON.parse(content));
      }

      return messages;
    } catch {
      return [];
    }
  }

  /**
   * Step 컨텍스트 생성 (이전 step 결과 포함)
   */
  async createStepContext(stepId: string, dependsOn?: string[]): Promise<string> {
    const context = await this.getContext();
    if (!context) return '';

    const parts: string[] = [
      '## Workflow Context',
      '',
      `Execution ID: ${context.executionId}`,
      `Started: ${new Date(context.startedAt).toISOString()}`,
      '',
    ];

    // 이전 step 결과
    if (dependsOn && dependsOn.length > 0) {
      parts.push('### Previous Step Results');
      for (const depId of dependsOn) {
        const output = context.stepOutputs[depId];
        if (output) {
          parts.push(`\n#### ${depId}:`);
          parts.push(output.slice(0, 2000));  // 너무 길면 자름
        }
      }
      parts.push('');
    }

    // 변경된 파일
    if (context.changedFiles.length > 0) {
      parts.push('### Changed Files So Far');
      parts.push(context.changedFiles.map(f => `- ${f}`).join('\n'));
      parts.push('');
    }

    // 에러 로그
    if (context.errors.length > 0) {
      parts.push('### Previous Errors');
      for (const err of context.errors) {
        parts.push(`- [${err.stepId}] ${err.message}`);
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  /**
   * 버스 정리
   */
  async cleanup(): Promise<void> {
    this.stopPolling();
    // 필요시 파일 정리
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * 새 버스 인스턴스 생성
 */
export function createBus(executionId?: string): AgentBus {
  const id = executionId || `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new AgentBus(id);
}

/**
 * 기존 버스 연결
 */
export async function connectToBus(executionId: string): Promise<AgentBus | null> {
  const contextPath = resolve(BUS_DIR, executionId, 'context.json');
  if (!existsSync(contextPath)) {
    return null;
  }
  return new AgentBus(executionId);
}

/**
 * 실행 중인 버스 목록
 */
export async function listActiveBuses(): Promise<string[]> {
  try {
    await fs.mkdir(BUS_DIR, { recursive: true });
    const dirs = await fs.readdir(BUS_DIR);
    const active: string[] = [];

    for (const dir of dirs) {
      const contextPath = resolve(BUS_DIR, dir, 'context.json');
      if (existsSync(contextPath)) {
        active.push(dir);
      }
    }

    return active;
  } catch {
    return [];
  }
}
