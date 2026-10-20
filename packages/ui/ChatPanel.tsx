import { colors } from "crosswing/colors";
import { StyledTextArea, TextArea, type TextAreaRef } from "crosswing/components/forms/TextArea";
import { fonts } from "crosswing/fonts";
import { ModalContext } from "crosswing/modals/context";
import { ArrowUp, ChevronRight, Square, TextQuote } from "lucide-react";
import type { ChatEntry, Tab } from "miks/shared/protocol";
import { type DragEvent, type KeyboardEvent, type MouseEvent, use, useEffect, useLayoutEffect, useRef, useState } from "react";
import { styled } from "styled-components";
import { daemon } from "./daemon";
import { renderMarkdown } from "./markdown";
import { getSettings, updateSettings } from "./settings";
import { droppedText, focusActiveTerminal, onDragOver, sendEscape, sendToTerminal } from "./TerminalView";

/** What you've started writing in each tab, kept while you look at others. */
const drafts = new Map<string, string>();

/** Set when you open the panel yourself: the composer takes the keyboard. */
let focusOnShow = false;

/** Shows or hides the panel (⌘⇧C, or the tab bar's button), moving the keyboard with it. */
export function toggleChat() {
  const visible = !getSettings().chatVisible;
  if (visible) focusOnShow = true;
  else focusActiveTerminal();
  updateSettings({ chatVisible: visible });
}

/**
 * The tab's Claude Code conversation, for reading in proportional type with
 * real markdown, and a place to write the next message. Everything here is
 * read from the session's transcript (the daemon follows it), and a message
 * sent from here is typed into the terminal, so the terminal stays the
 * truth: this is another view of it.
 */
export function ChatPanel({ tab, visible, supported }: { tab: Tab | null; visible: boolean; supported: boolean }) {
  return (
    <StyledChatPanel>
      {!supported ? (
        <div className="note">This tab's Mac has an older Miks. Update it there to see conversations here.</div>
      ) : tab ? (
        <Conversation key={tab.id} tab={tab} visible={visible} />
      ) : null}
    </StyledChatPanel>
  );
}

type Item =
  | { kind: "prompt" | "reply"; entry: ChatEntry & { text: string } }
  | { kind: "tools"; entries: Extract<ChatEntry, { kind: "tool" }>[] };

/** Tool calls in a row become one line. */
function group(entries: ChatEntry[]): Item[] {
  const items: Item[] = [];
  for (const entry of entries) {
    const last = items.at(-1);
    if (entry.kind === "tool") {
      if (last?.kind === "tools") last.entries.push(entry);
      else items.push({ kind: "tools", entries: [entry] });
    } else {
      items.push({ kind: entry.kind, entry });
    }
  }
  return items;
}

/** The most kept in the panel at once, as in the daemon. */
const MAX_ENTRIES = 2000;

function Conversation({ tab, visible }: { tab: Tab; visible: boolean }) {
  const [chat, setChat] = useState<{ session: string | null; entries: ChatEntry[] } | null>(null);
  const [text, setText] = useState(drafts.get(tab.id) ?? "");
  const [quote, setQuote] = useState<{ text: string; top: number; left: number } | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const textAreaRef = useRef<TextAreaRef>(null);
  const atBottom = useRef(true);
  const { showToast } = use(ModalContext);

  // Only while it's showing; a hidden panel needn't follow anything.
  useEffect(() => {
    if (!visible) return;
    return daemon.watchChat(tab.id, (event) =>
      setChat((current) => ({
        session: event.session,
        entries: event.reset ? event.entries : [...(current?.entries ?? []), ...event.entries].slice(-MAX_ENTRIES),
      })),
    );
  }, [tab.id, visible]);

  useEffect(() => {
    if (!visible || !focusOnShow) return;
    focusOnShow = false;
    textAreaRef.current?.focus(Number.MAX_SAFE_INTEGER);
  }, [visible]);

  // New messages keep it at the bottom, unless you've scrolled up to read.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller && atBottom.current) scroller.scrollTop = scroller.scrollHeight;
  }, [chat]);

  function changeText(next: string) {
    setText(next);
    if (next) drafts.set(tab.id, next);
    else drafts.delete(tab.id);
  }

  function insert(addition: string) {
    const joined = text && !text.endsWith("\n") && !text.endsWith(" ") ? `${text} ${addition}` : text + addition;
    changeText(joined);
    textAreaRef.current?.focus(Number.MAX_SAFE_INTEGER);
  }

  const status = tab.agent?.status;
  const session = chat?.session ?? null;
  // A permission prompt or a question takes keys, not messages.
  const asking = status === "waiting";
  const canSend = !!session && !asking && !!text.trim();

  function send() {
    if (!canSend) return;
    sendToTerminal(tab.id, text.trim());
    changeText("");
    atBottom.current = true;
  }

  // Return is always a newline; ⌘Return sends.
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" && event.metaKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    } else if (event.key === "Escape") {
      event.preventDefault();
      focusActiveTerminal();
    }
  }

  async function onDrop(event: DragEvent) {
    const dropped = await droppedText(event, tab.id, showToast);
    if (dropped) insert(dropped);
  }

  // Selecting text in a message offers to quote it in your reply.
  function onMouseUp() {
    const selection = window.getSelection();
    const scroller = scrollerRef.current;
    const selected = selection?.toString().trim();
    if (!selection || !scroller || !selected || selection.rangeCount === 0) return setQuote(null);
    if (!scroller.contains(selection.anchorNode) || !scroller.contains(selection.focusNode)) return setQuote(null);

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const bounds = scroller.getBoundingClientRect();
    setQuote({
      text: selected,
      top: rect.top - bounds.top + scroller.scrollTop - 34,
      left: Math.min(Math.max(rect.left - bounds.left + rect.width / 2 - 36, 8), bounds.width - 88),
    });
  }

  function addQuote() {
    if (!quote) return;
    const quoted = quote.text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    setQuote(null);
    window.getSelection()?.removeAllRanges();
    changeText((text ? text.replace(/\n*$/, "\n\n") : "") + quoted + "\n\n");
    textAreaRef.current?.focus(Number.MAX_SAFE_INTEGER);
  }

  // Code's copy buttons, and links (which open in the browser).
  function onClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const copy = target.closest("button.copy");
    if (copy) {
      const code = copy.parentElement?.querySelector("pre")?.textContent ?? "";
      window.miks?.copy(code);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
      return;
    }
    const link = target.closest("a");
    if (link?.href) {
      event.preventDefault();
      window.open(link.href);
    }
  }

  function placeholder(): string {
    if (!session) return "No Claude Code session";
    if (asking) return "Claude is asking something in the terminal";
    if (status === "working") return "Queue a message";
    return "Reply";
  }

  return (
    <>
      <div
        className="scroller"
        ref={scrollerRef}
        onScroll={(event) => {
          const scroller = event.currentTarget;
          atBottom.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
        }}
        onMouseUp={onMouseUp}
        onMouseDown={() => setQuote(null)}
        onClick={onClick}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        {chat && !session && (
          <div className="note">Start Claude Code in this tab, and its conversation shows up here.</div>
        )}
        {chat && session && chat.entries.length === 0 && <div className="note">Nothing said yet.</div>}
        {group(chat?.entries ?? []).map((item) =>
          item.kind === "tools" ? (
            <ToolCalls key={item.entries[0].id} entries={item.entries} />
          ) : item.kind === "prompt" ? (
            <div key={item.entry.id} className="prompt">
              <div className="bubble">{item.entry.text}</div>
            </div>
          ) : (
            <Reply key={item.entry.id} text={item.entry.text} />
          ),
        )}
        {session && status === "working" && <div className="working">Working…</div>}
        {quote && (
          <button
            className="quote"
            style={{ top: quote.top, left: quote.left }}
            // Before the selection goes.
            onMouseDown={(event) => event.preventDefault()}
            onClick={addQuote}
          >
            <TextQuote size={14} /> Quote
          </button>
        )}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <TextArea
          ref={textAreaRef}
          value={text}
          onValueChange={changeText}
          onKeyDown={onKeyDown}
          placeholder={placeholder()}
          disabled={!session}
          autoSizing
          minHeight={20}
          maxHeight={240}
          rows={1}
        />
        {status === "working" && !text ? (
          <button type="button" className="send" title="Stop (Escape in the terminal)" onClick={() => sendEscape(tab.id)}>
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button type="submit" className="send" title="Send (⌘Return)" disabled={!canSend}>
            <ArrowUp size={16} />
          </button>
        )}
      </form>
    </>
  );
}

function Reply({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = renderMarkdown(text);

  // A copy button on each block of code.
  useLayoutEffect(() => {
    for (const pre of ref.current?.querySelectorAll(":scope > pre") ?? []) {
      const wrapper = document.createElement("div");
      wrapper.className = "code";
      pre.replaceWith(wrapper);
      const button = document.createElement("button");
      button.className = "copy";
      button.textContent = "Copy";
      wrapper.append(pre, button);
    }
  }, [html]);

  return <div className="reply" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** A run of tool calls: one line, which opens to a line each, which open to their details. */
function ToolCalls({ entries }: { entries: Extract<ChatEntry, { kind: "tool" }>[] }) {
  const [open, setOpen] = useState(false);
  const [openDetail, setOpenDetail] = useState<string | null>(null);

  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  const names = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(", ");
  const only = entries.length === 1 ? entries[0] : null;

  return (
    <div className="tools" data-open={open}>
      <button className="tools-line" onClick={() => setOpen(!open)}>
        <ChevronRight size={13} className="chevron" />
        <span className="names">{names}</span>
        {only && !open && <span className="summary">{only.summary}</span>}
      </button>
      {open &&
        entries.map((entry) => (
          <div key={entry.id} className="tool">
            <button
              className="tool-line"
              disabled={!entry.detail}
              onClick={() => setOpenDetail(openDetail === entry.id ? null : entry.id)}
            >
              <span className="name">{entry.name}</span>
              <span className="summary">{entry.summary}</span>
            </button>
            {openDetail === entry.id && entry.detail && <pre className="detail">{entry.detail}</pre>}
          </div>
        ))}
    </div>
  );
}

const StyledChatPanel = styled.div`
  display: flex;
  flex-flow: column;
  min-height: 0;
  background: ${colors.textBackgroundPanel()};
  color: ${colors.text()};
  font: ${fonts.display({ size: 14, line: "21px" })};

  > .note,
  > .scroller > .note {
    padding: 24px;
    color: ${colors.textSecondary()};
    text-align: center;
  }

  > .scroller {
    flex-grow: 1;
    min-height: 0;
    overflow-y: auto;
    position: relative;
    padding: 16px 18px 8px;
    display: flex;
    flex-flow: column;
    gap: 14px;

    > * {
      flex-shrink: 0;
    }

    > .prompt {
      display: flex;
      justify-content: flex-end;
      padding-left: 36px;

      > .bubble {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        padding: 8px 12px;
        border-radius: 14px;
        background: ${colors.textBackgroundAlt()};
      }
    }

    > .reply {
      overflow-wrap: break-word;
      user-select: text;

      > *:first-child {
        margin-top: 0;
      }
      > *:last-child {
        margin-bottom: 0;
      }

      p,
      ul,
      ol,
      blockquote,
      table,
      > .code {
        margin: 0 0 10px;
      }

      ul,
      ol {
        padding-left: 22px;
      }

      li + li {
        margin-top: 4px;
      }

      li > ul,
      li > ol {
        margin: 4px 0;
      }

      h1,
      h2,
      h3,
      h4 {
        margin: 16px 0 8px;
      }
      h1 {
        font: ${fonts.displayBold({ size: 20, line: "26px" })};
      }
      h2 {
        font: ${fonts.displayBold({ size: 17, line: "23px" })};
      }
      h3,
      h4 {
        font: ${fonts.displayBold({ size: 15, line: "21px" })};
      }

      a {
        color: inherit;
      }

      blockquote {
        padding-left: 12px;
        border-left: 3px solid ${colors.separator()};
        color: ${colors.textSecondary()};
      }

      hr {
        border: none;
        border-top: 1px solid ${colors.separator()};
        margin: 14px 0;
      }

      > .code {
        position: relative;

        > pre {
          margin: 0;
        }

        > .copy {
          position: absolute;
          top: 6px;
          right: 6px;
          padding: 2px 8px;
          border-radius: 6px;
          border: 1px solid ${colors.separator()};
          background: ${colors.textBackground()};
          color: ${colors.textSecondary()};
          font: ${fonts.display({ size: 11, line: "16px" })};
          cursor: pointer;
          opacity: 0;
          transition: opacity 0.15s;
        }

        &:hover > .copy {
          opacity: 1;
        }
      }

      pre {
        background: ${colors.textBackground()};
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid ${colors.separator()};
        overflow-x: auto;
        font: ${fonts.displayMono({ size: 12, line: "18px" })};
      }

      code:not(pre > code) {
        padding: 1px 4px;
        border-radius: 4px;
        background: ${colors.textBackground()};
        border: 1px solid ${colors.separator()};
        overflow-wrap: anywhere;
        font: ${fonts.displayMono({ size: 12.5, line: "18px" })};
      }

      table {
        border-collapse: collapse;
        display: block;
        overflow-x: auto;
        max-width: 100%;
        font: ${fonts.display({ size: 13, line: "19px" })};

        th,
        td {
          padding: 4px 8px;
          text-align: left;
          vertical-align: top;
          border: 1px solid ${colors.separator()};
        }

        th {
          font: ${fonts.displayBold({ size: 13, line: "19px" })};
          background: ${colors.textBackgroundAlt()};
        }
      }

      ${highlightCSS()}
    }

    > .tools {
      margin: -4px 0;
      color: ${colors.textSecondary()};
      font: ${fonts.display({ size: 12, line: "18px" })};

      button {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        min-width: 0;
        padding: 2px 0;
        border: none;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;

        &:disabled {
          cursor: default;
        }
      }

      .chevron {
        flex-shrink: 0;
        transition: transform 0.15s;
      }

      &[data-open="true"] .chevron {
        transform: rotate(90deg);
      }

      .names,
      .name {
        flex-shrink: 0;
        font: ${fonts.displayMedium({ size: 12, line: "18px" })};
      }

      .summary {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font: ${fonts.displayMono({ size: 11.5, line: "18px" })};
      }

      > .tool {
        padding-left: 19px;

        > .detail {
          margin: 2px 0 6px;
          padding: 8px 10px;
          max-height: 300px;
          overflow: auto;
          border-radius: 6px;
          background: ${colors.textBackground()};
          border: 1px solid ${colors.separator()};
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          font: ${fonts.displayMono({ size: 11.5, line: "16px" })};
        }
      }
    }

    > .working {
      color: ${colors.textSecondary()};
      font: ${fonts.display({ size: 12, line: "18px" })};
    }

    > .quote {
      position: absolute;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 5px;
      height: 28px;
      padding: 0 10px;
      border-radius: 14px;
      border: 1px solid ${colors.separator()};
      background: ${colors.textBackground()};
      color: ${colors.text()};
      font: ${fonts.displayMedium({ size: 12, line: "16px" })};
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      cursor: pointer;
    }
  }

  > .composer {
    flex-shrink: 0;
    display: flex;
    align-items: flex-end;
    gap: 6px;
    margin: 6px 12px 12px;
    padding: 6px 6px 6px 12px;
    border-radius: 16px;
    border: 1px solid ${colors.separator()};
    background: ${colors.textBackground()};

    &:focus-within {
      border-color: ${colors.textSecondary({ alpha: 0.5 })};
    }

    > ${StyledTextArea} {
      flex-grow: 1;
      min-width: 0;
      align-self: center;

      > textarea {
        display: block;
        width: 100%;
        padding: 0;
        border: none;
        outline: none;
        resize: none;
        background: transparent;
        color: ${colors.text()};
        font: ${fonts.display({ size: 14, line: "20px" })};
      }
    }

    > .send {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 14px;
      border: none;
      background: ${colors.text()};
      color: ${colors.textBackground()};
      cursor: pointer;

      &:disabled {
        opacity: 0.25;
        cursor: default;
      }
    }
  }
`;

/** highlight.js's classes, in VS Code's colors (as the terminal's are). */
function highlightCSS(): string {
  return `
    .hljs-comment, .hljs-quote { color: #008000; }
    .hljs-keyword, .hljs-literal, .hljs-built_in, .hljs-selector-tag { color: #0000ff; }
    .hljs-string, .hljs-attr + .hljs-string, .hljs-regexp { color: #a31515; }
    .hljs-number { color: #098658; }
    .hljs-title, .hljs-title.function_ { color: #795e26; }
    .hljs-attr, .hljs-variable, .hljs-params, .hljs-property { color: #001080; }
    .hljs-type, .hljs-title.class_ { color: #267f99; }
    .hljs-meta { color: #af00db; }
    .hljs-addition { color: #098658; background: rgba(9, 134, 88, 0.08); }
    .hljs-deletion { color: #a31515; background: rgba(163, 21, 21, 0.08); }

    @media (prefers-color-scheme: dark) {
      .hljs-comment, .hljs-quote { color: #6a9955; }
      .hljs-keyword, .hljs-literal, .hljs-built_in, .hljs-selector-tag { color: #569cd6; }
      .hljs-string, .hljs-attr + .hljs-string, .hljs-regexp { color: #ce9178; }
      .hljs-number { color: #b5cea8; }
      .hljs-title, .hljs-title.function_ { color: #dcdcaa; }
      .hljs-attr, .hljs-variable, .hljs-params, .hljs-property { color: #9cdcfe; }
      .hljs-type, .hljs-title.class_ { color: #4ec9b0; }
      .hljs-meta { color: #c586c0; }
      .hljs-addition { color: #b5cea8; background: rgba(181, 206, 168, 0.1); }
      .hljs-deletion { color: #ce9178; background: rgba(206, 145, 120, 0.1); }
    }
  `;
}
