#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

const IMPORT_STREAM_PREFIX = "codex-import:";
const IMPORT_EVENT_TYPES = new Set([
  "thread.created",
  "thread.message-sent",
  "thread.activity-appended",
]);
const IMPORT_ACTIVITY_KINDS = new Set(["codex.plan", "codex.reasoning", "tool.completed"]);

function usage() {
  return `Usage:
  node scripts/repair-codex-thread-projections.mjs [--db <path-to-state.sqlite>] [--write]

The command is a dry run unless --write is supplied. Fully quit T3 Code before writing.
The repair discovers events written by migrate-codex-thread.mjs, restores only missing
projection rows, and leaves orchestration events and Codex runtime bindings unchanged.`;
}

export function parseRepairArgs(argv) {
  const options = {
    db: NodePath.join(NodeOS.homedir(), ".t3", "userdata", "state.sqlite"),
    write: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write") {
      options.write = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
    index += 1;
    if (argument === "--db") options.db = NodePath.resolve(value);
    else throw new Error(`Unknown argument '${argument}'.`);
  }
  return options;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function assertServerStopped(dbPath) {
  const runtimePath = NodePath.join(NodePath.dirname(dbPath), "server-runtime.json");
  if (!NodeFS.existsSync(runtimePath)) return;
  let runtimeState;
  try {
    runtimeState = JSON.parse(NodeFS.readFileSync(runtimePath, "utf8"));
  } catch {
    return;
  }
  const pid = Number(runtimeState.pid);
  if (Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid)) {
    throw new Error(`T3 Code is still running as process ${pid}. Fully quit it before repairing.`);
  }
  if (typeof runtimeState.origin !== "string") return;
  try {
    await fetch(runtimeState.origin, { signal: AbortSignal.timeout(750) });
    throw new Error(`T3 Code is still running at ${runtimeState.origin}. Fully quit it first.`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("T3 Code is still running")) {
      throw error;
    }
  }
}

function ensureDatabaseExclusive(db) {
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  } catch (error) {
    throw new Error("The T3 database is write-locked. Fully quit T3 Code before repairing.", {
      cause: error,
    });
  }
  const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (Number(checkpoint?.busy ?? 0) !== 0) {
    throw new Error("The T3 database WAL is still held by another process. Fully quit T3 Code.");
  }
}

function quoteSqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function createBackup(db, dbPath) {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const backupPath = `${dbPath}.backup-repair-${timestamp}`;
  db.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`);
  return backupPath;
}

function parseJson(value, description) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON in ${description}.`, { cause: error });
  }
}

function assertString(value, description) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected a non-empty string for ${description}.`);
  }
  return value;
}

function readFingerprint(db) {
  return {
    eventCount: db.prepare("SELECT COUNT(*) AS count FROM orchestration_events").get().count,
    runtimeCount: db.prepare("SELECT COUNT(*) AS count FROM provider_session_runtime").get().count,
    projectionState: db
      .prepare(
        "SELECT projector, last_applied_sequence, updated_at FROM projection_state ORDER BY projector",
      )
      .all(),
    projectionCounts: db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM projection_threads) AS threads,
          (SELECT COUNT(*) FROM projection_thread_messages) AS messages,
          (SELECT COUNT(*) FROM projection_thread_activities) AS activities,
          (SELECT COUNT(*) FROM projection_turns) AS turns
      `)
      .get(),
  };
}

function sameValues(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function buildImportProjection(rows) {
  if (rows.length === 0) throw new Error("Cannot build a projection from an empty import stream.");
  const streamId = rows[0].stream_id;
  let expectedVersion = 0;
  const events = rows.map((row) => {
    if (row.stream_id !== streamId) throw new Error("Import rows contain multiple streams.");
    if (row.command_id !== streamId || row.correlation_id !== streamId) {
      throw new Error(`Stream '${streamId}' contains a row outside its original import batch.`);
    }
    if (row.stream_version !== expectedVersion) {
      throw new Error(
        `Import stream '${streamId}' expected version ${expectedVersion}, received ${row.stream_version}.`,
      );
    }
    expectedVersion += 1;
    if (!IMPORT_EVENT_TYPES.has(row.event_type)) {
      throw new Error(`Unexpected import event '${row.event_type}' in '${streamId}'.`);
    }
    return {
      type: row.event_type,
      occurredAt: row.occurred_at,
      payload: parseJson(row.payload_json, `event '${row.event_id}' payload`),
    };
  });
  const createdEvents = events.filter(({ type }) => type === "thread.created");
  if (createdEvents.length !== 1 || events[0].type !== "thread.created") {
    throw new Error(`Import stream '${streamId}' must contain one leading thread.created event.`);
  }
  const created = createdEvents[0].payload;
  if (created.threadId !== streamId) {
    throw new Error(`Import stream '${streamId}' has a mismatched thread.created payload.`);
  }

  const messages = [];
  const activities = [];
  const messageIds = new Set();
  const activityIds = new Set();
  const turnsById = new Map();
  let updatedAt = created.updatedAt;
  let latestUserMessageAt = null;

  for (const event of events.slice(1)) {
    updatedAt = event.occurredAt;
    if (event.type === "thread.message-sent") {
      const message = event.payload;
      const messageId = assertString(message.messageId, `${streamId} messageId`);
      if (
        message.threadId !== streamId ||
        message.streaming !== false ||
        message.attachments !== undefined ||
        messageIds.has(messageId)
      ) {
        throw new Error(`Import stream '${streamId}' has an unexpected message shape.`);
      }
      messageIds.add(messageId);
      messages.push(message);
      if (message.role === "user") {
        if (latestUserMessageAt === null || message.createdAt > latestUserMessageAt) {
          latestUserMessageAt = message.createdAt;
        }
      } else if (message.role === "assistant" && message.turnId !== null) {
        const existing = turnsById.get(message.turnId);
        const assistantMessageIds = existing?.assistantMessageIds ?? new Set();
        assistantMessageIds.add(message.messageId);
        turnsById.set(message.turnId, {
          threadId: streamId,
          turnId: message.turnId,
          assistantMessageId: message.messageId,
          assistantMessageIds,
          requestedAt: existing?.requestedAt ?? message.createdAt,
          startedAt: existing?.startedAt ?? message.createdAt,
          completedAt: existing?.completedAt ?? message.updatedAt,
        });
      } else if (message.role !== "assistant") {
        throw new Error(`Import stream '${streamId}' has unsupported role '${message.role}'.`);
      }
      continue;
    }
    if (event.type === "thread.activity-appended") {
      const activity = event.payload.activity;
      const activityId = assertString(activity?.id, `${streamId} activity id`);
      if (
        event.payload.threadId !== streamId ||
        !IMPORT_ACTIVITY_KINDS.has(activity.kind) ||
        activityIds.has(activityId)
      ) {
        throw new Error(`Import stream '${streamId}' has an unexpected activity shape.`);
      }
      activityIds.add(activityId);
      activities.push(activity);
    }
  }

  return {
    thread: {
      threadId: streamId,
      projectId: assertString(created.projectId, `${streamId} projectId`),
      title: assertString(created.title, `${streamId} title`),
      modelSelectionJson: JSON.stringify(created.modelSelection),
      runtimeMode: created.runtimeMode,
      interactionMode: created.interactionMode,
      branch: created.branch ?? null,
      worktreePath: created.worktreePath ?? null,
      createdAt: created.createdAt,
      updatedAt,
      latestUserMessageAt,
    },
    messages,
    activities,
    turns: [...turnsById.values()],
  };
}

export function prepareRuntimeBindingQuery(db) {
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(provider_session_runtime)")
      .all()
      .map(({ name }) => name),
  );
  const providerInstanceColumn = columns.has("provider_instance_id") ? "provider_instance_id," : "";
  return {
    hasProviderInstanceId: columns.has("provider_instance_id"),
    query: db.prepare(`
      SELECT provider_name, ${providerInstanceColumn} resume_cursor_json, runtime_payload_json
      FROM provider_session_runtime
      WHERE thread_id = ?
    `),
  };
}

export function validateRuntimeBinding(runtime, sourceThreadId, hasProviderInstanceId, streamId) {
  const resumeCursor = parseJson(runtime.resume_cursor_json, `${streamId} resume cursor`);
  const runtimePayload = parseJson(runtime.runtime_payload_json, `${streamId} runtime payload`);
  const importedInstanceId = assertString(
    runtimePayload.modelSelection?.instanceId,
    `${streamId} provider instance`,
  );
  if (
    runtime.provider_name !== "codex" ||
    resumeCursor.threadId !== sourceThreadId ||
    runtimePayload.codexImport?.sourceThreadId !== sourceThreadId ||
    (hasProviderInstanceId && runtime.provider_instance_id !== importedInstanceId)
  ) {
    throw new Error(`Import stream '${streamId}' has an unexpected runtime binding.`);
  }
}

export function inspectRepair(db) {
  const streamRows = db
    .prepare(`
      SELECT DISTINCT stream_id
      FROM orchestration_events
      WHERE stream_id LIKE 'codex-import:%'
        AND command_id = stream_id
        AND correlation_id = stream_id
      ORDER BY stream_id
    `)
    .all();
  if (streamRows.length === 0) throw new Error("No Codex migration streams were found.");

  const importEventsQuery = db.prepare(`
    SELECT sequence, event_id, stream_id, stream_version, event_type, occurred_at,
      command_id, correlation_id, payload_json
    FROM orchestration_events
    WHERE stream_id = ?
      AND command_id = stream_id
      AND correlation_id = stream_id
    ORDER BY stream_version
  `);
  const projectQuery = db.prepare(
    "SELECT project_id FROM projection_projects WHERE project_id = ? AND deleted_at IS NULL",
  );
  const { hasProviderInstanceId, query: runtimeQuery } = prepareRuntimeBindingQuery(db);
  const threadQuery = db.prepare("SELECT * FROM projection_threads WHERE thread_id = ?");
  const messagesQuery = db.prepare(
    "SELECT message_id FROM projection_thread_messages WHERE thread_id = ?",
  );
  const activitiesQuery = db.prepare(
    "SELECT activity_id FROM projection_thread_activities WHERE thread_id = ?",
  );
  const turnsQuery = db.prepare("SELECT * FROM projection_turns WHERE thread_id = ?");
  const imported = [];

  for (const { stream_id: streamId } of streamRows) {
    const projection = buildImportProjection(importEventsQuery.all(streamId));
    if (projectQuery.all(projection.thread.projectId).length !== 1) {
      throw new Error(`Import stream '${streamId}' points at a missing or deleted T3 project.`);
    }
    const sourceThreadId = streamId.slice(IMPORT_STREAM_PREFIX.length);
    const runtimeRows = runtimeQuery.all(streamId);
    if (runtimeRows.length !== 1) {
      throw new Error(`Import stream '${streamId}' does not have one runtime binding.`);
    }
    validateRuntimeBinding(runtimeRows[0], sourceThreadId, hasProviderInstanceId, streamId);

    const threadRows = threadQuery.all(streamId);
    if (threadRows.length > 1)
      throw new Error(`Import stream '${streamId}' has duplicate threads.`);
    if (threadRows.length === 1 && threadRows[0].project_id !== projection.thread.projectId) {
      throw new Error(`Import stream '${streamId}' is projected into the wrong T3 project.`);
    }
    const existingMessageIds = new Set(messagesQuery.all(streamId).map((row) => row.message_id));
    const existingActivityIds = new Set(
      activitiesQuery.all(streamId).map((row) => row.activity_id),
    );
    const existingTurnsById = new Map(turnsQuery.all(streamId).map((turn) => [turn.turn_id, turn]));
    const missingMessages = projection.messages.filter(
      ({ messageId }) => !existingMessageIds.has(messageId),
    );
    const missingActivities = projection.activities.filter(
      ({ id }) => !existingActivityIds.has(id),
    );
    const missingTurns = projection.turns.filter(({ turnId }) => !existingTurnsById.has(turnId));
    const turnAssistantUpdates = projection.turns.filter((turn) => {
      const existing = existingTurnsById.get(turn.turnId);
      if (!existing || existing.assistant_message_id === turn.assistantMessageId) return false;
      return (
        existing.assistant_message_id === null ||
        turn.assistantMessageIds.has(existing.assistant_message_id)
      );
    });
    imported.push({
      streamId,
      projection,
      missingThread: threadRows.length === 0,
      missingMessages,
      missingActivities,
      missingTurns,
      turnAssistantUpdates,
    });
  }

  const incomplete = imported.filter(
    ({ missingThread, missingMessages, missingActivities, missingTurns, turnAssistantUpdates }) =>
      missingThread ||
      missingMessages.length > 0 ||
      missingActivities.length > 0 ||
      missingTurns.length > 0 ||
      turnAssistantUpdates.length > 0,
  );
  return { imported, incomplete, fingerprint: readFingerprint(db) };
}

function writeRepair(db, incomplete) {
  const insertThread = db.prepare(`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      branch, worktree_path, latest_turn_id, created_at, updated_at, archived_at,
      settled_override, settled_at, snoozed_until, snoozed_at, pinned_at, pin_order_key,
      title_regeneration_request_id, title_regeneration_started_at, latest_user_message_at,
      pending_approval_count, pending_user_input_count, has_actionable_proposed_plan, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, ?, 0, 0, 0, NULL)
  `);
  const refreshThreadDates = db.prepare(`
    UPDATE projection_threads
    SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END,
      latest_user_message_at = CASE
        WHEN ? IS NULL THEN latest_user_message_at
        WHEN latest_user_message_at IS NULL OR latest_user_message_at < ? THEN ?
        ELSE latest_user_message_at
      END
    WHERE thread_id = ?
  `);
  const insertMessage = db.prepare(`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, attachments_json, is_streaming,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)
  `);
  const insertActivity = db.prepare(`
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTurn = db.prepare(`
    INSERT INTO projection_turns (
      thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id,
      source_proposed_plan_id, assistant_message_id, state, requested_at, started_at,
      completed_at, checkpoint_turn_count, checkpoint_ref, checkpoint_status,
      checkpoint_files_json
    ) VALUES (?, ?, NULL, NULL, NULL, ?, 'completed', ?, ?, ?, NULL, NULL, NULL, '[]')
  `);
  const updateTurnAssistant = db.prepare(`
    UPDATE projection_turns
    SET assistant_message_id = ?
    WHERE thread_id = ? AND turn_id = ?
  `);

  for (const item of incomplete) {
    const { thread } = item.projection;
    if (item.missingThread) {
      insertThread.run(
        thread.threadId,
        thread.projectId,
        thread.title,
        thread.modelSelectionJson,
        thread.runtimeMode,
        thread.interactionMode,
        thread.branch,
        thread.worktreePath,
        thread.createdAt,
        thread.updatedAt,
        thread.latestUserMessageAt,
      );
    }
    for (const message of item.missingMessages) {
      insertMessage.run(
        message.messageId,
        message.threadId,
        message.turnId,
        message.role,
        message.text,
        message.createdAt,
        message.updatedAt,
      );
    }
    for (const activity of item.missingActivities) {
      insertActivity.run(
        activity.id,
        thread.threadId,
        activity.turnId,
        activity.tone,
        activity.kind,
        activity.summary,
        JSON.stringify(activity.payload),
        activity.sequence ?? null,
        activity.createdAt,
      );
    }
    for (const turn of item.missingTurns) {
      insertTurn.run(
        turn.threadId,
        turn.turnId,
        turn.assistantMessageId,
        turn.requestedAt,
        turn.startedAt,
        turn.completedAt,
      );
    }
    for (const turn of item.turnAssistantUpdates) {
      updateTurnAssistant.run(turn.assistantMessageId, turn.threadId, turn.turnId);
    }
    if (!item.missingThread) {
      refreshThreadDates.run(
        thread.updatedAt,
        thread.updatedAt,
        thread.latestUserMessageAt,
        thread.latestUserMessageAt,
        thread.latestUserMessageAt,
        thread.threadId,
      );
    }
  }
}

function sum(items, select) {
  return items.reduce((total, item) => total + select(item), 0);
}

function repairCounts(incomplete) {
  return {
    insertedThreads: incomplete.filter(({ missingThread }) => missingThread).length,
    insertedMessages: sum(incomplete, ({ missingMessages }) => missingMessages.length),
    insertedActivities: sum(incomplete, ({ missingActivities }) => missingActivities.length),
    insertedTurns: sum(incomplete, ({ missingTurns }) => missingTurns.length),
    updatedTurns: sum(incomplete, ({ turnAssistantUpdates }) => turnAssistantUpdates.length),
  };
}

function verifyRepair(db, before, expected) {
  const after = inspectRepair(db);
  if (after.incomplete.length !== 0) throw new Error("The projection repair remained incomplete.");
  const expectedProjectionCounts = {
    threads: before.projectionCounts.threads + expected.insertedThreads,
    messages: before.projectionCounts.messages + expected.insertedMessages,
    activities: before.projectionCounts.activities + expected.insertedActivities,
    turns: before.projectionCounts.turns + expected.insertedTurns,
  };
  if (
    after.fingerprint.eventCount !== before.eventCount ||
    after.fingerprint.runtimeCount !== before.runtimeCount ||
    !sameValues(after.fingerprint.projectionState, before.projectionState) ||
    !sameValues(after.fingerprint.projectionCounts, expectedProjectionCounts)
  ) {
    throw new Error("Protected database state or post-repair counts did not match expectations.");
  }
  if (db.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw new Error("The repaired database failed foreign_key_check.");
  }
}

export async function repairCodexThreadProjections(options) {
  if (!NodeFS.existsSync(options.db)) throw new Error(`Database not found at '${options.db}'.`);
  if (options.write) await assertServerStopped(options.db);
  const db = new NodeSqlite.DatabaseSync(options.db, { readOnly: !options.write });
  try {
    const inspection = inspectRepair(db);
    if (inspection.incomplete.length === 0) {
      return { alreadyRepaired: true, importedThreadCount: inspection.imported.length };
    }
    const counts = repairCounts(inspection.incomplete);
    const summary = {
      alreadyRepaired: false,
      affectedThreadCount: inspection.incomplete.length,
      insertedThreadCount: counts.insertedThreads,
      insertedMessageCount: counts.insertedMessages,
      insertedActivityCount: counts.insertedActivities,
      insertedTurnCount: counts.insertedTurns,
      updatedTurnCount: counts.updatedTurns,
      affectedThreads: inspection.incomplete.map(({ streamId }) => streamId),
    };
    if (!options.write) return summary;

    ensureDatabaseExclusive(db);
    const backupPath = createBackup(db, options.db);
    await assertServerStopped(options.db);
    ensureDatabaseExclusive(db);
    db.exec("BEGIN IMMEDIATE");
    try {
      const lockedInspection = inspectRepair(db);
      if (!sameValues(lockedInspection.fingerprint, inspection.fingerprint)) {
        throw new Error("The T3 database changed after preflight. No repair was applied.");
      }
      const lockedCounts = repairCounts(lockedInspection.incomplete);
      if (!sameValues(lockedCounts, counts)) {
        throw new Error("The required repair changed after preflight. No repair was applied.");
      }
      writeRepair(db, lockedInspection.incomplete);
      verifyRepair(db, inspection.fingerprint, counts);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { ...summary, backupPath };
  } finally {
    db.close();
  }
}

async function main() {
  try {
    const options = parseRepairArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const result = await repairCodexThreadProjections(options);
    console.log(JSON.stringify(result, null, 2));
    if (!options.write && !result.alreadyRepaired) {
      console.log("Dry run only. Re-run with --write after fully quitting T3 Code.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("\n" + usage());
    process.exitCode = 1;
  }
}

if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
