import Anthropic from "@anthropic-ai/sdk";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { decide, newState, start, type AgentState, type LlmClient } from "./agent.js";
import { changes, openDb, participants, rollbackBatch } from "./db.js";
import { replayClient } from "./replay.js";
import { readSheet } from "./sheet.js";
import type { SessionData } from "./tools.js";

try { process.loadEnvFile(".env"); } catch { /* .env 가 없으면 환경변수만 쓴다 */ }

const db = openDb();
const app = Fastify({ logger: { level: "info" } });
await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

// ponytail: 세션은 메모리에만 둔다. 서버를 다시 켜면 진행 중인 검수는 사라진다(데모 범위). 여러 서버로 늘릴 때는 DB/Redis 로 옮길 것.
const sessions = new Map<string, { data: SessionData; state: AgentState; filename: string; watchers: Set<(v: string) => void> }>();

// 키가 없으면 재생 모드(정해진 순서로 도구를 부르는 가짜 모델, data/sample.csv 전용)로 돈다. 화면에 표시된다.
const MODE = process.env.ANTHROPIC_API_KEY ? "live" : "replay";
let client: LlmClient | undefined;
const llm = () => (client ??= MODE === "live" ? new Anthropic() : replayClient());

function view(id: string) {
  const s = sessions.get(id)!;
  return {
    id,
    mode: MODE,
    filename: s.filename,
    columns: s.data.sheet.columns,
    rowCount: s.data.sheet.rows.length,
    status: s.state.status,
    error: s.state.error,
    log: s.state.log,
    pending: s.state.pending ? { name: s.state.pending.name, input: s.state.pending.input } : null,
    fixes: [...s.data.fixes.values()],
    skips: [...s.data.skips].map(([row, reason]) => ({ row, reason })),
    appliedBatchId: s.data.appliedBatchId ?? null,
  };
}

function session(id: string) {
  const s = sessions.get(id);
  if (!s) throw Object.assign(new Error("세션이 없습니다."), { statusCode: 404 });
  return s;
}

app.post("/api/upload", async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: "파일이 없습니다." });
  if (!/\.(xlsx|csv)$/i.test(file.filename)) return reply.code(400).send({ error: "xlsx 또는 csv 만 받습니다." });
  const sheet = await readSheet(await file.toBuffer(), file.filename);
  if (!sheet.rows.length) return reply.code(400).send({ error: "데이터 행이 없습니다." });
  const id = randomUUID().slice(0, 8);
  const state = newState();
  const watchers = new Set<(v: string) => void>();
  // 에이전트 상태가 바뀔 때마다 이 세션을 보고 있는 화면들에 새 상태를 밀어 준다(SSE).
  state.onChange = () => {
    const v = JSON.stringify(view(id));
    for (const send of watchers) send(v);
  };
  sessions.set(id, { data: { sheet, fixes: new Map(), skips: new Map() }, state, filename: file.filename, watchers });
  return view(id);
});

// 실행 · 승인은 바로 응답하고 에이전트는 뒤에서 돈다. 진행 상황은 /events(SSE)로 받는다.
// start · decide 는 오류를 상태(status: error)로 남기므로 여기서 기다리지 않는다.
app.post<{ Params: { id: string }; Body: { request?: string } }>("/api/sessions/:id/run", async (req) => {
  const s = session(req.params.id);
  if (s.state.status !== "idle") throw Object.assign(new Error("이미 실행했습니다. 파일을 다시 올려 주세요."), { statusCode: 409 });
  void start(llm(), s.state, s.data, req.body?.request || "이 명단을 검증하고, 문제를 정리한 뒤 DB 에 반영해 줘.", db);
  return view(req.params.id);
});

app.post<{ Params: { id: string }; Body: { approved: boolean } }>("/api/sessions/:id/decision", async (req) => {
  const s = session(req.params.id);
  if (s.state.status !== "awaiting_approval") throw Object.assign(new Error("승인 대기 중인 작업이 없습니다."), { statusCode: 409 });
  void decide(llm(), s.state, s.data, req.body?.approved === true, db);
  return view(req.params.id);
});

app.get<{ Params: { id: string } }>("/api/sessions/:id/events", (req, reply) => {
  const s = session(req.params.id);
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (v: string) => reply.raw.write(`data: ${v}

`);
  send(JSON.stringify(view(req.params.id)));
  s.watchers.add(send);
  req.raw.on("close", () => s.watchers.delete(send));
});

app.get<{ Params: { id: string } }>("/api/sessions/:id", async (req) => (session(req.params.id), view(req.params.id)));

app.get("/api/participants", async () => db.select().from(participants).all());

app.get("/api/changes", async () => db.select().from(changes).all());

// 되돌리기는 사람만 한다. 모델 도구 목록에는 넣지 않았다.
app.delete<{ Params: { batchId: string } }>("/api/batches/:batchId", async (req) => ({ removed: rollbackBatch(db, req.params.batchId) }));

await app.listen({ port: Number(process.env.PORT ?? 3001), host: "127.0.0.1" });
