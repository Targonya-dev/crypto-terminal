/**
 * Same-origin API proxy for Crypto Terminal Pages.
 * Cloudflare Access injects Cf-Access-Jwt-Assertion after authenticating the
 * browser request. Forward that signed assertion to the API Worker over a
 * Service Binding; the API Worker independently verifies signature, issuer,
 * expiry, and the Pages application's AUD.
 */
export async function onRequest(context) {
  const { request, env } = context;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: "Authentication required" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (!env.CRYPTO_API || typeof env.CRYPTO_API.fetch !== "function") {
    return new Response(JSON.stringify({ ok: false, error: "API service binding is not configured" }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const incomingUrl = new URL(request.url);
  const targetUrl = `https://crypto-terminal-api.internal${incomingUrl.pathname}${incomingUrl.search}`;
  const headers = new Headers(request.headers);
  headers.set("Cf-Access-Jwt-Assertion", token);
  headers.delete("cookie");
  headers.delete("authorization");

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;

  return env.CRYPTO_API.fetch(new Request(targetUrl, init));
}
