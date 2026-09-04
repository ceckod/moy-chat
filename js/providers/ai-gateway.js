// js/providers/ai-gateway.js

/**
 * Безопасно извличане на чист JSON от AI отговор (премахва Markdown и свободен текст)
 */
export function extractCleanJSON(rawText) {
  if (!rawText) return null;
  try {
    // Премахване на markdown JSON обвивки
    const cleaned = rawText
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    
    // Намиране на първия валиден JSON обект или масив
    const jsonMatch = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!jsonMatch) return null;
    
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('[AI Gateway] Грешка при парсване на JSON:', e, rawText);
    return null;
  }
}

/**
 * Изпълнение на AI заявка с автоматичен Fallback и Timeout
 */
export async function executeAIQuery({ primaryProvider, fallbackProvider, prompt, options = {} }) {
  const timeoutMs = options.timeoutMs || 15000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await primaryProvider(prompt, { signal: controller.signal, ...options });
    clearTimeout(timeoutId);
    
    const parsed = extractCleanJSON(response);
    if (parsed) return parsed;
    
    throw new Error('Невалидна JSON структура от първичния провайдър');
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn('[AI Gateway] Първичният провайдър отказа или се забави. Пренасочване към Fallback...', err.message);
    
    if (fallbackProvider) {
      try {
        const fallbackResponse = await fallbackProvider(prompt, options);
        return extractCleanJSON(fallbackResponse);
      } catch (fallbackErr) {
        console.error('[AI Gateway] Критична грешка: И Fallback провайдърът отказа.', fallbackErr);
        throw fallbackErr;
      }
    }
    throw err;
  }
}
