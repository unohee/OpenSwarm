/**
 * 장기 기억 모듈 - LanceDB + Ollama 임베딩
 */
import { connect, Table, Connection } from '@lancedb/lancedb';
import { resolve } from 'path';
import { homedir } from 'os';

// 메모리 저장 경로
const MEMORY_DIR = resolve(homedir(), '.claude-swarm/memory');

// Ollama 임베딩 설정
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBEDDING_MODEL = 'nomic-embed-text';
const EMBEDDING_DIM = 768; // nomic-embed-text 차원

// 메모리 항목 인터페이스
interface MemoryRecord {
  [key: string]: unknown;
  id: string;
  channelId: string;
  userId: string;
  userName: string;
  content: string;
  response: string;
  timestamp: number;
  vector: number[];
}

// 검색 결과 인터페이스
export interface MemorySearchResult {
  content: string;
  response: string;
  userName: string;
  timestamp: number;
  score: number;
}

// 싱글톤 연결
let db: Connection | null = null;
let table: Table | null = null;

/**
 * Ollama로 임베딩 생성
 */
async function getEmbedding(text: string): Promise<number[]> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json();

    // Ollama는 embeddings 배열을 반환
    if (data.embeddings && Array.isArray(data.embeddings) && data.embeddings.length > 0) {
      return data.embeddings[0];
    }

    // 또는 embedding 직접 반환
    if (data.embedding && Array.isArray(data.embedding)) {
      return data.embedding;
    }

    throw new Error('Invalid embedding response');
  } catch (error) {
    console.error('[Memory] Embedding error:', error);
    // 임베딩 실패 시 빈 벡터 반환 (검색에서 제외됨)
    return new Array(EMBEDDING_DIM).fill(0);
  }
}

/**
 * 데이터베이스 초기화
 */
async function initDatabase(): Promise<void> {
  if (db && table) return;

  try {
    // 디렉토리 생성
    const fs = await import('fs/promises');
    await fs.mkdir(MEMORY_DIR, { recursive: true });

    // LanceDB 연결
    db = await connect(MEMORY_DIR);

    // 테이블 존재 확인
    const tableNames = await db.tableNames();

    if (tableNames.includes('conversations')) {
      table = await db.openTable('conversations');
      console.log('[Memory] Loaded existing table');
    } else {
      // 새 테이블 생성 (초기 데이터 필요)
      const initialRecord: MemoryRecord = {
        id: 'init',
        channelId: 'init',
        userId: 'system',
        userName: 'System',
        content: 'Memory system initialized',
        response: 'Ready',
        timestamp: Date.now(),
        vector: await getEmbedding('Memory system initialized'),
      };

      table = await db.createTable('conversations', [initialRecord]);
      console.log('[Memory] Created new table');
    }
  } catch (error) {
    console.error('[Memory] Database init error:', error);
    throw error;
  }
}

/**
 * 대화 저장
 */
export async function saveConversation(
  channelId: string,
  userId: string,
  userName: string,
  content: string,
  response: string,
): Promise<void> {
  try {
    await initDatabase();
    if (!table) throw new Error('Table not initialized');

    // 임베딩 생성 (질문 + 응답 결합)
    const combinedText = `Q: ${content}\nA: ${response}`;
    const vector = await getEmbedding(combinedText);

    const record: MemoryRecord = {
      id: `${channelId}-${Date.now()}`,
      channelId,
      userId,
      userName,
      content,
      response,
      timestamp: Date.now(),
      vector,
    };

    await table.add([record]);
    console.log(`[Memory] Saved conversation for channel ${channelId}`);
  } catch (error) {
    console.error('[Memory] Save error:', error);
    // 저장 실패는 무시 (메모리는 선택적 기능)
  }
}

/**
 * 관련 기억 검색
 */
export async function searchMemory(
  query: string,
  channelId?: string,
  limit: number = 5,
): Promise<MemorySearchResult[]> {
  try {
    await initDatabase();
    if (!table) return [];

    // 쿼리 임베딩 생성
    const queryVector = await getEmbedding(query);

    // 벡터 검색
    let search = table.vectorSearch(queryVector).limit(limit * 2); // 필터링 여유분

    const results = await search.toArray();

    // 채널 필터링 및 변환
    const filtered = results
      .filter((r: any) => {
        // init 레코드 제외
        if (r.id === 'init') return false;
        // 채널 필터 (지정된 경우)
        if (channelId && r.channelId !== channelId) return false;
        return true;
      })
      .slice(0, limit)
      .map((r: any) => ({
        content: r.content,
        response: r.response,
        userName: r.userName,
        timestamp: r.timestamp,
        score: r._distance ? 1 - r._distance : 0, // 거리를 유사도로 변환
      }));

    console.log(`[Memory] Found ${filtered.length} relevant memories for query`);
    return filtered;
  } catch (error) {
    console.error('[Memory] Search error:', error);
    return [];
  }
}

/**
 * 채널의 최근 대화 가져오기
 */
export async function getRecentConversations(
  channelId: string,
  limit: number = 10,
): Promise<MemorySearchResult[]> {
  try {
    await initDatabase();
    if (!table) return [];

    // 전체 검색 후 필터링 (LanceDB는 SQL 필터 지원)
    const results = await table
      .search(new Array(EMBEDDING_DIM).fill(0)) // 더미 벡터
      .limit(100)
      .toArray();

    // 채널 필터링 및 정렬
    const filtered = results
      .filter((r: any) => r.channelId === channelId && r.id !== 'init')
      .sort((a: any, b: any) => b.timestamp - a.timestamp)
      .slice(0, limit)
      .map((r: any) => ({
        content: r.content,
        response: r.response,
        userName: r.userName,
        timestamp: r.timestamp,
        score: 1,
      }));

    return filtered;
  } catch (error) {
    console.error('[Memory] Get recent error:', error);
    return [];
  }
}

/**
 * 메모리를 컨텍스트 문자열로 변환
 */
export function formatMemoryContext(memories: MemorySearchResult[]): string {
  if (memories.length === 0) return '';

  const formatted = memories
    .map((m, i) => {
      const date = new Date(m.timestamp).toLocaleDateString('ko-KR');
      return `[${date}] ${m.userName}: ${m.content}\n→ ${m.response.slice(0, 200)}${m.response.length > 200 ? '...' : ''}`;
    })
    .join('\n\n');

  return `## 관련 이전 대화\n${formatted}`;
}

/**
 * 메모리 통계
 */
export async function getMemoryStats(): Promise<{ totalRecords: number; channels: string[] }> {
  try {
    await initDatabase();
    if (!table) return { totalRecords: 0, channels: [] };

    const results = await table
      .search(new Array(EMBEDDING_DIM).fill(0))
      .limit(10000)
      .toArray();

    const channels = [...new Set(results.map((r: any) => r.channelId).filter((c: string) => c !== 'init'))];

    return {
      totalRecords: results.filter((r: any) => r.id !== 'init').length,
      channels,
    };
  } catch (error) {
    console.error('[Memory] Stats error:', error);
    return { totalRecords: 0, channels: [] };
  }
}
