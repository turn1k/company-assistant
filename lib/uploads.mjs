import Busboy from 'busboy';
import { createWriteStream } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fork } from 'node:child_process';

export const extensions = new Set(['.txt', '.csv', '.pdf', '.docx', '.xlsx', '.jpg', '.jpeg', '.png', '.webp']);
export async function receiveUpload(req, directory, limits) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    let parser;
    try { parser = Busboy({ headers: req.headers, limits: { files: limits.files, fileSize: limits.fileMB * 1024 ** 2, fields: 2, fieldSize: 512000, parts: limits.files + 2 } }); }
    catch { reject(new Error('Некорректная загрузка.')); return; }
    const files = [], writes = [];
    let prompt = '', chatId, size = 0, error;
    const seenFields = new Set();
    const fail = message => { error ||= new Error(message); };
    parser.on('field', (name, value, info) => {
      if (!['prompt', 'chatId'].includes(name) || info.valueTruncated || seenFields.has(name)) fail('Слишком длинный или некорректный запрос.');
      else if (name === 'prompt') prompt = value.trim();
      else if (value === 'new' || /^[a-f0-9-]{36}$/.test(value)) chatId = value;
      else fail('Некорректный чат. Обновите страницу.');
      seenFields.add(name);
    });
    parser.on('file', (field, stream, info) => {
      const name = path.basename(info.filename || '').replace(/[\x00-\x1f]/g, '').slice(0, 160);
      const ext = path.extname(name).toLowerCase();
      if (field !== 'files' || !extensions.has(ext)) { fail('Поддерживаются PDF, DOCX, XLSX, CSV, TXT, JPG, PNG и WebP.'); stream.resume(); return; }
      const file = { id: randomUUID(), name, ext, size: 0 };
      file.path = path.join(directory, file.id);
      files.push(file);
      stream.on('data', chunk => {
        size += chunk.length; file.size += chunk.length;
        if (size > limits.totalMB * 1024 ** 2) {
          fail(`Общий размер файлов превышает ${limits.totalMB} МБ.`);
          stream.destroy(error);
        }
      });
      stream.on('limit', () => fail(`Файл превышает ${limits.fileMB} МБ.`));
      // Settle every stream before returning so failed uploads can be removed safely.
      writes.push(pipeline(stream, createWriteStream(file.path, { flags: 'wx', mode: 0o600 })).catch(e => { error ||= e; }));
    });
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.on(event, () => fail(`Не более ${limits.files} файлов на запрос.`));
    req.on('aborted', () => parser.destroy(new Error('Загрузка прервана.')));
    parser.on('error', async e => { await Promise.all(writes); reject(error || e); });
    parser.on('close', async () => {
      await Promise.all(writes);
      if (error) reject(error);
      else if (!prompt && !files.length) reject(new Error('Введите запрос или прикрепите файл.'));
      else resolve({ prompt: prompt || 'Проанализируй приложенные файлы.', files, chatId });
    });
    req.pipe(parser);
  });
}

// Separate processes also isolate native PDF/image library failures from the HTTP server.
export async function parseFile(file, maxBytes) {
  return new Promise((resolve, reject) => {
    const worker = fork(new URL('./parse-worker.mjs', import.meta.url), [], { execArgv: ['--max-old-space-size=192'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    worker.send({ file, maxBytes });
    const timer = setTimeout(() => { worker.kill(); reject(new Error(`Не удалось обработать «${file.name}» за 30 секунд. Уменьшите файл.`)); }, 30000);
    worker.once('message', result => { clearTimeout(timer); result.error ? reject(new Error(result.error)) : resolve(result); });
    worker.once('error', () => { clearTimeout(timer); reject(new Error(`Не удалось прочитать «${file.name}». Проверьте формат и размер файла.`)); });
    worker.once('exit', code => { clearTimeout(timer); reject(new Error(`Обработка «${file.name}» остановлена.`)); });
  });
}
export async function prepareContent(prompt, files, maxTokens) {
  const content = [{ type: 'text', text: prompt }];
  let upperBound = Buffer.byteLength(prompt, 'utf8') + 512;
  for (const file of files) {
    const parsed = await parseFile(file, Math.max(1, maxTokens - upperBound));
    if (parsed.parts) {
      const label = `\nДокумент: ${file.name}\n`;
      content.push({ type: 'text', text: label }, ...parsed.parts);
      upperBound += Buffer.byteLength(label, 'utf8') + 16;
      for (const part of parsed.parts) upperBound += part.type === 'image_url' ? 8192 : Buffer.byteLength(part.text, 'utf8') + 16;
    } else if (parsed.image) {
      content.push({ type: 'image_url', image_url: { url: parsed.image, detail: 'high' } });
      // Conservative provisional reserve, not an exact Luna image tokenizer.
      upperBound += 8192;
    } else {
      const text = `\nДокумент: ${file.name}\n${parsed.text}`;
      upperBound += Buffer.byteLength(text, 'utf8') + 16;
      content.push({ type: 'text', text });
    }
    if (upperBound > maxTokens) throw new Error(`Документы превышают безопасную предварительную оценку лимита ${maxTokens.toLocaleString('ru')} токенов. Выберите меньше страниц или файлов. Текст не обрезан.`);
  }
  if (upperBound > maxTokens) throw new Error('Запрос слишком длинный. Сократите текст.');
  return { content, upperBound };
}
