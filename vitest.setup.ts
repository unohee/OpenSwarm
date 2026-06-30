// Global test setup (vitest). Keep tests from touching the real home dir.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect chat-session persistence to a temp dir so ChatPanel renders (which
// fire a saveSession effect) never write to the real ~/.openswarm/chat. (INT-2014)
process.env.OPENSWARM_CHAT_DIR = join(tmpdir(), 'openswarm-test-chat');
