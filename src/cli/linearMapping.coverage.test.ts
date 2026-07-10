// Coverage for pickAndSaveLinearMapping — the interactive team/project picker.
// linearMapping.test.ts already covers resolveLinearCredential; this file adds
// the picker flow (teams/projects fetch, inquirer select, saveRepoMetadata),
// mocking each dependency at its narrowest boundary.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const selectMock = vi.fn();
vi.mock('@inquirer/prompts', () => ({
  select: (...args: unknown[]) => selectMock(...args),
}));

const listTeamsMock = vi.fn();
const listProjectsMock = vi.fn();
vi.mock('../linear/index.js', () => ({
  listTeams: (...args: unknown[]) => listTeamsMock(...args),
  listProjects: (...args: unknown[]) => listProjectsMock(...args),
}));

const saveRepoMetadataMock = vi.fn();
vi.mock('../support/repoMetadata.js', () => ({
  saveRepoMetadata: (...args: unknown[]) => saveRepoMetadataMock(...args),
}));

const { pickAndSaveLinearMapping } = await import('./linearMapping.js');

describe('pickAndSaveLinearMapping', () => {
  const cred = { apiKey: 'test-key' };
  const repoPath = '/repos/demo-repo';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('returns no-teams when listTeams throws', async () => {
    listTeamsMock.mockRejectedValue(new Error('network down'));
    const result = await pickAndSaveLinearMapping(repoPath, cred);
    expect(result).toEqual({ kind: 'no-teams' });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('returns no-teams when the org has no teams', async () => {
    listTeamsMock.mockResolvedValue([]);
    const result = await pickAndSaveLinearMapping(repoPath, cred);
    expect(result).toEqual({ kind: 'no-teams' });
  });

  it('returns skipped when listProjects throws after a team is picked', async () => {
    listTeamsMock.mockResolvedValue([{ id: 'team-1', key: 'ENG', name: 'Engineering' }]);
    selectMock.mockResolvedValueOnce('team-1');
    listProjectsMock.mockRejectedValue(new Error('projects unavailable'));

    const result = await pickAndSaveLinearMapping(repoPath, cred);
    expect(result).toEqual({ kind: 'skipped', teamId: 'team-1' });
    expect(listProjectsMock).toHaveBeenCalledWith('team-1', cred);
  });

  it('returns skipped when the picked team has no projects', async () => {
    listTeamsMock.mockResolvedValue([{ id: 'team-1', key: 'ENG', name: 'Engineering' }]);
    selectMock.mockResolvedValueOnce('team-1');
    listProjectsMock.mockResolvedValue([]);

    const result = await pickAndSaveLinearMapping(repoPath, cred);
    expect(result).toEqual({ kind: 'skipped', teamId: 'team-1' });
  });

  it('returns skipped when the user picks the "(skip)" project option', async () => {
    listTeamsMock.mockResolvedValue([{ id: 'team-1', key: 'ENG', name: 'Engineering' }]);
    listProjectsMock.mockResolvedValue([{ id: 'proj-1', name: 'VEGA' }]);
    selectMock.mockResolvedValueOnce('team-1').mockResolvedValueOnce('');

    const result = await pickAndSaveLinearMapping(repoPath, cred);
    expect(result).toEqual({ kind: 'skipped', teamId: 'team-1' });
    expect(saveRepoMetadataMock).not.toHaveBeenCalled();
  });

  it('saves the mapping and returns "saved" on full success', async () => {
    listTeamsMock.mockResolvedValue([{ id: 'team-1', key: 'ENG', name: 'Engineering' }]);
    listProjectsMock.mockResolvedValue([{ id: 'proj-1', name: 'VEGA' }]);
    selectMock.mockResolvedValueOnce('team-1').mockResolvedValueOnce('proj-1');
    saveRepoMetadataMock.mockResolvedValue('/repos/demo-repo/openswarm.json');

    const result = await pickAndSaveLinearMapping(repoPath, cred);

    expect(result).toEqual({
      kind: 'saved',
      teamId: 'team-1',
      mapping: { teamId: 'team-1', teamKey: 'ENG', projectId: 'proj-1', projectName: 'VEGA' },
    });
    expect(saveRepoMetadataMock).toHaveBeenCalledWith(repoPath, {
      schemaVersion: 1,
      projectName: 'VEGA',
      linear: { teamId: 'team-1', teamKey: 'ENG', projectId: 'proj-1', projectName: 'VEGA' },
    });
    // repoName (basename of repoPath) drives the prompt copy — verify it's used.
    expect(selectMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      message: expect.stringContaining('demo-repo'),
    }));
  });
});
