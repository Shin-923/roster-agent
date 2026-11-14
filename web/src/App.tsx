import { useEffect, useState } from "react";

type LogEntry =
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; input: unknown; ok: boolean; output: unknown }
  | { kind: "approval"; summary: string; decision?: "approved" | "rejected" };

type View = {
  id: string;
  mode: "live" | "replay";
  filename: string;
  columns: string[];
  rowCount: number;
  status: "idle" | "running" | "awaiting_approval" | "done" | "error";
  error?: string;
  log: LogEntry[];
  pending: { name: string; input: { summary?: string } } | null;
  fixes: { row: number; field: string; value: string; reason: string }[];
  skips: { row: number; reason: string }[];
  appliedBatchId: string | null;
};

type Participant = { id: number; name: string; email: string; phone: string; language: string; batchId: string };
type Change = { id: number; batchId: string; row: number; kind: "fix" | "normalize" | "skip"; field: string | null; before: string | null; after: string | null; reason: string };

const KIND_LABEL: Record<Change["kind"], string> = { fix: "수정", normalize: "형식 맞춤", skip: "제외" };

const TOOL_LABEL: Record<string, string> = {
  inspect_sheet: "명단 살펴보기",
  set_column_mapping: "칸 지정",
  validate_rows: "형식 검사",
  find_duplicates: "중복 찾기",
  propose_fix: "수정안 기록",
  propose_skip: "제외 기록",
  apply_to_db: "DB 반영",
};

const STATUS_LABEL: Record<View["status"], string> = {
  idle: "대기",
  running: "에이전트 작업 중",
  awaiting_approval: "승인 대기",
  done: "완료",
  error: "오류",
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? body.error ?? `요청 실패 (${res.status})`);
  return body as T;
}

function summarize(e: Extract<LogEntry, { kind: "tool" }>): string {
  const o = e.output as Record<string, unknown> | string | unknown[];
  if (!e.ok) return typeof o === "string" ? o : "실패";
  if (e.name === "validate_rows" && o && typeof o === "object" && "issues" in o) {
    const issues = (o as { issues: { suggestion?: string }[] }).issues;
    const fmt = issues.filter((i) => i.suggestion).length;
    return `문제 ${issues.length - fmt}건${fmt ? ` · 저장 때 형식 맞춤 ${fmt}건` : ""}`;
  }
  if (e.name === "find_duplicates" && Array.isArray(o)) return `중복 묶음 ${o.length}개`;
  if (e.name === "inspect_sheet" && o && typeof o === "object" && "rowCount" in o) return `${(o as { rowCount: number }).rowCount}행`;
  if (e.name === "apply_to_db" && o && typeof o === "object" && "inserted" in o) return `${(o as { inserted: number }).inserted}건 저장`;
  if (e.name === "propose_fix" || e.name === "propose_skip") {
    const i = e.input as { row: number; reason: string };
    return `${i.row}행 — ${i.reason}`;
  }
  return typeof o === "string" ? o : "완료";
}

export function App() {
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState<Participant[]>([]);
  const [log, setLog] = useState<Change[]>([]);

  async function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const refreshDb = () =>
    Promise.all([api<Participant[]>("/api/participants").then(setRows), api<Change[]>("/api/changes").then(setLog)]);

  // 세션을 열면 서버가 밀어 주는 진행 상황(SSE)을 받는다. 도구를 하나 쓸 때마다 화면이 바뀐다.
  const sessionId = view?.id;
  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/api/sessions/${sessionId}/events`);
    es.onmessage = (e) => {
      const v = JSON.parse(e.data) as View;
      setView(v);
      if (v.status === "done") refreshDb();
    };
    return () => es.close();
  }, [sessionId]);

  useEffect(() => {
    refreshDb().catch(() => {});
  }, []);

  async function upload(file: File) {
    const fd = new FormData();
    fd.append("file", file);
    await run(async () => setView(await api<View>("/api/upload", { method: "POST", body: fd })));
  }

  const startAgent = () =>
    run(async () => setView(await api<View>(`/api/sessions/${view!.id}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })));

  const decide = (approved: boolean) =>
    run(async () => {
      setView(await api<View>(`/api/sessions/${view!.id}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved }) }));
    });

  const undo = (batchId: string) =>
    run(async () => {
      await api(`/api/batches/${batchId}`, { method: "DELETE" });
      await refreshDb();
    });

  const batches = [...new Set(rows.map((r) => r.batchId))];

  return (
    <main>
      <header>
        <h1>명단 검수 에이전트</h1>
        <p>엑셀 명단을 올리면 AI 가 도구를 골라 검사하고, 사람이 승인해야만 DB 에 반영합니다.</p>
      </header>

      <section className="panel">
        <h2>1. 명단 올리기</h2>
        <label className="file">
          <input type="file" accept=".xlsx,.csv" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <span>xlsx · csv 파일 선택</span>
        </label>
        {view && (
          <p className="meta">
            {view.filename} · {view.rowCount}행 · 칸: {view.columns.join(", ")}
          </p>
        )}
      </section>

      {view && (
        <section className="panel">
          <div className="row">
            <h2>2. 에이전트 실행</h2>
            {view.mode === "replay" && <span className="status">재생 모드 · API 키 없음 · sample.csv 전용</span>}
            <span className={`status ${view.status}`}>{busy ? "처리 중…" : STATUS_LABEL[view.status]}</span>
          </div>
          {view.status === "idle" && (
            <button className="primary" disabled={busy} onClick={startAgent}>
              검증 시작
            </button>
          )}

          <ol className="log" aria-live="polite">
            {view.log.map((e, i) =>
              e.kind === "assistant" ? (
                <li key={i} className="say">{e.text}</li>
              ) : e.kind === "tool" ? (
                <li key={i} className={e.ok ? "tool" : "tool fail"}>
                  <b>{TOOL_LABEL[e.name] ?? e.name}</b>
                  <span>{summarize(e)}</span>
                </li>
              ) : (
                <li key={i} className="gate">
                  <b>DB 반영 요청</b>
                  <span>{e.summary}</span>
                  {e.decision && <em>{e.decision === "approved" ? "승인함" : "거절함"}</em>}
                </li>
              ),
            )}
          </ol>

          {view.status === "awaiting_approval" && view.pending && (
            <div className="approve">
              <p>
                <b>에이전트가 DB 반영을 요청했습니다.</b> {view.pending.input.summary}
              </p>
              <p className="meta">
                수정 {view.fixes.length}건 · 제외 {view.skips.length}건 — 승인해도 서버가 남은 문제를 다시 검사한 뒤에만 저장합니다.
              </p>
              <div className="buttons">
                <button className="primary" disabled={busy} onClick={() => decide(true)}>승인하고 반영</button>
                <button disabled={busy} onClick={() => decide(false)}>거절</button>
              </div>
            </div>
          )}
          {view.error && <p className="error">{view.error}</p>}

          {(view.fixes.length > 0 || view.skips.length > 0) && (
            <div className="changes">
              <h3>수정안 · 제외</h3>
              <ul>
                {view.fixes.map((f) => (
                  <li key={`f${f.row}${f.field}`}>{f.row}행 {f.field} → <code>{f.value}</code> ({f.reason})</li>
                ))}
                {view.skips.map((s) => (
                  <li key={`s${s.row}`}>{s.row}행 제외 ({s.reason})</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {rows.length > 0 && (
        <section className="panel">
          <h2>3. DB 에 저장된 명단</h2>
          <div className="table">
            <table>
              <thead>
                <tr><th>이름</th><th>이메일</th><th>휴대폰</th><th>언어</th><th>배치</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}><td>{r.name}</td><td>{r.email}</td><td>{r.phone}</td><td>{r.language}</td><td>{r.batchId}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {log.length > 0 && (
        <section className="panel">
          <h2>4. 변경 이력</h2>
          <p className="meta">원본에서 무엇을 바꾸고 뺐는지 반영할 때 함께 저장됩니다.</p>
          <div className="table">
            <table>
              <thead>
                <tr><th>배치</th><th>행</th><th>종류</th><th>칸</th><th>원본</th><th>저장값</th><th>사유</th></tr>
              </thead>
              <tbody>
                {log.map((c) => (
                  <tr key={c.id}><td>{c.batchId}</td><td>{c.row}</td><td>{KIND_LABEL[c.kind]}</td><td>{c.field ?? ""}</td><td>{c.before ?? ""}</td><td>{c.after ?? ""}</td><td>{c.reason}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="buttons">
            {batches.map((b) => (
              <button key={b} disabled={busy} onClick={() => undo(b)}>배치 {b} 되돌리기</button>
            ))}
          </div>
        </section>
      )}

      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}
