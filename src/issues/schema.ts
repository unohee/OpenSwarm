// ============================================
// OpenSwarm - Issue Tracker Schema
// Created: 2026-04-03
// Purpose: Zod 스키마 + 타입 정의 (로컬 이슈 트래커)
// ============================================

import { z } from 'zod';

// 이슈 상태 (Linear 호환 + 로컬 확장)
export const IssueStatusSchema = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
]);

export const IssuePrioritySchema = z.enum([
  'urgent',   // P0
  'high',     // P1
  'medium',   // P2
  'low',      // P3
  'none',     // P4
]);

// 이슈 소스: 로컬 생성 vs Linear 동기화
export const IssueSourceSchema = z.enum([
  'local',
  'linear',
  'github',
  'discord',
]);

// 이슈 이벤트 타입 (이력 추적 + 메모리 연동)
export const IssueEventTypeSchema = z.enum([
  'created',
  'status_changed',
  'priority_changed',
  'assigned',
  'commented',
  'labeled',
  'linked',         // 다른 이슈/PR 연결
  'memory_linked',  // 장기 기억 연동
  'closed',
  'reopened',
]);

// 이슈 이벤트 로그 (메모리 시스템 연동용)
export const IssueEventSchema = z.object({
  id: z.string(),
  issueId: z.string(),
  type: IssueEventTypeSchema,
  // 상태 변경 시 before/after
  oldValue: z.string().optional(),
  newValue: z.string().optional(),
  // 코멘트
  content: z.string().optional(),
  // 메모리 연동
  memoryId: z.string().optional(),
  // 메타
  actor: z.string().default('system'),
  createdAt: z.string(),
});

// 메인 이슈 스키마
export const IssueSchema = z.object({
  id: z.string(),
  projectId: z.string(),          // config.yaml 프로젝트 매핑
  title: z.string().min(1),
  description: z.string().default(''),
  status: IssueStatusSchema.default('backlog'),
  priority: IssuePrioritySchema.default('medium'),
  source: IssueSourceSchema.default('local'),

  // 분류
  labels: z.array(z.string()).default([]),
  assignee: z.string().optional(),
  milestone: z.string().optional(),

  // AI 메타데이터
  relevantFiles: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  estimateMinutes: z.number().optional(),
  complexity: z.enum(['simple', 'moderate', 'complex', 'very_complex']).optional(),

  // 의존성
  dependencies: z.array(z.string()).default([]),  // 선행 이슈 IDs
  parentId: z.string().optional(),                 // 부모 이슈 (서브태스크)
  childIds: z.array(z.string()).default([]),       // 하위 이슈

  // Linear 연동 (optional)
  linearId: z.string().optional(),
  linearIdentifier: z.string().optional(),
  linearUrl: z.string().optional(),

  // 메모리 연동
  memoryIds: z.array(z.string()).default([]),      // 관련 장기 기억 IDs

  // 추적
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().optional(),
});

// 라벨 스키마
export const LabelSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  color: z.string().default('#6B7280'),  // 기본 gray
  description: z.string().optional(),
});

// 마일스톤 스키마
export const MilestoneSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  dueDate: z.string().optional(),
  status: z.enum(['active', 'closed']).default('active'),
  createdAt: z.string(),
});

// 이슈 필터 옵션
export const IssueFilterSchema = z.object({
  projectId: z.string().optional(),
  status: z.array(IssueStatusSchema).optional(),
  priority: z.array(IssuePrioritySchema).optional(),
  labels: z.array(z.string()).optional(),
  assignee: z.string().optional(),
  source: IssueSourceSchema.optional(),
  parentId: z.string().optional(),
  search: z.string().optional(),           // FTS5 전문검색
  limit: z.number().default(50),
  offset: z.number().default(0),
});

// 타입 export
export type IssueStatus = z.infer<typeof IssueStatusSchema>;
export type IssuePriority = z.infer<typeof IssuePrioritySchema>;
export type IssueSource = z.infer<typeof IssueSourceSchema>;
export type IssueEventType = z.infer<typeof IssueEventTypeSchema>;
export type IssueEvent = z.infer<typeof IssueEventSchema>;
export type Issue = z.infer<typeof IssueSchema>;
export type Label = z.infer<typeof LabelSchema>;
export type Milestone = z.infer<typeof MilestoneSchema>;
export type IssueFilter = z.infer<typeof IssueFilterSchema>;
