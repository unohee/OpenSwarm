// ============================================
// OpenSwarm - Registry ↔ Memory Bridge
// Created: 2026-04-10
// Purpose: 코드 엔티티 이벤트를 장기 기억으로 연동
// Dependencies: memoryCore
// ============================================

import { saveMemory } from '../memory/memoryCore.js';
import type { CodeEntity, EntityWarning } from './schema.js';

/**
 * 엔티티 deprecated 시 장기기억 저장
 * - "X 함수는 Y 이유로 deprecated됨" 기억 저장
 * - 향후 에이전트가 해당 함수를 수정하려 할 때 참조
 */
export async function onEntityDeprecated(entity: CodeEntity): Promise<void> {
  const reason = entity.deprecatedReason ?? '사유 미기재';
  const content = [
    `[코드 레지스트리] ${entity.kind} "${entity.name}" deprecated`,
    `파일: ${entity.filePath}`,
    `정규명: ${entity.qualifiedName}`,
    `사유: ${reason}`,
    entity.notes ? `메모: ${entity.notes}` : null,
  ].filter(Boolean).join('\n');

  await saveMemory(
    'decision',
    entity.projectId,
    `${entity.kind} ${entity.name} deprecated`,
    content,
    {
      importance: 0.7,
      confidence: 0.9,
      derivedFrom: `registry:${entity.id}`,
      metadata: {
        registryEntityId: entity.id,
        qualifiedName: entity.qualifiedName,
        filePath: entity.filePath,
      },
    },
  );

  console.log(`[RegistryMemory] ${entity.qualifiedName} deprecated → 기억 저장`);
}

/**
 * 보안/critical 경고 발생 시 장기기억 저장
 * - critical/error 수준 경고만 기억에 남김
 */
export async function onEntityWarningAdded(
  entity: CodeEntity,
  warning: EntityWarning,
): Promise<void> {
  if (warning.severity !== 'critical' && warning.severity !== 'error') return;

  const content = [
    `[코드 레지스트리] ${warning.severity} 경고: ${entity.kind} "${entity.name}"`,
    `카테고리: ${warning.category}`,
    `메시지: ${warning.message}`,
    `파일: ${entity.filePath}`,
    `정규명: ${entity.qualifiedName}`,
  ].join('\n');

  await saveMemory(
    'constraint',
    entity.projectId,
    `${warning.category} ${warning.severity}: ${entity.name}`,
    content,
    {
      importance: warning.severity === 'critical' ? 0.9 : 0.7,
      confidence: 0.8,
      derivedFrom: `registry:${entity.id}:warning:${warning.id}`,
      metadata: {
        registryEntityId: entity.id,
        warningId: warning.id,
        warningCategory: warning.category,
      },
    },
  );

  console.log(`[RegistryMemory] ${entity.qualifiedName} ${warning.severity} 경고 → 기억 저장`);
}
