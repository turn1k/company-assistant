import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import sharp from 'sharp';
const reply = result => process.send(result, () => process.disconnect());
process.once('message', async ({ file, maxBytes }) => {
try {
  let text = '';
  const parts = [];
  const bytes = await readFile(file.path);
  const check = () => { if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`В «${file.name}» слишком много текста для текущего лимита. Выберите нужные страницы или строки; текст не обрезан.`); };
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(file.ext)) {
    const meta = await sharp(bytes, { limitInputPixels: 40000000, animated: false }).metadata();
    if (!['jpeg', 'png', 'webp'].includes(meta.format)) throw new Error('Некорректное изображение.');
    const image = await sharp(bytes, { limitInputPixels: 40000000 }).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
    reply({ image: `data:image/jpeg;base64,${image.toString('base64')}` });
  } else {
    if (file.ext === '.txt' || file.ext === '.csv') {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) throw new Error('Текстовый файл содержит двоичные данные.');
    } else if (file.ext === '.docx') {
      const mammoth = await import('mammoth');
      text = (await mammoth.extractRawText({ buffer: bytes })).value;
    } else if (file.ext === '.xlsx') {
      const { default: ExcelJS } = await import('exceljs');
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(bytes);
      for (const sheet of book.worksheets) {
        text += `\nЛист: ${sheet.name}\n`;
        sheet.eachRow(row => { text += row.values.slice(1).map(v => typeof v === 'object' && v !== null ? String(v.result ?? v.text ?? (v.richText || []).map(x => x.text).join('')) : String(v ?? '')).join('\t') + '\n'; check(); });
      }
    } else if (file.ext === '.pdf') {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const standardFontDataUrl = path.join(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts').replaceAll('\\', '/') + '/';
      const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, standardFontDataUrl, maxImageSize: 40000000 }).promise;
      let scans = 0;
      try {
      if (doc.numPages > 200) throw new Error('В PDF больше 200 страниц. Выберите нужные страницы.');
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const pageText = (await page.getTextContent()).items.map(item => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join('');
        const label = `\nСтраница ${i}\n`;
        text += label + pageText + '\n'; check();
        parts.push({ type: 'text', text: label + pageText });
        if (!pageText.trim()) {
          scans++;
          if (scans > 12 || scans * 8192 + Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Сканированные страницы PDF превышают лимит запроса. Выберите меньше страниц; документ не обрезан.');
          const original = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(2, 2000 / Math.max(original.width, original.height)) });
          const canvas = doc.canvasFactory.create(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
          try {
            await page.render({ canvasContext: canvas.context, viewport }).promise;
            const image = canvas.canvas.toBuffer('image/jpeg', 90);
            parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}`, detail: 'high' } });
          } finally { doc.canvasFactory.destroy(canvas); }
        }
        page.cleanup();
      }
      } finally { await doc.destroy(); }
    }
    check();
    if (!text.trim()) throw new Error('В файле не найден текст.');
    reply({ text, ...(parts.length ? { parts } : {}) });
  }
} catch (error) {
  reply({ error: error.message?.startsWith('В «') || /страниц|слоя|формат|данные|изображение|не найден/.test(error.message) ? error.message : `Не удалось прочитать «${file.name}». Файл может быть повреждён, защищён паролем или иметь неподдерживаемую кодировку.` });
}

});
