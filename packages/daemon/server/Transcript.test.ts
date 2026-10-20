import { expect, test } from "vitest";
import { parseTranscriptLine } from "./Transcript.ts";

const line = (record: object) => JSON.stringify({ uuid: "u1", timestamp: "2026-10-20T12:00:00.000Z", ...record });

test("prompts, replies and tool calls come through; the rest of the transcript doesn't", () => {
  expect(parseTranscriptLine(line({ type: "user", message: { role: "user", content: "Fix the **bug**" } }))).toEqual([
    { id: "u1", kind: "prompt", text: "Fix the **bug**", time: Date.parse("2026-10-20T12:00:00.000Z") },
  ]);

  const assistant = parseTranscriptLine(
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Hmm." },
          { type: "text", text: "Here's the fix:\n\n- one" },
          { type: "tool_use", name: "Bash", input: { command: "yarn test", description: "Run the tests" } },
        ],
      },
    }),
  );
  expect(assistant.map((entry) => entry.kind)).toEqual(["reply", "tool"]);
  expect(assistant[0]).toMatchObject({ id: "u1:1", text: "Here's the fix:\n\n- one" });
  expect(assistant[1]).toMatchObject({ id: "u1:2", name: "Bash", summary: "Run the tests", detail: "yarn test" });

  // Tool results, Claude Code's own notes, subagents, and bookkeeping.
  const toolResult = { type: "user", message: { content: [{ type: "tool_result", content: "lots of output" }] } };
  expect(parseTranscriptLine(line(toolResult))).toEqual([]);
  expect(parseTranscriptLine(line({ type: "user", isMeta: true, message: { content: "Caveat" } }))).toEqual([]);
  expect(parseTranscriptLine(line({ type: "user", message: { content: "<local-command-stdout>hi</local-command-stdout>" } }))).toEqual([]);
  expect(parseTranscriptLine(line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "Sub" }] } }))).toEqual([]);
  expect(parseTranscriptLine(line({ type: "summary", summary: "x" }))).toEqual([]);
  expect(parseTranscriptLine("not json")).toEqual([]);
});

test("slash commands and ! commands read as you typed them", () => {
  const command = "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>";
  expect(parseTranscriptLine(line({ type: "user", message: { content: command } }))[0]).toMatchObject({ text: "/model opus" });
  expect(parseTranscriptLine(line({ type: "user", message: { content: "<bash-input>ls</bash-input>" } }))[0]).toMatchObject({
    text: "! ls",
  });
});

test("an edit's details read like a diff", () => {
  const [edit] = parseTranscriptLine(
    line({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/a.ts", old_string: "a\nb", new_string: "c" } }] },
    }),
  );
  expect(edit).toMatchObject({ summary: "/a.ts", detail: "- a\n- b\n+ c" });
});
