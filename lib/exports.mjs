import JSZip from 'jszip';
import ExcelJS from 'exceljs';

const xml = value => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const plain = text => text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(s => plain(s.trim().replace(/\\\|/g, '|')));

// A small, bounded subset of Markdown. Model output is data, never executable code.
export function blocks(answer) {
  if (typeof answer !== 'string' || answer.length > 500000) throw new Error('Ответ слишком большой для экспорта.');
  const lines = answer.replace(/\r\n?/g, '\n').split('\n'), result = [];
  let code = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) { code = !code; continue; }
    if (!code && line.includes('|') && lines[i + 1] && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]) && cells(lines[i + 1]).every(c => /^:?-{3,}:?$/.test(c))) {
      const rows = [cells(line)]; i++;
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) rows.push(cells(lines[++i]));
      if (rows.length > 5000 || rows.some(r => r.length > 50)) throw new Error('Таблица слишком большая для экспорта.');
      result.push({ type: 'table', rows });
    } else {
      const heading = !code && line.match(/^(#{1,3})\s+(.*)$/);
      result.push({ type: heading ? 'heading' : 'paragraph', level: heading ? heading[1].length : 0, text: code ? line : plain(heading ? heading[2] : line), code });
    }
  }
  return result;
}

function paragraph(text, level = 0, code = false) {
  return `<w:p><w:pPr>${level ? `<w:outlineLvl w:val="${level - 1}"/>` : ''}<w:spacing w:after="120"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="${code ? 'Consolas' : 'Calibri'}" w:hAnsi="${code ? 'Consolas' : 'Calibri'}"/>${level ? '<w:b/>' : ''}<w:sz w:val="${level ? 34 - level * 2 : 22}"/></w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
}

export async function exportAnswer(answer, format) {
  const parts = blocks(answer);
  if (format === 'docx') {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    const body = parts.map(p => p.type !== 'table' ? paragraph(p.text, p.level, p.code) : `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${['top','left','bottom','right','insideH','insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:color="DCE2EF"/>`).join('')}</w:tblBorders></w:tblPr>${p.rows.map((row, i) => `<w:tr>${i === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${row.map(cell => `<w:tc><w:tcPr>${i === 0 ? '<w:shd w:fill="EDF2FF"/>' : ''}</w:tcPr>${paragraph(cell)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`).join('');
    zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`);
    return { buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook(); workbook.creator = 'Company Assistant';
    const tables = parts.filter(p => p.type === 'table');
    const text = workbook.addWorksheet('Ответ'); text.getColumn(1).width = 100;
    // Excel limits a string cell to 32767 UTF-16 code units. Split without losing content.
    for (const line of answer.split('\n')) for (let start = 0; start < Math.max(1, line.length); start += 30000) text.addRow([line.slice(start, start + 30000)]);
    text.eachRow(row => { row.alignment = { wrapText: true, vertical: 'top' }; });
    tables.forEach((table, i) => {
      const sheet = workbook.addWorksheet(`Таблица ${i + 1}`, { views: [{ state: 'frozen', ySplit: 1 }] });
      table.rows.forEach(row => sheet.addRow(row.map(value => {
        if (value.length > 32767) throw new Error('Содержимое ячейки превышает лимит Excel. Скачайте Word или текст.');
        // Plain strings cannot become formulas, hyperlinks or external connections.
        return value;
      })));
      sheet.columns.forEach(column => { column.width = 26; });
      sheet.eachRow((row, n) => { row.alignment = { wrapText: true, vertical: 'top' }; if (n === 1) { row.font = { bold: true }; row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDF2FF' } }; } });
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: table.rows.length, column: table.rows[0].length } };
    });
    return { buffer: Buffer.from(await workbook.xlsx.writeBuffer()), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
  throw new Error('Формат экспорта не поддерживается.');
}
