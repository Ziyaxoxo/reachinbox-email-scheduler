import { NextRequest, NextResponse } from "next/server";

/**
 * Reverse proxy for /api/v1/* to the backend.
 *
 * This replaces a `rewrites()` entry in next.config.js. That approach cannot
 * work for cookie-based auth: Next's external rewrite forwards Authorization but
 * silently drops the Cookie request header, so the session cookie never reaches
 * the API and every authenticated call comes back 401. This handler forwards the
 * headers explicitly.
 *
 * The API origin is read from the environment on every request rather than at
 * build time, so the container needs no build argument and no baked-in host.
 */

/**
 * Request headers that must not be forwarded.
 *
 * Hop-by-hop headers belong to the single connection being replaced, and
 * `host` would describe this container rather than the API. `accept-encoding` is
 * dropped so the API replies uncompressed: this handler forwards the body
 * verbatim and would otherwise hand the client a `content-encoding` header that
 * no longer describes the bytes it received.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "accept-encoding",
]);

/** Response headers to drop for the same reason. */
const STRIP_FROM_RESPONSE = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

/**
 * Resolve and validate the API origin.
 *
 * The upstream host comes only from the environment. Path segments come from the
 * request, so they are re-encoded individually below: a raw segment containing
 * `/`, `..` or a scheme would otherwise be able to redirect the proxy at a
 * different host.
 */
function apiOrigin(): string {
  const raw = (process.env.API_URL || "").trim().replace(/\/+$/, "");
  if (!raw) {
    throw new Error("API_URL is not set on the web service");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`API_URL is not a valid absolute URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`API_URL must be http or https, got ${parsed.protocol}`);
  }
  return raw;
}

type Params = { params: { path: string[] } };

async function proxy(request: NextRequest, { params }: Params): Promise<Response> {
  let origin: string;
  try {
    origin = apiOrigin();
  } catch (error) {
    // 502 rather than 500: the browser is not at fault and nothing is logged
    // as an application error.
    return NextResponse.json(
      {
        error: {
          code: "PROXY_MISCONFIGURED",
          message: error instanceof Error ? error.message : "Proxy is not configured",
        },
      },
      { status: 502 },
    );
  }

  const segments = (params.path ?? []).map((s) => encodeURIComponent(s));
  const target = `${origin}/api/v1/${segments.join("/")}${request.nextUrl.search}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      // Buffered rather than streamed: the payloads are small JSON documents
      // and buffering avoids depending on undici's `duplex: "half"` handling.
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: "manual",
      cache: "no-store",
    });
  } catch (error) {
    // "fetch failed" hides the real cause in `error.cause`, which is where undici
    // puts connection-level detail. Logged or this is undiagnosable.
    const cause = error instanceof Error ? (error.cause as Error | undefined) : undefined;
    console.error(
      `[proxy] ${method} ${target} failed: ${error instanceof Error ? error.message : error}`,
      cause ? `cause: ${cause.message}` : "",
    );
    return NextResponse.json(
      {
        error: {
          code: "UPSTREAM_UNREACHABLE",
          message: error instanceof Error ? error.message : "Could not reach the API",
        },
      },
      { status: 502 },
    );
  }

  const outHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_FROM_RESPONSE.has(key.toLowerCase())) outHeaders.set(key, value);
  });

  // `Location` is passed through untouched, so the OAuth redirect reaches the
  // browser with the absolute Google URL the API produced.
  const location = upstream.headers.get("location");
  if (location) outHeaders.set("location", location);

  // `Set-Cookie` can legitimately appear more than once. set() would collapse
  // them into one comma-joined value and corrupt the session cookie, so
  // getSetCookie() is used to preserve each cookie separately.
  const setCookies =
    typeof upstream.headers.getSetCookie === "function"
      ? upstream.headers.getSetCookie()
      : [];
  for (const cookie of setCookies) outHeaders.append("set-cookie", cookie);

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;

// Never cache an authenticated response on a shared CDN.
export const dynamic = "force-dynamic";
