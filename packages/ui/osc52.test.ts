import { expect, test } from "vitest";
import { decodeClipboardWrite } from "./osc52";

const encode = (text: string) => Buffer.from(text).toString("base64");

test("an OSC 52 write decodes to its text, UTF-8 and all", () => {
  expect(decodeClipboardWrite(`c;${encode("héllo\nworld ✳")}`)).toBe("héllo\nworld ✳");
  expect(decodeClipboardWrite(`;${encode("no selection named")}`)).toBe("no selection named");
});

test("reads and garbage set nothing", () => {
  expect(decodeClipboardWrite("c;?")).toBeNull();
  expect(decodeClipboardWrite("nothing")).toBeNull();
  expect(decodeClipboardWrite("c;%%%")).toBeNull();
  // Not UTF-8.
  expect(decodeClipboardWrite(`c;${Buffer.from([0xff, 0xfe]).toString("base64")}`)).toBeNull();
});
