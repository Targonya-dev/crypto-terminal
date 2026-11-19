/**
 * Cloudflare Pages same-origin proxy for Crypto Terminal API.
 * Configure a Pages Service Binding named CRYPTO_API pointing to
 * the crypto-terminal-api Worker. This preserves Cloudflare Access headers
 * and avoids exposing the Worker/GitHub credentials to the browser.
 */
export async function onRequest(context) {
  const binding = context.env && context.env.CRYPTO_API;
  if (!binding || typeof binding.fetch !== 'function') {
    return new Response(JSON.stringify({ ok: false, error: 'CRYPTO_API service binding is not configured' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  return binding.fetch(context.request);
}
