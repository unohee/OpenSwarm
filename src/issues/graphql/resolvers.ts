// ============================================
// OpenSwarm - Issue Tracker GraphQL Resolvers
// Created: 2026-04-03
// Purpose: Query + Mutation 리졸버
// ============================================

import { getIssueStore } from '../sqliteStore.js';
import { autoLinkMemories, enrichIssueContext } from '../memoryBridge.js';
import type { IssueFilter } from '../schema.js';

export const resolvers = {
  Query: {
    issue: (_: unknown, { id }: { id: string }) => {
      return getIssueStore().getIssue(id);
    },

    issues: (_: unknown, { filter }: { filter?: IssueFilter }) => {
      return getIssueStore().listIssues(filter);
    },

    labels: () => getIssueStore().listLabels(),
    milestones: () => getIssueStore().listMilestones(),

    issueEvents: (_: unknown, { issueId, limit }: { issueId: string; limit?: number }) => {
      return getIssueStore().getEvents(issueId, limit);
    },

    recentEvents: (_: unknown, { limit }: { limit?: number }) => {
      return getIssueStore().getRecentEvents(limit);
    },

    issueStats: (_: unknown, { projectId }: { projectId?: string }) => {
      const stats = getIssueStore().getStats(projectId);
      return {
        ...stats,
        byStatus: Object.entries(stats.byStatus).map(([status, count]) => ({ status, count })),
        byPriority: Object.entries(stats.byPriority).map(([priority, count]) => ({ priority, count })),
        byProject: Object.entries(stats.byProject).map(([projectId, count]) => ({ projectId, count })),
      };
    },

    linkedMemories: (_: unknown, { issueId }: { issueId: string }) => {
      return getIssueStore().getLinkedMemories(issueId);
    },

    issueContext: async (_: unknown, { issueId }: { issueId: string }) => {
      const store = getIssueStore();
      const issue = store.getIssue(issueId);
      if (!issue) throw new Error(`Issue ${issueId} not found`);
      return enrichIssueContext(store, issue);
    },
  },

  Mutation: {
    createIssue: async (_: unknown, { input }: { input: any }) => {
      const store = getIssueStore();
      const issue = store.createIssue(input);

      // 비동기로 메모리 자동 연결 (실패해도 이슈 생성은 성공)
      autoLinkMemories(store, issue).catch((err) => {
        console.warn('[GraphQL] 메모리 자동 연결 실패:', err);
      });

      return issue;
    },

    updateIssue: (_: unknown, { id, input }: { id: string; input: any }) => {
      return getIssueStore().updateIssue(id, input);
    },

    deleteIssue: (_: unknown, { id }: { id: string }) => {
      return getIssueStore().deleteIssue(id);
    },

    changeIssueStatus: (_: unknown, { id, status, actor }: { id: string; status: any; actor?: string }) => {
      return getIssueStore().changeStatus(id, status, actor);
    },

    addComment: (_: unknown, { issueId, content, actor }: { issueId: string; content: string; actor?: string }) => {
      return getIssueStore().addEvent(issueId, 'commented', { content, actor });
    },

    createLabel: (_: unknown, { name, color, description }: { name: string; color?: string; description?: string }) => {
      return getIssueStore().createLabel(name, color ?? undefined, description ?? undefined);
    },

    deleteLabel: (_: unknown, { id }: { id: string }) => {
      return getIssueStore().deleteLabel(id);
    },

    createMilestone: (_: unknown, { name, description, dueDate }: { name: string; description?: string; dueDate?: string }) => {
      return getIssueStore().createMilestone(name, description ?? undefined, dueDate ?? undefined);
    },

    linkMemory: (_: unknown, { issueId, memoryId }: { issueId: string; memoryId: string }) => {
      getIssueStore().linkMemory(issueId, memoryId);
      return true;
    },

    autoLinkMemories: async (_: unknown, { issueId }: { issueId: string }) => {
      const store = getIssueStore();
      const issue = store.getIssue(issueId);
      if (!issue) throw new Error(`Issue ${issueId} not found`);
      return autoLinkMemories(store, issue);
    },
  },
};
