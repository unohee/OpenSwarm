/**
 * Persistent Cognitive Memory Module v3.0
 *
 * Barrel re-export: preserves existing import paths
 * - memoryCore.ts: lean types, embedding, distillation, DB, save, search
 * - memoryOps.ts: formatting, maintenance, stats, legacy
 * - compaction.ts: memory table compaction and cleanup
 */
export * from './codex.js';
export * from './memoryCore.js';
export * from './memoryOps.js';
export * from './compaction.js';
