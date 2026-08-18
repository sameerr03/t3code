import * as NodeAssert from "node:assert/strict";
import * as NodeSqlite from "node:sqlite";
import * as NodeTest from "node:test";

import {
  buildImportProjection,
  parseRepairArgs,
  prepareRuntimeBindingQuery,
  validateRuntimeBinding,
} from "./repair-codex-thread-projections.mjs";

const streamId = "codex-import:source-thread";

function row(streamVersion, eventType, payload, occurredAt) {
  return {
    sequence: streamVersion + 1,
    event_id: `event-${streamVersion}`,
    stream_id: streamId,
    stream_version: streamVersion,
    event_type: eventType,
    occurred_at: occurredAt,
    command_id: streamId,
    correlation_id: streamId,
    payload_json: JSON.stringify(payload),
  };
}

NodeTest.test("parses a dry-run repair by default", () => {
  const options = parseRepairArgs(["--db", "C:\\tmp\\state.sqlite"]);
  NodeAssert.equal(options.write, false);
  NodeAssert.equal(options.db, "C:\\tmp\\state.sqlite");
});

NodeTest.test("builds the imported message, activity, and turn projections", () => {
  const projection = buildImportProjection([
    row(
      0,
      "thread.created",
      {
        threadId: streamId,
        projectId: "project-1",
        title: "Imported task",
        modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      "2026-08-01T00:00:00.000Z",
    ),
    row(
      1,
      "thread.message-sent",
      {
        messageId: "user-1",
        threadId: streamId,
        turnId: "turn-1",
        role: "user",
        text: "Hello",
        streaming: false,
        createdAt: "2026-08-01T00:00:01.000Z",
        updatedAt: "2026-08-01T00:00:01.000Z",
      },
      "2026-08-01T00:00:01.000Z",
    ),
    row(
      2,
      "thread.activity-appended",
      {
        threadId: streamId,
        activity: {
          id: "activity-1",
          turnId: "turn-1",
          tone: "info",
          kind: "codex.reasoning",
          summary: "Thinking",
          payload: {},
          createdAt: "2026-08-01T00:00:02.000Z",
        },
      },
      "2026-08-01T00:00:02.000Z",
    ),
    row(
      3,
      "thread.message-sent",
      {
        messageId: "assistant-1",
        threadId: streamId,
        turnId: "turn-1",
        role: "assistant",
        text: "Hi",
        streaming: false,
        createdAt: "2026-08-01T00:00:03.000Z",
        updatedAt: "2026-08-01T00:00:03.000Z",
      },
      "2026-08-01T00:00:03.000Z",
    ),
  ]);
  NodeAssert.equal(projection.messages.length, 2);
  NodeAssert.equal(projection.activities.length, 1);
  NodeAssert.equal(projection.turns.length, 1);
  NodeAssert.equal(projection.turns[0].assistantMessageId, "assistant-1");
  NodeAssert.equal(projection.thread.latestUserMessageAt, "2026-08-01T00:00:01.000Z");
  NodeAssert.equal(projection.thread.updatedAt, "2026-08-01T00:00:03.000Z");
});

NodeTest.test("rejects rows that are not part of the original import command", () => {
  const rows = [
    row(
      0,
      "thread.created",
      {
        threadId: streamId,
        projectId: "project-1",
        title: "Imported task",
        modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      "2026-08-01T00:00:00.000Z",
    ),
  ];
  rows[0].command_id = "later-live-command";
  NodeAssert.throws(() => buildImportProjection(rows), /outside its original import batch/u);
});

NodeTest.test("reads legacy runtime bindings without provider_instance_id", () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE provider_session_runtime (
        thread_id TEXT PRIMARY KEY,
        provider_name TEXT NOT NULL,
        resume_cursor_json TEXT NOT NULL,
        runtime_payload_json TEXT NOT NULL
      );
      INSERT INTO provider_session_runtime VALUES (
        'codex-import:source-thread',
        'codex',
        '{"threadId":"source-thread"}',
        '{"modelSelection":{"instanceId":"custom-codex"},"codexImport":{"sourceThreadId":"source-thread"}}'
      );
    `);
    const prepared = prepareRuntimeBindingQuery(db);
    NodeAssert.equal(prepared.hasProviderInstanceId, false);
    const runtime = prepared.query.get("codex-import:source-thread");
    NodeAssert.doesNotThrow(() =>
      validateRuntimeBinding(runtime, "source-thread", false, "codex-import:source-thread"),
    );
  } finally {
    db.close();
  }
});

NodeTest.test("accepts a matching custom provider instance", () => {
  const runtime = {
    provider_name: "codex",
    provider_instance_id: "work-codex",
    resume_cursor_json: JSON.stringify({ threadId: "source-thread" }),
    runtime_payload_json: JSON.stringify({
      modelSelection: { instanceId: "work-codex" },
      codexImport: { sourceThreadId: "source-thread" },
    }),
  };
  NodeAssert.doesNotThrow(() =>
    validateRuntimeBinding(runtime, "source-thread", true, "codex-import:source-thread"),
  );
});
