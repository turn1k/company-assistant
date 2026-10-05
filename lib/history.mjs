export const HISTORY_LIMIT = 10;
export const CONTEXT_LIMIT = 5;
export const ATTACHMENT_IDLE_MS = 24 * 60 * 60 * 1000;

const size = content => typeof content === 'string' ? Buffer.byteLength(content, 'utf8') + 16
  : content.reduce((total, part) => total + (part.type === 'image_url' ? 8192 : Buffer.byteLength(part.text, 'utf8') + 16), 0);

// Keep complete, consecutive pairs, newest first in priority. Never truncate a document.
export function conversationContext(rows, prepared, maxTokens) {
  let upperBound = prepared.upperBound;
  const messages = [];
  let omittedAttachments = false;
  for (const row of rows.slice(0, CONTEXT_LIMIT)) {
    const hasFiles = JSON.parse(row.files).length > 0;
    const fallback = row.prompt + (hasFiles ? '\n[Вложения этого запроса не включены. Для анализа оригинала попроси прикрепить файл заново.]' : '');
    let content = row.context ? JSON.parse(row.context) : fallback;
    let cost = size(content) + size(row.answer) + 32;
    if (upperBound + cost > maxTokens) {
      content = fallback;
      cost = size(content) + size(row.answer) + 32;
    }
    if (upperBound + cost > maxTokens) break;
    if (hasFiles && typeof content === 'string') omittedAttachments = true;
    messages.unshift({ role: 'user', content }, { role: 'assistant', content: row.answer });
    upperBound += cost;
  }
  return { messages, upperBound, omittedAttachments };
}
