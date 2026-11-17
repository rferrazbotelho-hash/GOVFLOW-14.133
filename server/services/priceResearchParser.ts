import { createRequire } from 'node:module';
import * as cheerio from 'cheerio';
import JSZip from 'jszip';
import { extractTextItems, type StructuredTextItem } from 'unpdf';
import type { ParsedPriceResearchResult, PesquisaPrecoItem } from '../../shared/types.js';
import { formatCurrencyBRL } from '../../shared/labels.js';
import { sanitizePesquisaPrecoItens, sumPesquisaPrecoItens } from '../db/repository.js';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx') as typeof import('xlsx');

const KNOWN_UNITS_REGEX =
  /^(un|und|unid|unidade|unidades|cx|caixa|caixas|pct|pacote|pacotes|kg|quilograma|g|grama|mg|l|lt|litro|litros|ml|m|mt|metro|metros|m2|m²|m3|m³|km|par|pares|kit|kits|resma|resmas|fr|frasco|frascos|amp|ampola|ampolas|comp|comprimido|caps|mes|mês|meses|hr|hora|horas|dia|dias|diaria|diária|serv|servico|serviço|etapa|global|lote|ton|galao|galão|bombona|rl|rolo|rolos|sc|saco|sacos|tubo|tubos|placa|placas|jg|jogo|conj|conjunto|bl|bloco|blocos|fl|folha|folhas|dz|duzia|dúzia|pç|pc|peca|peça|pecas|peças|bisnaga|cartela|env|envelope|vd|vidro|balde|lata|bandeja|fardo|milheiro)$/i;

const SUMMARY_ROW_REGEX =
  /^(total(\s+(geral|estimado|da\s+planilha|dos\s+itens|licitacao))?|valor\s+total(\s+estimado|\s+geral)?|subtotal|media\s+geral|soma(\s+total)?)$/i;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function normalizeHeaderToken(raw: string): string {
  return (raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

export function parsePtBrNumber(raw: unknown): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : 0;
  }
  const original = String(raw ?? '').trim();
  if (!original) return 0;

  // Reject strings that contain letters other than currency prefix R$/US$
  const strippedCurrency = original
    .replace(/\u00a0/g, ' ')
    .replace(/R\$|US\$|BRL/gi, '')
    .trim();

  if (!strippedCurrency || /[a-zA-Z]/.test(strippedCurrency)) return 0;

  let cleaned = strippedCurrency.replace(/\s+/g, '');
  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');

  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      // Formato BR: 1.234,56
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      // Formato EN: 1,234.56
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (hasComma) {
    cleaned = cleaned.replace(',', '.');
  } else if (hasDot) {
    // Formato BR milhar sem centavos: 1.200 ou 10.500
    if (/^-?\d{1,3}(\.\d{3})+$/.test(cleaned)) {
      cleaned = cleaned.replace(/\./g, '');
    }
  }

  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

function detectFileFormat(
  filename: string,
  mimetype?: string
): 'PDF' | 'EXCEL' | 'WORD' {
  const lower = (filename || '').toLowerCase();
  const mime = (mimetype || '').toLowerCase();

  if (lower.endsWith('.pdf') || mime.includes('pdf')) return 'PDF';
  if (
    /\.(xlsx|xls|xlsm|ods|csv)$/i.test(lower) ||
    mime.includes('spreadsheet') ||
    mime.includes('excel') ||
    mime.includes('ms-excel') ||
    mime.includes('csv') ||
    mime.includes('opendocument.spreadsheet')
  ) {
    return 'EXCEL';
  }
  if (
    /\.(docx|doc)$/i.test(lower) ||
    mime.includes('wordprocessingml') ||
    mime.includes('msword') ||
    mime.includes('word')
  ) {
    return 'WORD';
  }

  throw new Error(
    `Formato de arquivo não suportado ("${filename}"). Envie a Pesquisa de Preço em PDF (.pdf), Excel (.xlsx, .xls, .csv) ou Word (.docx).`
  );
}

interface RawExtractedContent {
  tables: string[][][];
  lines: string[];
  diagnostics: string[];
}

function extractTablesFromHtml(html: string): RawExtractedContent {
  const $ = cheerio.load(html);
  const tables: string[][][] = [];
  const lines: string[] = [];

  $('table').each((_, tbl) => {
    const rows: string[][] = [];
    $(tbl)
      .find('tr')
      .each((__, tr) => {
        const cells = $(tr)
          .find('th, td')
          .map((___, cell) => $(cell).text().trim().replace(/\s+/g, ' '))
          .get();
        if (cells.some(Boolean)) {
          rows.push(cells);
          lines.push(cells.join(' | '));
        }
      });
    if (rows.length > 0) tables.push(rows);
  });

  if (lines.length === 0) {
    $('p, li, div').each((_, el) => {
      const t = $(el).text().trim().replace(/\s+/g, ' ');
      if (t) lines.push(t);
    });
  }

  return {
    tables,
    lines,
    diagnostics: [`Documento HTML tabular interpretado (${tables.length} tabela(s)).`]
  };
}

function extractExcel(buffer: Buffer, filename: string): RawExtractedContent {
  const head = buffer.toString('utf8', 0, Math.min(buffer.length, 600)).trim();
  const isZip = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (!isZip && /^<(?:!doctype|html|table|\?xml)/i.test(head)) {
    return extractTablesFromHtml(buffer.toString('utf8'));
  }

  const lower = filename.toLowerCase();
  let workbook: import('xlsx').WorkBook;

  if (lower.endsWith('.csv')) {
    let text = buffer.toString('utf8');
    if (text.includes('\ufffd')) {
      text = buffer.toString('latin1');
    }
    workbook = XLSX.read(text, { type: 'string', raw: true });
  } else {
    workbook = XLSX.read(buffer, { type: 'buffer', raw: true });
  }

  const tables: string[][][] = [];
  const lines: string[] = [];
  const diagnostics: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rawRows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      raw: true
    }) as unknown[][];

    const rows: string[][] = [];
    for (const r of rawRows) {
      if (!Array.isArray(r)) continue;
      let cells = r.map((c) => (c === null || c === undefined ? '' : String(c).trim()));
      // CSV com separador ';' pode cair em coluna única se locale diferente
      if (cells.length === 1 && cells[0].includes(';')) {
        cells = cells[0].split(';').map((s) => s.trim());
      }
      if (cells.some(Boolean)) {
        rows.push(cells);
        lines.push(cells.join(' | '));
      }
    }

    if (rows.length > 0) {
      tables.push(rows);
      diagnostics.push(`Aba "${sheetName}": ${rows.length} linha(s) lida(s).`);
    }
  }

  return { tables, lines, diagnostics };
}

async function extractWord(buffer: Buffer): Promise<RawExtractedContent> {
  const isZip = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (isZip) {
    const zip = await JSZip.loadAsync(buffer);
    const docEntry = zip.file('word/document.xml');
    if (!docEntry) {
      throw new Error('Arquivo .docx inválido: word/document.xml não encontrado.');
    }
    const xml = await docEntry.async('text');
    const $ = cheerio.load(xml, { xmlMode: true });
    const tables: string[][][] = [];
    const lines: string[] = [];

    $('w\\:tbl').each((_, tbl) => {
      // Ignora subtabelas aninhadas dentro de células para evitar duplicação
      if ($(tbl).parents('w\\:tbl').length > 0) return;
      const rows: string[][] = [];
      $(tbl)
        .find('w\\:tr')
        .each((__, tr) => {
          if ($(tr).closest('w\\:tbl')[0] !== tbl) return;
          const cells = $(tr)
            .find('w\\:tc')
            .filter((___, tc) => $(tc).closest('w\\:tr')[0] === tr)
            .map((___, tc) => {
              const paras = $(tc)
                .find('w\\:p')
                .map((____, p) =>
                  $(p)
                    .find('w\\:t')
                    .map((_____, t) => $(t).text())
                    .get()
                    .join('')
                )
                .get()
                .filter(Boolean);
              return paras.join(' ').replace(/\s+/g, ' ').trim();
            })
            .get();
          if (cells.some(Boolean)) {
            rows.push(cells);
            lines.push(cells.join(' | '));
          }
        });
      if (rows.length > 0) tables.push(rows);
    });

    $('w\\:p').each((_, p) => {
      if ($(p).parents('w\\:tbl').length > 0) return;
      const text = $(p)
        .find('w\\:t')
        .map((__, t) => $(t).text())
        .get()
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) lines.push(text);
    });

    return {
      tables,
      lines,
      diagnostics: [`Documento Word (.docx): ${tables.length} tabela(s) e ${lines.length} linha(s) extraídas.`]
    };
  }

  // Fallback para arquivos .doc exportados como HTML/XML ou legado binário
  const head = buffer.toString('utf8', 0, Math.min(buffer.length, 600)).trim();
  if (/^<(?:!doctype|html|table|\?xml)/i.test(head)) {
    return extractTablesFromHtml(buffer.toString('utf8'));
  }

  // Tentativa melhor-esforço para .doc binário OLE2 (texto UTF-16LE / Latin1)
  const utf16Text = buffer.toString('utf16le').replace(/[^\x20-\x7E\u00A0-\u00FF\r\n\t]/g, ' ');
  const rawLines = utf16Text
    .split(/\r?\n+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 6 && /[a-zA-ZÀ-ú]{3,}/.test(l));

  return {
    tables: [],
    lines: rawLines,
    diagnostics: [
      rawLines.length > 0
        ? 'Arquivo .doc legado lido em modo texto; para extração tabular garantida, prefira salvar como .docx, .xlsx ou .pdf.'
        : 'Arquivo .doc binário legado sem texto legível; converta para .docx, .pdf ou .xlsx para extração completa.'
    ]
  };
}

function clusterPdfItemsIntoRows(items: StructuredTextItem[]): string[][] {
  const cleanItems = items
    .map((it) => ({ ...it, str: (it.str || '').trim() }))
    .filter((it) => it.str.length > 0);

  if (cleanItems.length === 0) return [];

  // Em PDF coordenadas Y crescem de baixo para cima: ordenar top-to-bottom (Y desc, X asc)
  cleanItems.sort((a, b) => {
    const dy = b.y - a.y;
    if (Math.abs(dy) > 2.5) return dy;
    return a.x - b.x;
  });

  const rowClusters: StructuredTextItem[][] = [];
  for (const it of cleanItems) {
    const lastRow = rowClusters[rowClusters.length - 1];
    if (!lastRow) {
      rowClusters.push([it]);
      continue;
    }
    const ref = lastRow[0];
    const tol = Math.max(3.2, (ref.fontSize || 10) * 0.45);
    if (Math.abs(it.y - ref.y) <= tol) {
      lastRow.push(it);
    } else {
      rowClusters.push([it]);
    }
  }

  return rowClusters
    .map((cluster) => {
      cluster.sort((a, b) => a.x - b.x);
      const cells: string[] = [];
      let currentCell = '';
      let prevEndX = -1;
      let prevFontSize = 10;

      for (const item of cluster) {
        const gap = prevEndX < 0 ? 0 : item.x - prevEndX;
        const cellThreshold = Math.max(8.5, (item.fontSize || prevFontSize || 10) * 0.9);

        if (prevEndX >= 0 && gap > cellThreshold) {
          if (currentCell.trim()) cells.push(currentCell.trim());
          currentCell = item.str;
        } else {
          currentCell =
            !currentCell ? item.str : gap > 1.2 ? `${currentCell} ${item.str}` : `${currentCell}${item.str}`;
        }
        prevEndX = item.x + Math.max(item.width || 0, item.str.length * 3);
        if (item.fontSize) prevFontSize = item.fontSize;
      }
      if (currentCell.trim()) cells.push(currentCell.trim());
      return cells;
    })
    .filter((r) => r.length > 0);
}

async function extractPdf(buffer: Buffer): Promise<RawExtractedContent> {
  const { totalPages, items } = await extractTextItems(new Uint8Array(buffer));
  const tables: string[][][] = [];
  const lines: string[] = [];

  for (const pageItems of items) {
    const rows = clusterPdfItemsIntoRows(pageItems);
    const multiColRows = rows.filter((r) => r.length >= 2);
    if (multiColRows.length >= 2) {
      tables.push(rows);
    }
    for (const r of rows) {
      lines.push(r.join(' | '));
    }
  }

  return {
    tables,
    lines,
    diagnostics: [`PDF processado (${totalPages} página(s), ${tables.length} bloco(s) tabular(es)).`]
  };
}

interface ColumnMapping {
  itemCol: number;
  descCol: number;
  medidaCol: number;
  qtyCol: number;
  unitValCol: number;
  totalValCol: number;
}

function detectHeaderMapping(row: string[]): ColumnMapping | null {
  const tokens = row.map(normalizeHeaderToken);
  let itemCol = -1;
  let descCol = -1;
  let medidaCol = -1;
  let qtyCol = -1;
  let unitValCol = -1;
  let totalValCol = -1;
  let preferredMedianaCol = -1;
  const genericValueCols: number[] = [];

  tokens.forEach((tok, idx) => {
    if (!tok) return;

    if (
      itemCol === -1 &&
      (/^(item|n|no|n_o|ord|ordem|seq|sequencia|lote)$/.test(tok) || tok.startsWith('codigo') || tok === 'cod')
    ) {
      itemCol = idx;
      return;
    }

    if (
      descCol === -1 &&
      (tok.includes('descri') ||
        tok.includes('especific') ||
        tok.includes('discrimin') ||
        tok.includes('produto') ||
        tok.includes('servico') ||
        tok.includes('material') ||
        tok.includes('objeto') ||
        tok.includes('denominac') ||
        tok === 'bem' ||
        tok === 'itens' ||
        tok === 'nome')
    ) {
      descCol = idx;
      return;
    }

    if (
      medidaCol === -1 &&
      (tok.includes('medida') ||
        tok.includes('unid') ||
        tok === 'un' ||
        tok === 'und' ||
        tok === 'um' ||
        tok === 'u_m' ||
        tok.includes('apresentac') ||
        tok.includes('embalag'))
    ) {
      medidaCol = idx;
      return;
    }

    if (
      qtyCol === -1 &&
      (tok.includes('quant') || tok.includes('qtd') || tok === 'qnt' || tok.includes('qde'))
    ) {
      qtyCol = idx;
      return;
    }

    if (tok.includes('media') || tok.includes('mediana') || tok.includes('valor_referencia')) {
      if (tok.includes('total')) {
        totalValCol = idx;
      } else {
        preferredMedianaCol = idx;
      }
      return;
    }

    if (
      tok.includes('total') ||
      tok.includes('subtotal') ||
      tok.includes('valor_global') ||
      tok.includes('vlr_tot') ||
      tok.includes('vl_tot')
    ) {
      if (totalValCol === -1) totalValCol = idx;
      return;
    }

    if (
      tok.includes('unit') ||
      tok.includes('vlr_un') ||
      tok.includes('vl_un') ||
      tok.includes('p_un') ||
      tok.includes('preco_un')
    ) {
      if (unitValCol === -1) unitValCol = idx;
      return;
    }

    if (tok === 'valor' || tok === 'preco' || tok === 'vlr' || tok.startsWith('valor_') || tok.startsWith('preco_')) {
      genericValueCols.push(idx);
    }
  });

  if (preferredMedianaCol !== -1) {
    unitValCol = preferredMedianaCol;
  } else if (unitValCol === -1 && genericValueCols.length > 0) {
    unitValCol = genericValueCols[0];
    if (totalValCol === -1 && genericValueCols.length > 1) {
      totalValCol = genericValueCols[genericValueCols.length - 1];
    }
  } else if (totalValCol === -1 && genericValueCols.length > 0) {
    totalValCol = genericValueCols[genericValueCols.length - 1];
  }

  const matchedSignals = [descCol, medidaCol, qtyCol, unitValCol, totalValCol].filter((c) => c >= 0).length;
  if (matchedSignals >= 2 && (descCol >= 0 || qtyCol >= 0 || unitValCol >= 0)) {
    return { itemCol, descCol, medidaCol, qtyCol, unitValCol, totalValCol };
  }
  return null;
}

function isLikelyHeaderOrTotalRow(desc: string): boolean {
  const norm = desc
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (!norm) return true;
  if (SUMMARY_ROW_REGEX.test(norm)) return true;
  if (/^(valor\s+global|total\s+dos\s+itens|fonte\s*:|observac|nota\s*:)/i.test(norm)) return true;
  return false;
}

function parseRowsWithMapping(rows: string[][], startIdx: number, map: ColumnMapping): PesquisaPrecoItem[] {
  const extracted: PesquisaPrecoItem[] = [];

  for (let i = startIdx; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => !c.trim())) continue;

    // Ignora cabeçalhos repetidos em quebras de página
    if (detectHeaderMapping(row)) continue;

    const rawDesc = map.descCol >= 0 ? (row[map.descCol] || '').trim() : '';
    const desc =
      rawDesc ||
      row.find((cell, idx) => {
        if (idx === map.itemCol || idx === map.medidaCol || idx === map.qtyCol || idx === map.unitValCol || idx === map.totalValCol) {
          return false;
        }
        return cell.trim().length > 3 && /[a-zA-ZÀ-ú]/.test(cell) && !KNOWN_UNITS_REGEX.test(cell.trim());
      }) ||
      '';

    if (!desc || isLikelyHeaderOrTotalRow(desc)) continue;

    let medida = map.medidaCol >= 0 ? (row[map.medidaCol] || '').trim() : '';
    if (!medida) {
      const candidateUnit = row.find((cell, idx) => idx !== map.descCol && KNOWN_UNITS_REGEX.test(cell.trim()));
      medida = candidateUnit?.trim() || 'UN';
    }

    const qty = map.qtyCol >= 0 ? parsePtBrNumber(row[map.qtyCol]) : 0;
    let unitVal = map.unitValCol >= 0 ? parsePtBrNumber(row[map.unitValCol]) : 0;
    let totalVal = map.totalValCol >= 0 ? parsePtBrNumber(row[map.totalValCol]) : 0;

    // Exige pelo menos quantidade ou valor válido para evitar capturar parágrafos soltos como itens
    if (qty <= 0 && unitVal <= 0 && totalVal <= 0) continue;

    const finalQty = qty > 0 ? qty : 1;
    if (unitVal === 0 && totalVal > 0) {
      unitVal = round2(totalVal / finalQty);
    } else if (totalVal === 0 && unitVal > 0) {
      totalVal = round2(unitVal * finalQty);
    } else if (unitVal > 0 && totalVal > 0 && qty <= 0) {
      // Caso não houvesse coluna de quantidade, mantém qtd 1 ou estima pela razão se razoável
      const ratio = round2(totalVal / unitVal);
      if (ratio >= 1 && Math.abs(ratio - Math.round(ratio)) < 0.02) {
        extracted.push({
          item: extracted.length + 1,
          descricao: desc,
          medida,
          quantidade: Math.round(ratio),
          valor_unitario: unitVal,
          valor_total: round2(totalVal)
        });
        continue;
      }
    }

    extracted.push({
      item: extracted.length + 1,
      descricao: desc,
      medida,
      quantidade: finalQty,
      valor_unitario: round2(unitVal),
      valor_total: round2(totalVal || unitVal * finalQty)
    });
  }

  return extracted;
}

function parseHeaderlessTableRows(rows: string[][]): PesquisaPrecoItem[] {
  const items: PesquisaPrecoItem[] = [];

  for (const row of rows) {
    const cells = row.map((c) => c.trim()).filter(Boolean);
    if (cells.length < 3) continue;

    let idx = 0;
    if (/^\d{1,4}[.)]?$/.test(cells[0]) && cells.length >= 4) {
      idx = 1;
    }

    const numericCells: Array<{ idx: number; val: number; raw: string }> = [];
    for (let c = idx; c < cells.length; c++) {
      const val = parsePtBrNumber(cells[c]);
      if (val > 0 || /^0([,.]0+)?$/.test(cells[c])) {
        numericCells.push({ idx: c, val, raw: cells[c] });
      }
    }
    if (numericCells.length < 2) continue;

    const unitCell = cells.slice(idx).find((c) => KNOWN_UNITS_REGEX.test(c));
    const descCandidate = cells
      .slice(idx)
      .filter((c) => c !== unitCell && !numericCells.some((nc) => nc.raw === c) && /[a-zA-ZÀ-ú]{2,}/.test(c))
      .sort((a, b) => b.length - a.length)[0];

    if (!descCandidate || isLikelyHeaderOrTotalRow(descCandidate)) continue;

    const qty = numericCells[0]?.val || 1;
    const unitVal = numericCells[1]?.val || 0;
    const totalVal = numericCells[2]?.val || round2(qty * unitVal);

    if (unitVal <= 0 && totalVal <= 0) continue;

    items.push({
      item: items.length + 1,
      descricao: descCandidate,
      medida: unitCell || 'UN',
      quantidade: qty > 0 ? qty : 1,
      valor_unitario: unitVal > 0 ? round2(unitVal) : round2(totalVal / (qty || 1)),
      valor_total: totalVal > 0 ? round2(totalVal) : round2(qty * unitVal)
    });
  }

  return items;
}

function parseItemsFromTextLines(lines: string[]): PesquisaPrecoItem[] {
  const items: PesquisaPrecoItem[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 1) Tenta linhas delimitadas por | ; ou tab
    const delimited = trimmed.includes('|')
      ? trimmed.split('|')
      : trimmed.includes(';')
        ? trimmed.split(';')
        : trimmed.includes('\t')
          ? trimmed.split('\t')
          : null;

    if (delimited && delimited.length >= 3) {
      const parsed = parseHeaderlessTableRows([delimited]);
      if (parsed.length > 0) {
        items.push(...parsed);
        continue;
      }
    }

    // 2) Tenta linhas corridas com R$ ou números decimais ao final:
    // Ex: "01 Papel A4 Sulfite 75g Resma 100 R$ 28,90 R$ 2.890,00"
    const match = trimmed.match(
      /^(?:\d{1,4}[\s.)_-]+)?(.{4,}?)\s+([a-zA-ZÀ-ú²³\/]{1,15})\s+(\d+(?:[.,]\d+)?)\s+(?:R\$\s*)?(\d[\d.]*(?:,\d{1,4})|\d+(?:\.\d{1,2})?)(?:\s+(?:R\$\s*)?(\d[\d.]*(?:,\d{1,4})|\d+(?:\.\d{1,2})?))?$/i
    );
    if (match) {
      const desc = match[1].trim();
      const medida = match[2].trim();
      if (!isLikelyHeaderOrTotalRow(desc) && KNOWN_UNITS_REGEX.test(medida)) {
        const qty = parsePtBrNumber(match[3]) || 1;
        const unitVal = parsePtBrNumber(match[4]);
        const totalVal = match[5] ? parsePtBrNumber(match[5]) : round2(qty * unitVal);
        if (unitVal > 0 || totalVal > 0) {
          items.push({
            item: items.length + 1,
            descricao: desc,
            medida,
            quantidade: qty,
            valor_unitario: unitVal > 0 ? round2(unitVal) : round2(totalVal / qty),
            valor_total: totalVal > 0 ? round2(totalVal) : round2(qty * unitVal)
          });
        }
      }
    }
  }

  return items;
}

function extractStructuredItems(raw: RawExtractedContent): PesquisaPrecoItem[] {
  const allItems: PesquisaPrecoItem[] = [];

  for (const table of raw.tables) {
    let headerIdx = -1;
    let mapping: ColumnMapping | null = null;
    for (let i = 0; i < Math.min(table.length, 15); i++) {
      const m = detectHeaderMapping(table[i]);
      if (m) {
        headerIdx = i;
        mapping = m;
        break;
      }
    }

    if (mapping && headerIdx >= 0) {
      allItems.push(...parseRowsWithMapping(table, headerIdx + 1, mapping));
    } else {
      allItems.push(...parseHeaderlessTableRows(table));
    }
  }

  if (allItems.length === 0 && raw.lines.length > 0) {
    allItems.push(...parseItemsFromTextLines(raw.lines));
  }

  return sanitizePesquisaPrecoItens(allItems);
}

export async function parsePriceResearchFile(
  buffer: Buffer,
  filename: string,
  mimetype?: string
): Promise<ParsedPriceResearchResult> {
  if (!buffer || buffer.length === 0) {
    throw new Error('O arquivo enviado está vazio.');
  }

  const format = detectFileFormat(filename, mimetype);
  let raw: RawExtractedContent;

  if (format === 'EXCEL') {
    raw = extractExcel(buffer, filename);
  } else if (format === 'WORD') {
    raw = await extractWord(buffer);
  } else {
    raw = await extractPdf(buffer);
  }

  const itens = extractStructuredItems(raw);
  const valorTotalEstimado = sumPesquisaPrecoItens(itens);
  const diagnostics = [...raw.diagnostics];

  if (itens.length > 0) {
    diagnostics.push(
      `${itens.length} item(ns) estruturado(s) extraído(s) (Descrição, Medida, Quantidade, Valor), totalizando ${formatCurrencyBRL(valorTotalEstimado)}.`
    );
  } else {
    diagnostics.push(
      'Nenhuma tabela padronizada foi detectada automaticamente; o texto extraído foi preservado e você pode revisar ou inserir os itens manualmente na tabela.'
    );
  }

  const excerptLines = raw.lines
    .filter((l) => l.trim().length > 0)
    .slice(0, 35)
    .join('\n')
    .slice(0, 2200);

  const resumoTexto =
    itens.length > 0
      ? `Pesquisa de Preço consolidada a partir do arquivo "${filename}" (${format}, Art. 23 da Lei nº 14.133/2021): ${itens.length} item(ns) cotado(s) com descrição, unidade de medida, quantitativos e preços referenciais, perfazendo o valor global estimado de ${formatCurrencyBRL(valorTotalEstimado)}.`
      : `Documento de Pesquisa de Preço "${filename}" (${format}) anexado aos autos. Trecho extraído:\n${excerptLines}`;

  return {
    filename,
    format,
    itens,
    valor_total_estimado: valorTotalEstimado,
    resumo_texto: resumoTexto,
    diagnostics
  };
}
