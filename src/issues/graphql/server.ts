// ============================================
// OpenSwarm - Issue Tracker GraphQL Server
// Created: 2026-04-03
// Purpose: graphql-yoga 서버, 기존 HTTP 서버에 통합
// ============================================

import { createSchema, createYoga } from 'graphql-yoga';
import { typeDefs } from './typeDefs.js';
import { resolvers } from './resolvers.js';
import { registryTypeDefs } from '../../registry/graphql/typeDefs.js';
import { registryResolvers } from '../../registry/graphql/resolvers.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

// GraphQL Yoga 인스턴스 생성 (이슈 + 코드 레지스트리 스키마 머지)
const yoga = createYoga({
  schema: createSchema({
    typeDefs: [typeDefs, registryTypeDefs],
    resolvers: [resolvers, registryResolvers],
  }),
  graphqlEndpoint: '/graphql',
  // CORS 허용 (대시보드에서 접근)
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
  },
  logging: {
    debug: () => {},
    info: (...args: any[]) => console.log('[GraphQL]', ...args),
    warn: (...args: any[]) => console.warn('[GraphQL]', ...args),
    error: (...args: any[]) => console.error('[GraphQL]', ...args),
  },
});

/**
 * 기존 웹서버의 요청 핸들러에서 /graphql 경로를 이 함수로 위임
 * graphql-yoga의 Node.js HTTP adapter 패턴 사용
 */
export async function handleGraphQL(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // graphql-yoga는 Node.js HTTP 서버에서 req, res를 직접 처리
  // handle() 호출 시 내부적으로 res에 응답을 작성
  const response = await yoga.handle(req, res) as unknown;

  // yoga가 Response 객체를 반환하는 경우 수동 처리
  if (response && typeof response === 'object' && 'status' in response) {
    const r = response as Response;
    res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
    const body = await r.text();
    res.end(body);
  }
  // 그렇지 않으면 yoga가 이미 res에 직접 응답 완료
}

/**
 * GraphQL 경로 매칭 여부
 */
export function isGraphQLRequest(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith('/graphql');
}

export { yoga };
