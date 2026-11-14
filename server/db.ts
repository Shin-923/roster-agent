import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 반영 대상 테이블. 원본 명단의 칸 이름과 상관없이 정규화된 필드로만 저장한다.
export const participants = sqliteTable("participants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  language: text("language").notNull(),
  batchId: text("batch_id").notNull(), // 어느 업로드에서 들어왔는지 — 되돌릴 때 이 값으로 지운다
  createdAt: text("created_at").notNull(),
});

// 반영할 때 원본에서 무엇을 바꾸고 뺐는지 남긴다. 나중에 「왜 이 값이 들어갔나」를 이 표로 답한다.
export const changes = sqliteTable("changes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  batchId: text("batch_id").notNull(),
  row: integer("row").notNull(), // 원본 엑셀 행 번호
  kind: text("kind").notNull(), // fix(수정) · normalize(형식 맞춤) · skip(제외)
  field: text("field"),
  before: text("before"),
  after: text("after"),
  reason: text("reason").notNull(),
  createdAt: text("created_at").notNull(),
});

export type ParticipantInsert = typeof participants.$inferInsert;
export type ChangeInsert = typeof changes.$inferInsert;

export function openDb(file = "data/roster.db") {
  const sqlite = new Database(file);
  // 마이그레이션 도구 없이도 데모가 바로 돌도록 테이블을 직접 만든다.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, language TEXT NOT NULL,
    batch_id TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL, row INTEGER NOT NULL, kind TEXT NOT NULL,
    field TEXT, before TEXT, after TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL)`);
  return drizzle(sqlite);
}

export type Db = ReturnType<typeof openDb>;

/** 한 번의 반영(batch)을 통째로 되돌린다. 사람만 부를 수 있다 — 모델 도구에는 없다. */
export function rollbackBatch(db: Db, batchId: string) {
  return db.transaction((tx) => {
    const removed = tx.delete(participants).where(eq(participants.batchId, batchId)).run().changes;
    tx.delete(changes).where(eq(changes.batchId, batchId)).run();
    return removed;
  });
}
