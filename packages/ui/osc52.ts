import type { Terminal } from "@xterm/xterm";

/** More than any selection; a program flooding the clipboard is ignored. */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Programs setting the clipboard through the terminal (OSC 52), as Claude
 * Code does over SSH and Miks's own pbcopy always does: the text goes on the
 * clipboard of the Mac this window is on, which for a window on another Mac
 * is the one you're at. Reading the clipboard (`?`) is never answered.
 */
export function handleClipboardWrites(terminal: Terminal, copy: (text: string) => void) {
  terminal.parser.registerOscHandler(52, (data) => {
    const text = decodeClipboardWrite(data);
    if (text !== null) copy(text);
    return true;
  });
}

/** The text an OSC 52 payload (`c;<base64>`) sets, or null for anything else. */
export function decodeClipboardWrite(data: string): string | null {
  const separator = data.indexOf(";");
  if (separator === -1) return null;

  const encoded = data.slice(separator + 1);
  if (encoded === "?" || encoded.length > (MAX_BYTES * 4) / 3 + 4) return null;

  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
