// ============================================
// OpenSwarm - Issue Tracker GraphQL Server
// Created: 2026-04-03
// Purpose: graphql-yoga 서버, 기존 HTTP 서버에 통합
// ============================================

import { GraphQLError, getOperationAST } from 'graphql';
import { createSchema, createYoga, type Plugin } from 'graphql-yoga';
import { typeDefs } from './typeDefs.js';
import { resolvers } from './resolvers.js';
import { registryTypeDefs } from '../../registry/graphql/typeDefs.js';
import { registryResolvers } from '../../registry/graphql/resolvers.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

const CORS_METHODS = 'GET, POST, OPTIONS';
const CORS_HEADERS = 'Content-Type, Authorization, X-OpenSwarm-GraphQL-Token';

function isAllowedOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  const { protocol, hostname } = url;
  if (protocol !== 'http:' && protocol !== 'https:') return false;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  if (hostname === 'tauri.localhost') return true;

  const tailscaleMatch = hostname.match(/^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!tailscaleMatch) return false;

  const second = Number(tailscaleMatch[1]);
  return second >= 64 && second <= 127;
}

function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', CORS_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  }

  if (req.method !== 'OPTIONS') return false;

  res.writeHead(origin && !isAllowedOrigin(origin) ? 403 : 204);
  res.end();
  return true;
}

function hasValidMutationToken(request: Request): boolean {
  const token = process.env.OPENSWARM_GRAPHQL_TOKEN?.trim();
  if (!token) return false;

  const auth = request.headers.get('authorization') ?? '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const headerToken = request.headers.get('x-openswarm-graphql-token')?.trim();
  return bearer === token || headerToken === token;
}

function isMutationRequestAuthorized(request: Request): boolean {
  if (hasValidMutationToken(request)) return true;

  const origin = request.headers.get('origin');
  return origin ? isAllowedOrigin(origin) : true;
}

const mutationAuthPlugin: Plugin = {
  onExecute({ args, setResultAndStopExecution }) {
    const operation = getOperationAST(args.document, args.operationName);
    if (operation?.operation !== 'mutation') return;
    if (isMutationRequestAuthorized(args.contextValue.request)) return;

    setResultAndStopExecution({
      errors: [
        new GraphQLError('Unauthorized GraphQL mutation', {
          extensions: {
            code: 'UNAUTHORIZED',
            http: { status: 403 },
          },
        }),
      ],
    });
  },
};

// GraphQL Yoga 인스턴스 생성 (이슈 + 코드 레지스트리 스키마 머지)
const yoga = createYoga({
  schema: createSchema({
    typeDefs: [typeDefs, registryTypeDefs],
    resolvers: [resolvers, registryResolvers],
  }),
  graphqlEndpoint: '/graphql',
  cors: false,
  plugins: [mutationAuthPlugin],
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
  if (applyCors(req, res)) return;

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
