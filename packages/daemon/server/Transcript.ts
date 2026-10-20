import { EventEmitter } from "events";
import fs from "fs";
import type { ChatEntry } from "../shared/protocol.ts";

/**
 * How much of a conversation is kept and sent: plenty to scroll back
 * through, while a transcript can run past 100MB (they hold every tool's
 * output, which the panel doesn't show).
 */
const MAX_ENTRIES = 2000;

/** How often the transcript is checked for more. A stat; it's cheap. */
const POLL_INTERVAL = 250;

/**
 * A Claude Code session's conversation, read from its transcript (JSONL, a
 * line per message, appended as each one is done) and followed as it grows.
 * Emits `entries` with each batch of new ones, and `reset` when the file
 * starts over.
 */
export class Transcript extends EventEmitter<{ entries: [entries: ChatEntry[]]; reset: [] }> {
  readonly file: string;
  entries: ChatEntry[] = [];
  private offset = 0;
  /** A line still being written, at the end of what's been read. */
  private partial = "";
  private reading = false;
  private readAgain = false;
  private closed = false;

  constructor(file: string) {
    super();
    this.file = file;
    // watchFile, unlike watch, works on a file that doesn't exist yet: a
    // session has a transcript path before it has a message.
    fs.watchFile(file, { interval: POLL_INTERVAL, persistent: false }, () => void this.read());
    void this.read();
  }

  close() {
    this.closed = true;
    fs.unwatchFile(this.file);
    this.removeAllListeners();
  }

  private async read() {
    if (this.reading) {
      this.readAgain = true;
      return;
    }

    this.reading = true;
    try {
      do {
        this.readAgain = false;
        await this.readMore();
      } while (this.readAgain && !this.closed);
    } finally {
      this.reading = false;
    }
  }

  private async readMore() {
    let size: number;
    try {
      size = (await fs.promises.stat(this.file)).size;
    } catch {
      return;
    }

    if (size < this.offset) {
      this.entries = [];
      this.offset = 0;
      this.partial = "";
      this.emit("reset");
    }
    if (size === this.offset) return;

    // In chunks, so a long transcript never holds up the terminals.
    const fresh: ChatEntry[] = [];
    const stream = fs.createReadStream(this.file, {
      start: this.offset,
      end: size - 1,
      encoding: "utf8",
      highWaterMark: 1 << 20,
    });
    for await (const chunk of stream) {
      if (this.closed) return stream.destroy();
      const lines = (this.partial + chunk).split("\n");
      this.partial = lines.pop()!;
      for (const line of lines) fresh.push(...parseTranscriptLine(line));
      if (fresh.length > 2 * MAX_ENTRIES) fresh.splice(0, fresh.length - MAX_ENTRIES);
    }
    this.offset = size;

    if (fresh.length === 0 || this.closed) return;
    const added = fresh.slice(-MAX_ENTRIES);
    this.entries = [...this.entries, ...added].slice(-MAX_ENTRIES);
    this.emit("entries", added);
  }
}

/**
 * What one transcript line says, for the panel: your prompts, Claude's text,
 * and its tool calls. Everything else (thinking, tool output, the
 * bookkeeping lines) is left out, as are subagents' conversations and the
 * messages Claude Code adds itself.
 */
export function parseTranscriptLine(line: string): ChatEntry[] {
  // Most lines are neither, and some are huge: no need to parse those.
  if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return [];

  let record: any;
  try {
    record = JSON.parse(line);
  } catch {
    return [];
  }
  if (record?.isSidechain || record?.isMeta || record?.isCompactSummary) return [];
  if (typeof record.uuid !== "string") return [];

  const id: string = record.uuid;
  const time = Date.parse(record.timestamp) || 0;
  const content = record.message?.content;

  if (record.type === "user") {
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((block: any) => block?.type === "text" && typeof block.text === "string")
              .map((block: any) => block.text)
              .join("\n\n")
          : "";
    const prompt = promptText(text);
    return prompt ? [{ id, kind: "prompt", text: prompt, time }] : [];
  }

  if (record.type === "assistant" && Array.isArray(content)) {
    return content.flatMap((block: any, index: number): ChatEntry[] => {
      const blockId = `${id}:${index}`;
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        return [{ id: blockId, kind: "reply", text: block.text, time }];
      }
      if (block?.type === "tool_use" && typeof block.name === "string") {
        return [{ id: blockId, kind: "tool", name: block.name, time, ...describeTool(block.name, block.input) }];
      }
      return [];
    });
  }

  return [];
}

/**
 * A user message as you typed it, or nothing for the ones Claude Code writes
 * (tool results are user messages too, and so are its notes in angle
 * brackets). Slash commands and `!` commands are recorded as markup.
 */
function promptText(text: string): string | null {
  const command = text.match(/<command-name>([^<]*)<\/command-name>/)?.[1];
  if (command) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
    return args ? `${command} ${args}` : command;
  }

  const bash = text.match(/^<bash-input>([\s\S]*)<\/bash-input>$/)?.[1];
  if (bash) return `! ${bash}`;

  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<") || trimmed.startsWith("[Request interrupted")) return null;
  return text;
}

/** How much of a tool's input the details hold. */
const MAX_DETAIL = 4000;

function describeTool(name: string, input: any): { summary: string; detail?: string } {
  const field = (key: string) => (typeof input?.[key] === "string" ? (input[key] as string) : undefined);
  const truncate = (text: string) => (text.length > MAX_DETAIL ? text.slice(0, MAX_DETAIL) + "\n…" : text);

  const command = field("command");
  const filePath = field("file_path") ?? field("notebook_path");
  const summary =
    field("description") ??
    command ??
    filePath ??
    field("pattern") ??
    field("url") ??
    field("query") ??
    field("skill") ??
    field("prompt") ??
    "";
  const firstLine = summary.split("\n")[0].slice(0, 200);

  let detail: string | undefined;
  if (command && command !== firstLine) detail = command;
  else if (field("old_string") !== undefined || field("new_string") !== undefined) {
    const lines = (text = "", mark: string) => (text ? text.split("\n").map((line) => mark + line) : []);
    detail = [...lines(field("old_string"), "- "), ...lines(field("new_string"), "+ ")].join("\n");
  } else if (field("content") !== undefined) detail = field("content");
  else if (input && typeof input === "object" && !filePath && Object.keys(input).length > 0) {
    const json = JSON.stringify(input, null, 2);
    if (json !== JSON.stringify({ [Object.keys(input)[0]]: firstLine }, null, 2)) detail = json;
  }

  return { summary: firstLine, ...(detail ? { detail: truncate(detail) } : {}) };
}
