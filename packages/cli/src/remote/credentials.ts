// The one CLI module that reads the Bandwise token and base URL. The remote commands and the hosted
// hook send the token only as `Authorization: Bearer` to the base URL. It is never printed, logged
// or written to a receipt: errors name the variable, never a value. This mode holds no provider key.

export const TOKEN_ENV = "BANDWISE_TOKEN";
export const BASE_URL_ENV = "BANDWISE_BASE_URL";
export const DEFAULT_BASE_URL = "https://app.bandwise.dev";

export interface Remote {
  token: string;
  /** Origin plus an optional path prefix, with no trailing slash. */
  baseUrl: string;
}

export type RemoteLookup = { kind: "none" } | { kind: "error"; message: string } | { kind: "ok"; remote: Remote };

/** Token characters. Anything else (a space, a newline, a quote) is a paste error, not a token. */
const TOKEN = /^[A-Za-z0-9_-]{8,512}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Check a base URL: https, or http on this machine only, so the token never crosses a network in clear text. */
export function parseBaseUrl(text: string): { ok: true; baseUrl: string } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: `${BASE_URL_ENV} is not a URL` };
  }
  if (url.username !== "" || url.password !== "") return { ok: false, message: `${BASE_URL_ENV} must not carry a user name or password` };
  if (url.search !== "" || url.hash !== "") return { ok: false, message: `${BASE_URL_ENV} must not carry a query or a fragment` };
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return { ok: false, message: `${BASE_URL_ENV} must use https (http is allowed for localhost only)` };
  }
  return { ok: true, baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}` };
}

/** Read the token and base URL. `env` defaults to process.env; tests pass their own. */
export function readRemote(env: Readonly<Record<string, string | undefined>> = process.env): RemoteLookup {
  const token = env[TOKEN_ENV]?.trim() ?? "";
  if (token === "") return { kind: "none" };
  if (!TOKEN.test(token)) return { kind: "error", message: `${TOKEN_ENV} does not look like a Bandwise token (sk_live_, sk_test_ or sa_live_ followed by letters, digits, _ and -)` };
  const base = parseBaseUrl(env[BASE_URL_ENV]?.trim() || DEFAULT_BASE_URL);
  if (!base.ok) return { kind: "error", message: base.message };
  return { kind: "ok", remote: { token, baseUrl: base.baseUrl } };
}

/** Replace every copy of the token in text. The last guard before anything is printed. */
export function scrubToken(text: string, token: string): string {
  return token === "" ? text : text.split(token).join("[redacted]");
}
