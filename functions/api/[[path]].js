
/**
 * Cloudflare Pages same-origin proxy for Crypto Terminal API.
 * /api/login is protected by Cloudflare Access; after Access authenticates
 * the visitor, this handler returns them to the public app homepage.
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);

  if (url.pathname === "/api/login") {
    return Response.redirect(url.origin + "/", 302);
  }

  const binding = context.env && context.env.CRYPTO_API;

  if (!binding || typeof binding.fetch !== "function") {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "CRYPTO_API service binding is not configured"
      }),
      {
        status: 503,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        }
      }
    );
  }

  return binding.fetch(context.request);
}
