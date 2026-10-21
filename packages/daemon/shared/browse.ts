// What `miks browse` (and the address bar of the panel's browser) take for a
// web address.

/**
 * What `miks browse` was given, as a URL: a scheme as given, a bare port
 * (`3000`) for this Mac's, and `localhost:3000`, an IP or a name with no
 * dots over plain HTTP, as a dev server would be; anything else over HTTPS.
 */
export function browseUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return `http://localhost:${text}/`;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
    ? text
    : `${isLocalHost(text.split(/[/:?#]/)[0]) ? "http" : "https"}://${text}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const isLocalHost = (host: string) =>
  host === "localhost" || host.endsWith(".localhost") || !host.includes(".") || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[");
