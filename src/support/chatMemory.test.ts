import { describe, expect, it, vi } from 'vitest';

const getRecentConversations = vi.hoisted(() => vi.fn());
vi.mock('../memory/index.js', () => ({
  getRecentConversations,
  logWork: vi.fn(),
  searchMemorySafe: vi.fn(),
}));

import { getRecentChatHistory } from './chatMemory.js';

describe('getRecentChatHistory', () => {
  it('uses chronological storage retrieval instead of semantic search', async () => {
    const rows = [{ id: 'newest', createdAt: 3 }, { id: 'older', createdAt: 2 }];
    getRecentConversations.mockResolvedValue(rows);
    await expect(getRecentChatHistory('channel-1', 2)).resolves.toBe(rows);
    expect(getRecentConversations).toHaveBeenCalledWith('channel-1', 2);
  });
});
