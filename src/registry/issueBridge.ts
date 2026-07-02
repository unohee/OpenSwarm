// ============================================
// OpenSwarm - Registry ↔ Issue Bridge
// Created: 2026-04-10
// Purpose: 코드 엔티티와 이슈 간 연결 헬퍼
// ============================================

import { getRegistryStore } from './sqliteStore.js';
import type { CodeEntity } from './schema.js';

/**
 * 이슈에 연결된 코드 엔티티 조회
 * - 명시적으로 linkEntityToIssue된 엔티티
 * - issue의 relevantFiles 경로로 해당 파일의 엔티티를 자동 검색
 */
export function getEntitiesForIssue(
  issueId: string,
  relevantFiles?: string[],
  projectId?: string,
): CodeEntity[] {
  const store = getRegistryStore();
  const entityMap = new Map<string, CodeEntity>();

  // 1. 명시적 연결된 엔티티 (정식 store 메서드 사용)
  for (const entity of store.getEntitiesByIssueId(issueId)) {
    entityMap.set(entity.id, entity);
  }

  // 2. relevantFiles 경로로 암시적 연결
  if (relevantFiles) {
    for (const filePath of relevantFiles) {
      const brief = store.fileBrief(filePath, projectId);
      for (const entity of brief.entities) {
        entityMap.set(entity.id, entity);
      }
    }
  }

  return Array.from(entityMap.values());
}
