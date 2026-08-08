// Cloudflare Worker: прокси, което сваля произволна страница и я връща с CORS хедъри.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    if (!target) return new Response('Липсва ?url=...', { status: 400 });

    const r = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (AI Model Finder; +' + url.origin + ')' }
    });
    const text = await r.text();
    return new Response(text, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/plain; charset=utf-8'
      }
    });
  }
};
