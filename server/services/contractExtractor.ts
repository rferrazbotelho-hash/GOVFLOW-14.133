import * as cheerio from 'cheerio';
import JSZip from 'jszip';
import { extractTextItems, type StructuredTextItem } from 'unpdf';
import type { ContractExtractionPreview, ContractSourceFormat } from '../../shared/types.js';
import { normalizeUtf8Text } from '../../shared/typography.js';

function detectContractFileFormat(filename: string, mimetype?: string): ContractSourceFormat {
  const lower = (filename || '').toLowerCase();
  const mime = (mimetype || '').toLowerCase();

  if (lower.endsWith('.pdf') || mime.includes('pdf')) return 'PDF';
  if (
    /\.(docx|doc)$/i.test(lower) ||
    mime.includes('wordprocessingml') ||
    mime.includes('msword') ||
    mime.includes('word')
  ) {
    return 'WORD';
  }
  if (/\.(html|htm)$/i.test(lower) || mime.includes('text/html')) {
    return 'HTML';
  }
  if (/\.(txt|md|markdown|rtf|csv|json|xml)$/i.test(lower) || mime.startsWith('text/') || mime.includes('rtf')) {
    return 'TXT';
  }

  throw new Error(
    `Formato de contrato não suportado ("${filename}"). Envie em PDF (.pdf), Word (.docx / .doc), HTML (.html) ou Texto (.txt / .rtf).`
  );
}

function decodeTextBuffer(buffer: Buffer): string {
  // Strip UTF-8 BOM if present
  const hasUtf8Bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  let text = buffer.subarray(hasUtf8Bom ? 3 : 0).toString('utf8');
  if (text.includes('\ufffd')) {
    text = buffer.toString('latin1');
  }
  return text;
}

function stripRtfControls(raw: string): string {
  return raw
    .replace(/\\par[d]?\b/gi, '\n')
    .replace(/\\tab\b/gi, '\t')
    .replace(/\\line\b/gi, '\n')
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? Buffer.from([code]).toString('latin1') : '';
    })
    .replace(/\\u(-?\d+)\??/g, (_, codeStr: string) => {
      const num = Number.parseInt(codeStr, 10);
      const cp = num < 0 ? 65536 + num : num;
      return Number.isFinite(cp) ? String.fromCharCode(cp) : '';
    })
    .replace(/\{\\\*?[^{}]*\}/g, ' ')
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, '')
    .replace(/[{}]/g, '');
}

export function extractPlainTextFromHtml(html: string): string {
  const formatted = (html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|h1|h2|h3|h4|h5|h6|li|tr|div|blockquote|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ');
  const $ = cheerio.load(`<div id="__contract_root">${formatted}</div>`, null, false);
  return normalizeUtf8Text($('#__contract_root').text())
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractParagraphTextFromWordXml($: cheerio.CheerioAPI, pEl: any): string {
  const pieces: string[] = [];
  $(pEl)
    .find('w\\:t, w\\:tab, w\\:br')
    .each((_, node: any) => {
      const tag = (node.tagName || node.name || '').toLowerCase();
      if (tag === 'w:tab') {
        pieces.push(' ');
      } else if (tag === 'w:br') {
        pieces.push('\n');
      } else {
        pieces.push($(node).text());
      }
    });
  return pieces.join('').replace(/[ \t]+/g, ' ').trim();
}

async function extractWordContractText(buffer: Buffer): Promise<{ text: string; diagnostics: string[] }> {
  const isZip = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (isZip) {
    const zip = await JSZip.loadAsync(buffer);
    const docEntry = zip.file('word/document.xml');
    if (!docEntry) {
      throw new Error('Arquivo .docx inválido: word/document.xml não encontrado.');
    }

    const lines: string[] = [];

    // Cabeçalho principal (quando houver identificação do órgão / nº do contrato)
    const headerNames = Object.keys(zip.files)
      .filter((name) => /^word\/header\d*\.xml$/i.test(name))
      .sort();
    for (const hName of headerNames.slice(0, 1)) {
      const hXml = await zip.file(hName)!.async('text');
      const $h = cheerio.load(hXml, { xmlMode: true });
      $h('w\\:p').each((_, p) => {
        const t = extractParagraphTextFromWordXml($h, p);
        if (t) lines.push(t);
      });
    }

    const xml = await docEntry.async('text');
    const $ = cheerio.load(xml, { xmlMode: true });

    let paraCount = 0;
    let tableCount = 0;

    // Preserva a ordem exata de parágrafos e tabelas no corpo do contrato
    $('w\\:body')
      .children()
      .each((_, node: any) => {
        const tag = (node.tagName || node.name || '').toLowerCase();
        if (tag === 'w:p') {
          const txt = extractParagraphTextFromWordXml($, node);
          if (txt) {
            lines.push(txt);
            paraCount++;
          }
        } else if (tag === 'w:tbl') {
          tableCount++;
          $(node)
            .find('w\\:tr')
            .each((__, tr) => {
              if ($(tr).closest('w\\:tbl')[0] !== node) return;
              const cells = $(tr)
                .find('w\\:tc')
                .filter((___, tc) => $(tc).closest('w\\:tr')[0] === tr)
                .map((___, tc) => {
                  const paras = $(tc)
                    .find('w\\:p')
                    .map((____, p) => extractParagraphTextFromWordXml($, p))
                    .get()
                    .filter(Boolean);
                  return paras.join(' ').replace(/\s+/g, ' ').trim();
                })
                .get()
                .filter(Boolean);
              if (cells.length > 0) {
                lines.push(cells.join(' | '));
              }
            });
        }
      });

    // Fallback se w:body não estiver presente diretamente
    if (lines.length === 0) {
      $('w\\:p').each((_, p) => {
        const txt = extractParagraphTextFromWordXml($, p);
        if (txt) lines.push(txt);
      });
    }

    const text = normalizeUtf8Text(lines.join('\n')).replace(/\n{3,}/g, '\n\n').trim();
    return {
      text,
      diagnostics: [`Documento Word (.docx): ${paraCount} parágrafo(s) e ${tableCount} tabela(s) extraídos em ordem de leitura.`]
    };
  }

  const head = buffer.toString('utf8', 0, Math.min(buffer.length, 600)).trim();
  if (/^<(?:!doctype|html|table|\?xml)/i.test(head)) {
    const text = extractPlainTextFromHtml(decodeTextBuffer(buffer));
    return {
      text,
      diagnostics: ['Documento Word legado em HTML/XML extraído com preservação de parágrafos e tabelas.']
    };
  }

  if (head.startsWith('{\\rtf')) {
    const text = normalizeUtf8Text(stripRtfControls(decodeTextBuffer(buffer)))
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return {
      text,
      diagnostics: ['Documento RTF convertido para texto estruturado.']
    };
  }

  // Fallback para .doc binário OLE2
  const utf16Text = buffer.toString('utf16le').replace(/[^\x20-\x7E\u00A0-\u00FF\r\n\t]/g, ' ');
  const utf16Lines = utf16Text
    .split(/\r?\n+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 6 && /[a-zA-ZÀ-ú]{3,}/.test(l));

  if (utf16Lines.length >= 4) {
    return {
      text: normalizeUtf8Text(utf16Lines.join('\n')),
      diagnostics: ['Arquivo .doc binário legado lido em modo texto (para maior fidelidade, prefira .docx ou .pdf).']
    };
  }

  const latinLines = buffer
    .toString('latin1')
    .replace(/[^\x20-\x7E\u00A0-\u00FF\r\n\t]/g, ' ')
    .split(/\r?\n+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 12 && /[a-zA-ZÀ-ú]{4,}/.test(l));

  return {
    text: normalizeUtf8Text(latinLines.join('\n')),
    diagnostics: [
      latinLines.length > 0
        ? 'Arquivo .doc binário legado extraído por varredura de texto.'
        : 'Arquivo .doc binário legado sem texto legível; converta para .docx ou .pdf ou cole o texto.'
    ]
  };
}

function reconstructPdfLines(items: StructuredTextItem[]): string[] {
  const cleanItems = items
    .map((it) => ({ ...it, str: (it.str || '').trim() }))
    .filter((it) => it.str.length > 0);
  if (cleanItems.length === 0) return [];

  cleanItems.sort((a, b) => {
    const dy = b.y - a.y;
    if (Math.abs(dy) > 2.5) return dy;
    return a.x - b.x;
  });

  const rows: StructuredTextItem[][] = [];
  for (const it of cleanItems) {
    const last = rows[rows.length - 1];
    if (!last) {
      rows.push([it]);
      continue;
    }
    const ref = last[0];
    const tol = Math.max(3.2, (ref.fontSize || 10) * 0.45);
    if (Math.abs(it.y - ref.y) <= tol) {
      last.push(it);
    } else {
      rows.push([it]);
    }
  }

  return rows
    .map((cluster) => {
      cluster.sort((a, b) => a.x - b.x);
      let line = '';
      let prevEndX = -1;
      for (const item of cluster) {
        const gap = prevEndX < 0 ? 0 : item.x - prevEndX;
        line = !line ? item.str : gap > 1.2 ? `${line} ${item.str}` : `${line}${item.str}`;
        prevEndX = item.x + Math.max(item.width || 0, item.str.length * 3);
      }
      return line.replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean);
}

async function extractPdfContractText(buffer: Buffer): Promise<{ text: string; diagnostics: string[] }> {
  const { totalPages, items } = await extractTextItems(new Uint8Array(buffer));
  const allLines: string[] = [];
  for (const pageItems of items) {
    const pageLines = reconstructPdfLines(pageItems);
    if (pageLines.length > 0) {
      allLines.push(...pageLines, '');
    }
  }
  const text = normalizeUtf8Text(allLines.join('\n')).replace(/\n{3,}/g, '\n\n').trim();
  return {
    text,
    diagnostics: [
      `PDF (${totalPages} página(s)): ${allLines.filter(Boolean).length} linha(s) extraída(s) com ordenação visual.`
    ]
  };
}

export async function extractContractDocument(
  buffer: Buffer,
  filename: string,
  mimetype?: string
): Promise<ContractExtractionPreview> {
  if (!buffer || buffer.length === 0) {
    throw new Error('O arquivo enviado está vazio.');
  }

  const format = detectContractFileFormat(filename, mimetype);
  let extractedText = '';
  let diagnostics: string[] = [];

  if (format === 'PDF') {
    const res = await extractPdfContractText(buffer);
    extractedText = res.text;
    diagnostics = res.diagnostics;
  } else if (format === 'WORD') {
    const res = await extractWordContractText(buffer);
    extractedText = res.text;
    diagnostics = res.diagnostics;
  } else if (format === 'HTML') {
    extractedText = extractPlainTextFromHtml(decodeTextBuffer(buffer));
    diagnostics = ['Documento HTML convertido para texto limpo preservando estrutura.'];
  } else {
    const raw = decodeTextBuffer(buffer);
    extractedText = raw.trimStart().startsWith('{\\rtf')
      ? normalizeUtf8Text(stripRtfControls(raw)).replace(/\n{3,}/g, '\n\n').trim()
      : normalizeUtf8Text(raw).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    diagnostics = ['Arquivo de texto lido integralmente em UTF-8.'];
  }

  if (!extractedText || extractedText.length < 30) {
    throw new Error(
      `Não foi possível extrair texto suficiente do arquivo "${filename}" (${format}). Se for um PDF digitalizado apenas como imagem, realize OCR antes de enviar ou cole o texto do contrato diretamente.`
    );
  }

  return {
    filename,
    format,
    char_count: extractedText.length,
    extracted_text: extractedText,
    diagnostics
  };
}
