// ============================================
// OpenSwarm - CLI Stream Parser
// Claude CLI --output-format stream-json parsing utility
// ============================================

/**
 * Extract assistant text from Claude CLI --output-format stream-json stdout and invoke onLog.
 * stream-json is streamed as NDJSON (line-delimited JSON objects).
 *
 * Since chunk boundaries may split a line in the middle, the incomplete last line
 * is returned so it can be prepended to the next chunk.
 */
export function parseCliStreamChunk(
  text: string,
  onLog: (line: string) => void,
  buffer: string = '',
): string {
  const combined = buffer + text;
  const lines = combined.split('\n');
  // Preserve the last line as it may be incomplete
  const remainder = lines.pop() ?? '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    processNdjsonLine(trimmed, onLog);
  }

  return remainder;
}

/**
 * Parse a single NDJSON line and extract assistant text.
 * Inserts empty lines (spacers) and paragraph markers for line separation.
 */
function processNdjsonLine(line: string, onLog: (text: string) => void): void {
  try {
    const event = JSON.parse(line);

    // Extract text blocks from assistant message
    if (event.type === 'assistant' && event.message?.content) {
      // New assistant turn start — separator
      onLog('───');

      for (const block of event.message.content) {
        if (block.type === 'text' && block.text?.trim()) {
          emitFormattedText(block.text, onLog);
        }
        // Show tool_use blocks briefly
        if (block.type === 'tool_use' && block.name) {
          const input = summarizeToolInput(block.name, block.input);
          onLog(`▸ ${block.name}${input ? '  ' + input : ''}`);
        }
      }
    }
  } catch {
    // Invalid JSON (partial chunk) — ignore
  }
}

/**
 * Format assistant text for readability and pass to onLog.
 * - Empty lines are converted to spacers (paragraph breaks)
 * - Markdown headers (##) get emphasis markers
 * - Code blocks (```) are marked with start/end indicators
 * - Long lines are truncated at 300 characters
 */
function emitFormattedText(text: string, onLog: (line: string) => void): void {
  const lines = text.split('\n');
  let inCodeBlock = false;
  let prevWasEmpty = false;

  for (const raw of lines) {
    const trimmed = raw.trim();

    // Code block toggle
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      onLog(inCodeBlock ? '┌─ code ─' : '└────────');
      prevWasEmpty = false;
      continue;
    }

    // Empty line → paragraph break (prevent consecutive empty lines)
    if (!trimmed) {
      if (!prevWasEmpty) {
        onLog('');
        prevWasEmpty = true;
      }
      continue;
    }
    prevWasEmpty = false;

    // Inside code block — pass through as-is
    if (inCodeBlock) {
      onLog('│ ' + truncate(raw, 300));
      continue;
    }

    // Markdown header
    const headerMatch = trimmed.match(/^(#{1,4})\s+(.+)/);
    if (headerMatch) {
      onLog('');
      onLog('■ ' + headerMatch[2]);
      continue;
    }

    // List item (-, *, 1.)
    if (/^[-*]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
      onLog('  ' + truncate(trimmed, 300));
      continue;
    }

    // Plain text
    onLog(truncate(trimmed, 300));
  }
}

/**
 * Summarize tool_use input
 */
function summarizeToolInput(name: string, input: any): string {
  if (!input) return '';
  // File-related tools: show path only
  if (input.file_path) return input.file_path;
  if (input.path) return input.path;
  if (input.command) return truncate(input.command, 80);
  if (input.pattern) return `"${truncate(input.pattern, 60)}"`;
  if (input.query) return `"${truncate(input.query, 60)}"`;
  // Other tools: show keys only
  const keys = Object.keys(input);
  if (keys.length <= 3) return keys.join(', ');
  return keys.slice(0, 3).join(', ') + '...';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/**
 * Extract result text from the result entry in full NDJSON stdout (for final parsing).
 * Used by parseWorkerOutput and similar functions.
 */
export function extractResultFromStreamJson(stdout: string): string | null {
  const lines = stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event.type === 'result' && event.result) {
        return event.result;
      }
    } catch {
      // skip
    }
  }
  return null;
}

/**
 * Backward compatible: parseCliOutput (simple version without buffer)
 */
export function parseCliOutput(text: string, onLog: (line: string) => void): void {
  parseCliStreamChunk(text, onLog);
}
