import type {
  BetaMessage,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Db } from "./db.js";
import { runTool, toolDefs, WRITE_TOOLS, type SessionData } from "./tools.js";

type Msg = BetaMessageParam;
type ToolResult = BetaToolResultBlockParam;

export type LogEntry =
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; input: unknown; ok: boolean; output: unknown }
  | { kind: "approval"; summary: string; decision?: "approved" | "rejected" };

export type AgentState = {
  status: "idle" | "running" | "awaiting_approval" | "done" | "error";
  messages: Msg[];
  log: LogEntry[];
  /** 승인 대기 중인 쓰기 도구 호출과, 같은 턴에서 이미 실행된 다른 도구 결과 */
  pending?: { toolUseId: string; name: string; input: Record<string, unknown>; partial: ToolResult[] };
  error?: string;
  /** 상태가 바뀔 때마다 부른다(서버가 화면에 실시간으로 밀어 주는 데 쓴다). */
  onChange?: () => void;
};

/** 테스트에서 가짜 클라이언트를 넣을 수 있게 필요한 메서드만 요구한다. */
export type LlmClient = { beta: { messages: { create: (p: MessageCreateParamsNonStreaming) => Promise<BetaMessage> } } };

export const MODEL = "claude-opus-5-5";
const MAX_TURNS = 25; // 모델이 같은 도구를 끝없이 부르는 경우를 막는 상한

const SYSTEM = `너는 행사 참가자 명단을 검수하는 운영 담당자다.
목표: 업로드된 명단을 검사하고, 근거가 분명한 것만 고치고, 고칠 수 없는 행은 빼서, 문제가 0건인 명단을 DB에 반영한다.
규칙:
- 도구가 돌려준 결과만 사실로 쓴다. 이메일 · 번호 · 이름을 추측으로 만들어 내지 않는다.
- 휴대폰 형식 차이(suggestion 이 있는 경우)는 저장 때 자동으로 맞춰지므로 따로 고치지 않아도 된다.
- 중복이면 먼저 나온 행을 남기고 나중 행을 propose_skip 한다.
- 필수값이 없거나 형식이 틀렸는데 근거 있는 수정값이 없으면 propose_skip 한다.
- 수정 · 제외 뒤에는 validate_rows 를 다시 불러 문제가 0건인지 확인한 다음에만 apply_to_db 를 호출한다.
- 끝나면 한국어로 3줄 이내로 결과를 요약한다.`;

export function newState(): AgentState {
  return { status: "idle", messages: [], log: [] };
}

/** 사용자의 요청으로 에이전트를 시작한다. */
export async function start(client: LlmClient, st: AgentState, s: SessionData, request: string, db?: Db) {
  st.messages = [{ role: "user", content: request }];
  st.log = [];
  return loop(client, st, s, db);
}

/** 승인 대기 중인 쓰기 도구를 사람이 승인 · 거절한 뒤 이어서 진행한다. */
export async function decide(client: LlmClient, st: AgentState, s: SessionData, approved: boolean, db?: Db) {
  const p = st.pending;
  if (st.status !== "awaiting_approval" || !p) throw new Error("승인 대기 중인 작업이 없습니다.");
  const approval = [...st.log].reverse().find((l) => l.kind === "approval");
  if (approval && approval.kind === "approval") approval.decision = approved ? "approved" : "rejected";

  let result: ToolResult;
  if (approved) {
    const out = runTool(p.name, p.input, s, db);
    st.log.push({ kind: "tool", name: p.name, input: p.input, ok: out.ok, output: out.data });
    result = { type: "tool_result", tool_use_id: p.toolUseId, content: JSON.stringify(out.data), is_error: !out.ok };
  } else {
    result = { type: "tool_result", tool_use_id: p.toolUseId, content: "사람이 반영을 거절했습니다. DB 에는 쓰지 않았습니다. 지금 상태를 요약하고 끝내세요." };
  }
  // 한 턴의 도구 결과는 반드시 하나의 user 메시지로 함께 돌려준다.
  st.messages.push({ role: "user", content: [...p.partial, result] });
  st.pending = undefined;
  return loop(client, st, s, db);
}

const changed = (st: AgentState) => st.onChange?.();

async function loop(client: LlmClient, st: AgentState, s: SessionData, db?: Db) {
  st.status = "running";
  changed(st);
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const res = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        tools: toolDefs,
        messages: st.messages,
        output_config: { effort: "medium" },
        // 모델이 안전 분류로 거절하면 서버가 다른 모델로 다시 시도한다.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });

      if (res.stop_reason === "refusal") throw new Error("모델이 요청을 거절했습니다.");
      // thinking 블록까지 그대로 다시 보내야 하므로 content 전체를 붙인다.
      st.messages.push({ role: "assistant", content: res.content });
      for (const b of res.content) if (b.type === "text" && b.text.trim()) st.log.push({ kind: "assistant", text: b.text });
      changed(st);

      const calls = res.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || calls.length === 0) {
        st.status = "done";
        changed(st);
        return st;
      }

      // 읽기 도구는 바로 실행하고, 쓰기 도구는 사람 승인 전까지 실행하지 않는다.
      // 모든 tool_use 에는 결과가 하나씩 있어야 하므로, 쓰기 도구가 둘 이상이면 첫 번째만 대기시키고 나머지는 오류로 돌려준다.
      const results: ToolResult[] = [];
      let gated: BetaToolUseBlock | undefined;
      for (const c of calls) {
        const input = (c.input ?? {}) as Record<string, unknown>;
        if (WRITE_TOOLS.has(c.name)) {
          if (!gated) gated = c;
          else results.push({ type: "tool_result", tool_use_id: c.id, content: "쓰기 도구는 한 번에 하나만 요청할 수 있습니다.", is_error: true });
          continue;
        }
        const out = runTool(c.name, input, s, db);
        st.log.push({ kind: "tool", name: c.name, input, ok: out.ok, output: out.data });
        results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out.data), is_error: !out.ok });
        changed(st);
      }
      if (gated) {
        const input = (gated.input ?? {}) as Record<string, unknown>;
        st.pending = { toolUseId: gated.id, name: gated.name, input, partial: results };
        st.log.push({ kind: "approval", summary: String(input.summary ?? "") });
        st.status = "awaiting_approval";
        changed(st);
        return st;
      }
      st.messages.push({ role: "user", content: results });
    }
    throw new Error(`도구 호출이 ${MAX_TURNS}턴을 넘어 멈췄습니다.`);
  } catch (e) {
    st.status = "error";
    st.error = e instanceof Error ? e.message : String(e);
    changed(st);
    return st;
  }
}
