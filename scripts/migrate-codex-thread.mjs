#!/usr/bin/env node
/* oxlint-disable t3code/no-global-process-runtime -- Standalone migration utility intentionally has no Effect runtime. */

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

const DEFAULT_MODEL = "gpt-5.6-sol";
const LOCAL_INTERACTIVE_SOURCES = new Set(["cli", "vscode", "appServer"]);

function usage() {
  return `Usage:
  node scripts/migrate-codex-thread.mjs \\
    --thread <native-codex-thread-id> \\
    --project <t3-project-id-or-workspace-path> \\
    [--db <path-to-state.sqlite>] [--codex-bin <path>] [--codex-home <path>] \\
    [--provider-instance codex] [--model ${DEFAULT_MODEL}] [--write]

The command is a dry run unless --write is supplied. T3 Code must be fully stopped before writing.
Fully quit the Codex app before continuing a migrated task in T3; Codex permits only one active writer.
The default database is ~/.t3/userdata/state.sqlite.`;
}

export function parseArgs(argv) {
  const parsed = {
    db: NodePath.join(NodeOS.homedir(), ".t3", "userdata", "state.sqlite"),
    providerInstance: "codex",
    model: DEFAULT_MODEL,
    write: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write") {
      parsed.write = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
    index += 1;
    switch (argument) {
      case "--thread":
        parsed.threadId = value;
        break;
      case "--project":
        parsed.project = value;
        break;
      case "--db":
        parsed.db = NodePath.resolve(value);
        break;
      case "--codex-bin":
        parsed.codexBin = value;
        break;
      case "--codex-home":
        parsed.codexHome = NodePath.resolve(value);
        break;
      case "--provider-instance":
        parsed.providerInstance = value;
        break;
      case "--model":
        parsed.model = value;
        break;
      default:
        throw new Error(`Unknown argument '${argument}'.`);
    }
  }
  if (!parsed.help && (!parsed.threadId || !parsed.project)) {
    throw new Error("Both --thread and --project are required.");
  }
  return parsed;
}

function resolveCodexExecutable(explicitPath) {
  if (explicitPath) return explicitPath;
  const lookup = NodeChildProcess.spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    ["codex"],
    { encoding: "utf8" },
  );
  const matches = lookup.stdout
    ?.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const match =
    process.platform === "win32"
      ? (matches?.find((candidate) => /\.(?:cmd|bat)$/iu.test(candidate)) ??
        matches?.find((candidate) => /\.exe$/iu.test(candidate)))
      : matches?.[0];
  if (!match) throw new Error("Could not find Codex. Pass --codex-bin with its executable path.");
  return match;
}

class JsonLineRpcClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    NodeReadline.createInterface({ input: child.stdout }).on("line", (line) =>
      this.handleLine(line),
    );
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
    child.on("error", (cause) => {
      const error = new Error(`Could not start Codex App Server: ${cause.message}`, { cause });
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    });
    child.on("exit", (code) => {
      if (code === 0 && this.pending.size === 0) return;
      const error = new Error(
        `Codex App Server exited with code ${String(code)}.${this.stderr ? `\n${this.stderr}` : ""}`,
      );
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error)
      pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else pending.resolve(message.result);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      this.pending.set(id, { resolve: resolveRequest, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  close() {
    this.child.stdin.end();
    if (!this.child.killed) this.child.kill();
  }
}

export async function readCodexThread(options) {
  const executable = resolveCodexExecutable(options.codexBin);
  const useShell = process.platform === "win32" && /\.(cmd|bat)$/iu.test(executable);
  const child = NodeChildProcess.spawn(executable, ["app-server"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {}),
    },
    shell: useShell,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const rpc = new JsonLineRpcClient(child);
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "t3-codex-migrator", title: "T3 Codex Migrator", version: "1" },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized");
    const response = await rpc.request("thread/read", {
      threadId: options.threadId,
      includeTurns: true,
    });
    return response.thread;
  } finally {
    rpc.close();
  }
}

export function classifyLocalThread(thread, workspaceExists = NodeFS.existsSync(thread.cwd)) {
  if (thread.ephemeral) return { eligible: false, reason: "ephemeral" };
  if (typeof thread.source !== "string") return { eligible: false, reason: "subagent" };
  if (!LOCAL_INTERACTIVE_SOURCES.has(thread.source)) {
    return { eligible: false, reason: "non-interactive-source" };
  }
  if (thread.parentThreadId != null || thread.agentNickname != null || thread.agentRole != null) {
    return { eligible: false, reason: "subagent" };
  }
  if (!thread.cwd?.trim()) return { eligible: false, reason: "missing-cwd" };
  if (!workspaceExists) return { eligible: false, reason: "workspace-not-local" };
  return { eligible: true };
}

function userInputText(input) {
  switch (input.type) {
    case "text":
      return input.text;
    case "image":
      return `[Image: ${input.url}]`;
    case "localImage":
      return `[Local image: ${input.path}]`;
    case "audio":
      return `[Audio: ${input.url}]`;
    case "localAudio":
      return `[Local audio: ${input.path}]`;
    case "skill":
      return `[Skill: ${input.name} (${input.path})]`;
    case "mention":
      return `[Mention: ${input.name} (${input.path})]`;
    default:
      return `[Codex input: ${input.type ?? "unknown"}]`;
  }
}

function summarizeItem(item) {
  switch (item.type) {
    case "plan":
      return item.text?.trim() || "Plan";
    case "reasoning":
      return item.summary?.join("\n").trim() || "Reasoning";
    case "commandExecution":
      return item.command?.trim() || "Command execution";
    case "fileChange":
      return `File changes (${item.changes?.length ?? 0})`;
    case "mcpToolCall":
      return `${item.server}/${item.tool}`;
    case "dynamicToolCall":
      return item.namespace ? `${item.namespace}/${item.tool}` : item.tool;
    case "webSearch":
      return item.query?.trim() || "Web search";
    case "imageView":
      return `Viewed ${item.path}`;
    case "sleep":
      return `Waited ${item.durationMs}ms`;
    case "imageGeneration":
      return "Image generation";
    case "enteredReviewMode":
      return "Entered review mode";
    case "exitedReviewMode":
      return "Exited review mode";
    case "contextCompaction":
      return "Context compacted";
    default:
      return (
        item.title ??
        item.command ??
        item.query ??
        item.review ??
        String(item.type ?? "unknown item").replaceAll(/([a-z])([A-Z])/gu, "$1 $2")
      );
  }
}

function isoFromMs(milliseconds) {
  return new Date(milliseconds).toISOString();
}

export function projectCodexThread(thread, options) {
  const threadId = `codex-import:${thread.id}`;
  const createdAtMs = Number.isFinite(thread.createdAt) ? thread.createdAt * 1_000 : 0;
  let cursorMs = createdAtMs - 1;
  const events = [];
  const commandId = `codex-import:${thread.id}`;
  const createdAt = isoFromMs(createdAtMs);
  events.push({
    type: "thread.created",
    occurredAt: createdAt,
    payload: {
      threadId,
      projectId: options.projectId,
      title: thread.name?.trim() || thread.preview?.trim() || "Imported Codex task",
      modelSelection: { instanceId: options.providerInstance, model: options.model },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: thread.gitInfo?.branch?.trim() || null,
      worktreePath: null,
      createdAt,
      updatedAt: createdAt,
    },
  });
  for (const turn of thread.turns) {
    const turnStartedAtMs = Number.isFinite(turn.startedAt) ? turn.startedAt * 1_000 : cursorMs + 1;
    for (const [itemIndex, item] of turn.items.entries()) {
      cursorMs = Math.max(cursorMs + 1, turnStartedAtMs + itemIndex);
      const itemCreatedAt = isoFromMs(cursorMs);
      if (item.type === "userMessage" || item.type === "agentMessage") {
        events.push({
          type: "thread.message-sent",
          occurredAt: itemCreatedAt,
          payload: {
            threadId,
            messageId: `codex-import:${thread.id}:${item.id}`,
            role: item.type === "userMessage" ? "user" : "assistant",
            text:
              item.type === "userMessage" ? item.content.map(userInputText).join("\n") : item.text,
            turnId: turn.id,
            streaming: false,
            createdAt: itemCreatedAt,
            updatedAt: itemCreatedAt,
          },
        });
      } else {
        events.push({
          type: "thread.activity-appended",
          occurredAt: itemCreatedAt,
          payload: {
            threadId,
            activity: {
              id: `codex-import:${thread.id}:${item.id}`,
              tone: item.type === "plan" || item.type === "reasoning" ? "info" : "tool",
              kind:
                item.type === "plan" || item.type === "reasoning"
                  ? `codex.${item.type}`
                  : "tool.completed",
              summary: summarizeItem(item),
              payload: { importedFrom: "codex", itemType: item.type, data: { item } },
              turnId: turn.id,
              createdAt: itemCreatedAt,
            },
          },
        });
      }
    }
  }
  return { threadId, commandId, events };
}

function normalizedPath(value) {
  const result = NodePath.normalize(NodePath.isAbsolute(value) ? value : NodePath.resolve(value));
  return process.platform === "win32" ? result.toLowerCase() : result;
}

export function resolveProject(projects, identifier) {
  const exactId = projects.find((project) => project.project_id === identifier);
  if (exactId) return exactId;
  const candidatePath = normalizedPath(identifier);
  return projects.find((project) => normalizedPath(project.workspace_root) === candidatePath);
}

function requireTable(db, table) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!row) throw new Error(`The selected database is missing required table '${table}'.`);
}

function tableColumns(db, table) {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  );
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
    throw new Error(`T3 Code is still running as process ${pid}. Fully quit it before importing.`);
  }
  const { origin } = runtimeState;
  if (typeof origin !== "string") return;
  try {
    await fetch(origin, { signal: AbortSignal.timeout(750) });
    throw new Error(`T3 Code is still running at ${origin}. Fully quit it before importing.`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("T3 Code is still running")) throw error;
  }
}

function ensureDatabaseExclusive(db) {
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  } catch (error) {
    throw new Error("The T3 database is write-locked. Fully quit T3 Code before importing.", {
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
  const backupPath = `${dbPath}.backup-${timestamp}`;
  db.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`);
  return backupPath;
}

function appendEvents(db, projection) {
  const latest = db
    .prepare(
      "SELECT MAX(stream_version) AS version FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ?",
    )
    .get(projection.threadId);
  let streamVersion = Number(latest?.version ?? -1) + 1;
  const insert = db.prepare(`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
    ) VALUES (?, 'thread', ?, ?, ?, ?, ?, NULL, ?, 'client', ?, '{}')
  `);
  for (const event of projection.events) {
    insert.run(
      NodeCrypto.randomUUID(),
      projection.threadId,
      streamVersion++,
      event.type,
      event.occurredAt,
      projection.commandId,
      projection.commandId,
      JSON.stringify(event.payload),
    );
  }
}

function upsertResumeBinding(db, thread, projection, options, columns) {
  const importedAt = new Date().toISOString();
  const runtimePayload = JSON.stringify({
    cwd: thread.cwd,
    modelSelection: { instanceId: options.providerInstance, model: options.model },
    codexImport: {
      sourceThreadId: thread.id,
      sourceUpdatedAt: isoFromMs(thread.updatedAt * 1_000),
      importedAt,
    },
  });
  const values = {
    threadId: projection.threadId,
    providerName: "codex",
    providerInstanceId: options.providerInstance,
    adapterKey: "codex",
    runtimeMode: "full-access",
    status: "stopped",
    lastSeenAt: importedAt,
    resumeCursor: JSON.stringify({ threadId: thread.id }),
    runtimePayload,
  };
  if (columns.has("provider_instance_id")) {
    db.prepare(`
      INSERT INTO provider_session_runtime (
        thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status,
        last_seen_at, resume_cursor_json, runtime_payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        provider_name=excluded.provider_name,
        provider_instance_id=excluded.provider_instance_id,
        adapter_key=excluded.adapter_key,
        runtime_mode=excluded.runtime_mode,
        status=excluded.status,
        last_seen_at=excluded.last_seen_at,
        resume_cursor_json=excluded.resume_cursor_json,
        runtime_payload_json=excluded.runtime_payload_json
    `).run(...Object.values(values));
    return;
  }
  db.prepare(`
    INSERT INTO provider_session_runtime (
      thread_id, provider_name, adapter_key, runtime_mode, status,
      last_seen_at, resume_cursor_json, runtime_payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      provider_name=excluded.provider_name,
      adapter_key=excluded.adapter_key,
      runtime_mode=excluded.runtime_mode,
      status=excluded.status,
      last_seen_at=excluded.last_seen_at,
      resume_cursor_json=excluded.resume_cursor_json,
      runtime_payload_json=excluded.runtime_payload_json
  `).run(
    values.threadId,
    values.providerName,
    values.adapterKey,
    values.runtimeMode,
    values.status,
    values.lastSeenAt,
    values.resumeCursor,
    values.runtimePayload,
  );
}

export async function migrateCodexThread(options) {
  if (!NodeFS.existsSync(options.db)) {
    throw new Error(`T3 database not found at '${options.db}'.`);
  }
  const thread = await readCodexThread(options);
  const eligibility = classifyLocalThread(thread);
  if (!eligibility.eligible) {
    throw new Error(`Codex task '${thread.id}' is not local-importable (${eligibility.reason}).`);
  }
  const partialTurns = thread.turns.filter(
    (turn) => turn.itemsView !== undefined && turn.itemsView !== "full",
  );
  if (partialTurns.length > 0) {
    throw new Error(`Codex returned partial history for ${partialTurns.length} turn(s).`);
  }
  if (options.write) await assertServerStopped(options.db);
  const db = new NodeSqlite.DatabaseSync(options.db, { readOnly: !options.write });
  try {
    requireTable(db, "orchestration_events");
    requireTable(db, "projection_projects");
    requireTable(db, "projection_threads");
    requireTable(db, "provider_session_runtime");
    const projects = db
      .prepare(
        "SELECT project_id, title, workspace_root FROM projection_projects WHERE deleted_at IS NULL ORDER BY created_at",
      )
      .all();
    const project = resolveProject(projects, options.project);
    if (!project) throw new Error(`No active T3 project matches '${options.project}'.`);
    const projection = projectCodexThread(thread, {
      projectId: project.project_id,
      providerInstance: options.providerInstance,
      model: options.model,
    });
    const alreadyImported = Boolean(
      db
        .prepare(
          "SELECT 1 FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ? AND event_type = 'thread.created' LIMIT 1",
        )
        .get(projection.threadId),
    );
    const summary = {
      sourceThreadId: thread.id,
      destinationThreadId: projection.threadId,
      title: projection.events[0].payload.title,
      projectId: project.project_id,
      projectTitle: project.title,
      messageCount: projection.events.filter((event) => event.type === "thread.message-sent")
        .length,
      activityCount: projection.events.filter((event) => event.type === "thread.activity-appended")
        .length,
      alreadyImported,
      write: options.write,
      resumeNote: "Fully quit the Codex app before continuing this task in T3 Code.",
    };
    if (!options.write) return summary;
    ensureDatabaseExclusive(db);
    const backupPath = createBackup(db, options.db);
    await assertServerStopped(options.db);
    ensureDatabaseExclusive(db);
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!alreadyImported) appendEvents(db, projection);
      upsertResumeBinding(
        db,
        thread,
        projection,
        options,
        tableColumns(db, "provider_session_runtime"),
      );
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
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const result = await migrateCodexThread(options);
    console.log(JSON.stringify(result, null, 2));
    if (!options.write)
      console.log("Dry run only. Re-run with --write after fully quitting T3 Code.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("\n" + usage());
    process.exitCode = 1;
  }
}

if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url)
  await main();
