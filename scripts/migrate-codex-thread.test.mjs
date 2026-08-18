import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  classifyLocalThread,
  parseArgs,
  projectCodexThread,
  resolveProject,
} from "./migrate-codex-thread.mjs";

const thread = {
  id: "source-thread",
  name: "Migration proof",
  preview: "Preview",
  source: "vscode",
  ephemeral: false,
  cwd: "C:\\Code\\repo",
  createdAt: 1_765_699_200,
  updatedAt: 1_765_699_300,
  gitInfo: { branch: "main" },
  turns: [
    {
      id: "source-turn",
      startedAt: 1_765_699_201,
      items: [
        {
          id: "user-item",
          type: "userMessage",
          content: [
            { type: "text", text: "Inspect this" },
            { type: "localImage", path: "C:\\tmp\\proof.png" },
          ],
        },
        { id: "reasoning-item", type: "reasoning", summary: ["Checked the task"] },
        { id: "assistant-item", type: "agentMessage", text: "MIGRATION_SOURCE_OK" },
      ],
    },
  ],
};

NodeTest.test("parses a dry-run command by default", () => {
  const parsed = parseArgs(["--thread", "source", "--project", "C:\\Code\\repo"]);
  NodeAssert.equal(parsed.threadId, "source");
  NodeAssert.equal(parsed.project, "C:\\Code\\repo");
  NodeAssert.equal(parsed.write, false);
});

NodeTest.test("rejects non-local, ephemeral, and parent-agent tasks", () => {
  NodeAssert.deepEqual(classifyLocalThread(thread, true), { eligible: true });
  NodeAssert.deepEqual(classifyLocalThread({ ...thread, cwd: "C:\\missing" }, false), {
    eligible: false,
    reason: "workspace-not-local",
  });
  NodeAssert.deepEqual(classifyLocalThread({ ...thread, source: "exec" }, true), {
    eligible: false,
    reason: "non-interactive-source",
  });
  NodeAssert.deepEqual(classifyLocalThread({ ...thread, source: { subAgent: "review" } }, true), {
    eligible: false,
    reason: "subagent",
  });
  NodeAssert.deepEqual(classifyLocalThread({ ...thread, threadSource: "subagent" }, true), {
    eligible: true,
  });
});

NodeTest.test("projects native history in exact item order with visible fallbacks", () => {
  const projection = projectCodexThread(thread, {
    projectId: "project-1",
    providerInstance: "codex",
    model: "gpt-5.6-sol",
  });
  NodeAssert.equal(projection.threadId, "codex-import:source-thread");
  NodeAssert.deepEqual(
    projection.events.map((event) => event.type),
    ["thread.created", "thread.message-sent", "thread.activity-appended", "thread.message-sent"],
  );
  NodeAssert.equal(
    projection.events[1].payload.text,
    "Inspect this\n[Local image: C:\\tmp\\proof.png]",
  );
  NodeAssert.equal(projection.events[2].payload.activity.summary, "Checked the task");
  NodeAssert.equal(projection.events[3].payload.text, "MIGRATION_SOURCE_OK");
  NodeAssert.ok(
    Date.parse(projection.events[1].occurredAt) < Date.parse(projection.events[2].occurredAt),
  );
});

NodeTest.test("resolves destination projects by id or normalized workspace path", () => {
  const projects = [{ project_id: "project-1", title: "Repo", workspace_root: "C:\\Code\\repo" }];
  NodeAssert.equal(resolveProject(projects, "project-1")?.project_id, "project-1");
  NodeAssert.equal(resolveProject(projects, "C:\\Code\\repo")?.project_id, "project-1");
});
