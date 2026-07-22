import { resetTaskStateStoreForTests, upsertTaskState } from './store.js';

const [stateFile, issueId, delayText = '0'] = process.argv.slice(2);
if (!stateFile || !issueId) throw new Error('state file and issue id are required');
process.env.OPENSWARM_TASK_STATE_FILE = stateFile;
resetTaskStateStoreForTests();
await new Promise((resolve) => setTimeout(resolve, Number(delayText)));
upsertTaskState(issueId, { title: issueId });
