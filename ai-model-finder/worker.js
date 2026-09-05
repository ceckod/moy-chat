// Cloudflare Worker: прокси, което сваля произволна страница и я връща с CORS хедъри.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    if (!target) return new Response('Липсва ?url=...', { status: 400 });

    // Основна валидност на URL-а, преди да го подадем на fetch() — без
    // това невалиден/празен ?url= (напр. само "?url=" или счупен формат)
    // хвърля некатчнат TypeError вътре във fetch() и Worker-ът връща гол
    // 500 без никакво обяснение защо.
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch (e) {
      return new Response('Невалиден ?url= параметър: ' + target, { status: 400 });
    }

    try {
      const r = await fetch(targetUrl.toString(), {
        headers: { 'User-Agent': 'Mozilla/5.0 (AI Model Finder; +' + url.origin + ')' }
      });
      const text = await r.text();
      return new Response(text, {
        status: r.status,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'text/plain; charset=utf-8'
        }
      });
    } catch (e) {
      // Целевият сайт е недостъпен/timeout/DNS грешка и т.н. — връщаме
      // ясен 502 с CORS хедъри (без CORS хедъри браузърът показва generic
      // "Failed to fetch" вместо реалната причина).
      return new Response('Прокси грешка: ' + e.message, {
        status: 502,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};
