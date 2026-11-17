import * as cheerio from 'cheerio';
import { parse } from 'csv-parse/sync';
import type { Dotacao, Secretario } from '../../shared/types.js';

export type ExtractedSecretario = Omit<
  Secretario,
  'id' | 'institution_id' | 'created_at' | 'updated_at'
>;

export type ExtractedDotacao = Omit<
  Dotacao,
  'id' | 'institution_id' | 'created_at' | 'updated_at'
>;

export interface ScrapeResult {
  source_url: string;
  page_title: string;
  secretarios: ExtractedSecretario[];
  dotacoes: ExtractedDotacao[];
  diagnostics: string[];
}

function normalizeHeader(h: string): string {
  return (h || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function parseMoneyBR(val: unknown): number {
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  const s = String(val ?? '').trim();
  if (!s) return 0;
  const cleaned = s.replace(/[R$\s.]/g, '').replace(',', '.');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

export function extractFromHtmlContent(html: string, sourceUrl: string): ScrapeResult {
  const $ = cheerio.load(html);
  const pageTitle = $('title').text().trim() || sourceUrl;
  const secretarios: ExtractedSecretario[] = [];
  const dotacoes: ExtractedDotacao[] = [];
  const diagnostics: string[] = [];

  // 1) Analisa tabelas HTML (padrão mais comum em Portais da Transparência)
  $('table').each((tableIdx, table) => {
    const headers: string[] = [];
    $(table)
      .find('thead tr th, tr:first-child th')
      .each((_, th) => {
        headers.push(normalizeHeader($(th).text()));
      });

    if (headers.length === 0) {
      $(table)
        .find('tr:first-child td')
        .each((_, td) => {
          headers.push(normalizeHeader($(td).text()));
        });
    }

    const joined = headers.join(' ');
    const isSecTable =
      joined.includes('secretari') ||
      joined.includes('ordenador') ||
      joined.includes('portaria') ||
      (joined.includes('nome') && joined.includes('cargo'));

    const isDotTable =
      joined.includes('dotacao') ||
      joined.includes('elemento') ||
      joined.includes('unidade_orcamentaria') ||
      joined.includes('funcao') ||
      joined.includes('fonte');

    const rows = $(table).find('tbody tr').length > 0 ? $(table).find('tbody tr') : $(table).find('tr').slice(1);

    if (isSecTable) {
      rows.each((_, tr) => {
        const cells = $(tr)
          .find('td')
          .map((__, td) => $(td).text().trim().replace(/\s+/g, ' '))
          .get();
        if (cells.length < 2) return;
        const rowObj: Record<string, string> = {};
        headers.forEach((h, i) => {
          rowObj[h] = cells[i] || '';
        });

        const secretaria =
          rowObj.secretaria ||
          rowObj.orgao ||
          rowObj.pasta ||
          rowObj.unidade ||
          cells[0] ||
          'Secretaria Municipal';
        const nome =
          rowObj.nome ||
          rowObj.secretario ||
          rowObj.ordenador ||
          rowObj.responsavel ||
          cells[1] ||
          '';
        const cargo = rowObj.cargo || rowObj.funcao || 'Secretário(a) Municipal / Ordenador de Despesa';
        const portaria = rowObj.portaria || rowObj.portaria_nomeacao || rowObj.ato || '';
        const email = rowObj.email || rowObj.e_mail || '';

        if (nome && nome.length > 2) {
          secretarios.push({
            secretaria,
            nome,
            cargo,
            portaria_nomeacao: portaria,
            email,
            source: 'scraping'
          });
        }
      });
      diagnostics.push(`Tabela #${tableIdx + 1}: identificados possíveis registros de Secretários/Ordenadores.`);
    }

    if (isDotTable) {
      rows.each((_, tr) => {
        const cells = $(tr)
          .find('td')
          .map((__, td) => $(td).text().trim().replace(/\s+/g, ' '))
          .get();
        if (cells.length < 3) return;
        const rowObj: Record<string, string> = {};
        headers.forEach((h, i) => {
          rowObj[h] = cells[i] || '';
        });

        const orgao = rowObj.orgao || cells[0] || '02 - Poder Executivo';
        const unidade = rowObj.unidade_orcamentaria || rowObj.unidade || cells[1] || '';
        const funcao = rowObj.funcao || '';
        const subfuncao = rowObj.subfuncao || '';
        const programa = rowObj.programa || '';
        const acao = rowObj.acao || rowObj.projeto_atividade || '';
        const elemento = rowObj.elemento_despesa || rowObj.elemento || rowObj.natureza || '';
        const fonte = rowObj.fonte_recurso || rowObj.fonte || '';
        const reduzido = rowObj.reduzido || rowObj.codigo_reduzido || rowObj.ficha || '';
        const saldo = parseMoneyBR(rowObj.saldo || rowObj.saldo_disponivel || rowObj.dotacao_atualizada || 0);

        if (orgao || elemento || unidade) {
          dotacoes.push({
            orgao,
            unidade_orcamentaria: unidade,
            funcao,
            subfuncao,
            programa,
            acao,
            elemento_despesa: elemento,
            fonte_recurso: fonte,
            codigo_reduzido: reduzido,
            descricao: rowObj.descricao || rowObj.especificacao || '',
            saldo_disponivel: saldo,
            source: 'scraping'
          });
        }
      });
      diagnostics.push(`Tabela #${tableIdx + 1}: identificadas possíveis Dotações Orçamentárias.`);
    }
  });

  // 2) Heurística textual para páginas institucionais sem tabela (cards/blocos)
  if (secretarios.length === 0) {
    const bodyText = $('body').text().replace(/\r/g, '\n');
    const secBlockRegex =
      /(Secretaria\s+(?:Municipal\s+)?de\s+[^\n]{3,80})[\s\S]{0,220}?(?:Secret[áa]ri[oa]|Ordenador(?:\(a\))?|Titular)\s*[:\-–]\s*([A-ZÀ-Úa-zà-ú.\s]{4,70})/gi;
    let match: RegExpExecArray | null;
    while ((match = secBlockRegex.exec(bodyText)) !== null) {
      const secName = match[1].trim();
      const personName = match[2].split('\n')[0].trim();
      const snippet = bodyText.slice(match.index, match.index + 320);
      const portariaMatch = snippet.match(/Portaria\s*(?:n[º°o.]*\s*)?[\d./-]+/i);

      if (personName && !secretarios.some((s) => s.secretaria === secName && s.nome === personName)) {
        secretarios.push({
          secretaria: secName,
          nome: personName,
          cargo: 'Secretário(a) Municipal e Ordenador(a) de Despesas',
          portaria_nomeacao: portariaMatch ? portariaMatch[0].trim() : '',
          source: 'scraping'
        });
      }
    }
    if (secretarios.length > 0) {
      diagnostics.push(`Heurística textual extraiu ${secretarios.length} secretário(s) de blocos institucionais.`);
    }
  }

  // 3) Heurística textual para elementos de despesa no corpo da página
  if (dotacoes.length === 0) {
    const bodyText = $('body').text();
    const dotRegex =
      /(\d{2}\.\d{2}\.\d{2})[\s\-–|]+(\d{2})[\s.\-]+(\d{3})[\s.\-]+(\d{4})[\s.\-]+(\d\.\d{3})[\s\-–|]+([34]\.\d\.\d{2}\.\d{2}(?:\.\d{2})?)/g;
    let m: RegExpExecArray | null;
    while ((m = dotRegex.exec(bodyText)) !== null) {
      dotacoes.push({
        orgao: m[1].slice(0, 2),
        unidade_orcamentaria: m[1],
        funcao: m[2],
        subfuncao: m[3],
        programa: m[4],
        acao: m[5],
        elemento_despesa: m[6],
        fonte_recurso: '1.500.000',
        source: 'scraping'
      });
    }
    if (dotacoes.length > 0) {
      diagnostics.push(`Heurística orçamentária identificou ${dotacoes.length} estrutura(s) programática(s).`);
    }
  }

  if (secretarios.length === 0 && dotacoes.length === 0) {
    diagnostics.push(
      'Nenhum padrão tabular automático de Secretarias ou Dotações foi encontrado diretamente neste HTML (muitos portais carregam tabelas via API/JS dinâmica). Você pode apontar diretamente para o endpoint JSON do portal ou utilizar a importação estruturada CSV/JSON.'
    );
  }

  return {
    source_url: sourceUrl,
    page_title: pageTitle,
    secretarios,
    dotacoes,
    diagnostics
  };
}

export async function scrapePortalTransparencia(rawUrl: string): Promise<ScrapeResult> {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  const parsedUrl = new URL(url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Apenas URLs HTTP/HTTPS são suportadas.');
  }

  const res = await fetch(parsedUrl.toString(), {
    headers: {
      'User-Agent': 'GovFlow-14133-Extractor/1.0 (+https://gov.br)',
      Accept: 'text/html,application/json,application/xhtml+xml;q=0.9,*/*;q=0.8'
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!res.ok) {
    throw new Error(`Portal retornou erro HTTP ${res.status} ao acessar ${parsedUrl.toString()}.`);
  }

  const contentType = res.headers.get('content-type') || '';
  const body = await res.text();

  if (contentType.includes('application/json') || body.trim().startsWith('{') || body.trim().startsWith('[')) {
    try {
      const json = JSON.parse(body);
      const list = Array.isArray(json)
        ? json
        : Array.isArray(json.data)
          ? json.data
          : Array.isArray(json.items)
            ? json.items
            : Array.isArray(json.secretarios) || Array.isArray(json.dotacoes)
              ? null
              : [];

      const secretarios: ExtractedSecretario[] = [];
      const dotacoes: ExtractedDotacao[] = [];

      if (Array.isArray(json?.secretarios)) {
        secretarios.push(...parseSecretariosFromRecords(json.secretarios, 'scraping'));
      }
      if (Array.isArray(json?.dotacoes)) {
        dotacoes.push(...parseDotacoesFromRecords(json.dotacoes, 'scraping'));
      }
      if (list && list.length > 0) {
        secretarios.push(...parseSecretariosFromRecords(list, 'scraping'));
        dotacoes.push(...parseDotacoesFromRecords(list, 'scraping'));
      }

      return {
        source_url: parsedUrl.toString(),
        page_title: 'Endpoint JSON do Portal da Transparência',
        secretarios,
        dotacoes,
        diagnostics: [`Endpoint JSON processado: ${secretarios.length} secretário(s) e ${dotacoes.length} dotação(ões).`]
      };
    } catch {
      // Continua como HTML
    }
  }

  return extractFromHtmlContent(body, parsedUrl.toString());
}

function parseCsvObjects(csvContent: string): Record<string, string>[] {
  const trimmed = csvContent.trim();
  if (!trimmed) return [];
  const firstLine = trimmed.split(/\r?\n/)[0] || '';
  const delimiter = (firstLine.match(/;/g)?.length || 0) >= (firstLine.match(/,/g)?.length || 0) ? ';' : ',';
  const records = parse(trimmed, {
    columns: true,
    skip_empty_lines: true,
    delimiter,
    trim: true,
    bom: true
  }) as Record<string, string>[];

  return records.map((rec) => {
    const normalized: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec)) {
      normalized[normalizeHeader(k)] = String(v ?? '').trim();
    }
    return normalized;
  });
}

function parseSecretariosFromRecords(
  records: Record<string, any>[],
  source: 'csv' | 'json' | 'scraping'
): ExtractedSecretario[] {
  const out: ExtractedSecretario[] = [];
  for (const raw of records) {
    const rec: Record<string, any> = {};
    for (const [k, v] of Object.entries(raw)) {
      rec[normalizeHeader(k)] = v;
    }
    const nome = String(rec.nome || rec.secretario || rec.ordenador || rec.ordenador_despesa || '').trim();
    const secretaria = String(rec.secretaria || rec.orgao || rec.pasta || '').trim();
    if (!nome || !secretaria) continue;
    out.push({
      secretaria,
      nome,
      cargo: String(rec.cargo || rec.funcao || 'Secretário(a) Municipal / Ordenador de Despesa').trim(),
      portaria_nomeacao: String(rec.portaria || rec.portaria_nomeacao || rec.ato_nomeacao || '').trim(),
      matricula_cpf: String(rec.matricula || rec.cpf || rec.matricula_cpf || '').trim(),
      email: String(rec.email || '').trim(),
      source
    });
  }
  return out;
}

function parseDotacoesFromRecords(
  records: Record<string, any>[],
  source: 'csv' | 'json' | 'scraping'
): ExtractedDotacao[] {
  const out: ExtractedDotacao[] = [];
  for (const raw of records) {
    const rec: Record<string, any> = {};
    for (const [k, v] of Object.entries(raw)) {
      rec[normalizeHeader(k)] = v;
    }
    const orgao = String(rec.orgao || '').trim();
    const unidade = String(rec.unidade_orcamentaria || rec.unidade || '').trim();
    const elemento = String(rec.elemento_despesa || rec.elemento || rec.natureza_despesa || '').trim();
    if (!orgao && !unidade && !elemento) continue;
    out.push({
      orgao: orgao || '02 - Poder Executivo',
      unidade_orcamentaria: unidade || '02.01.01',
      funcao: String(rec.funcao || '').trim(),
      subfuncao: String(rec.subfuncao || '').trim(),
      programa: String(rec.programa || '').trim(),
      acao: String(rec.acao || rec.projeto_atividade || '').trim(),
      elemento_despesa: elemento || '3.3.90.30.00',
      fonte_recurso: String(rec.fonte_recurso || rec.fonte || '1.500.000').trim(),
      codigo_reduzido: String(rec.codigo_reduzido || rec.reduzido || rec.ficha || '').trim(),
      descricao: String(rec.descricao || rec.objeto || '').trim(),
      saldo_disponivel: parseMoneyBR(rec.saldo_disponivel ?? rec.saldo ?? 0),
      source
    });
  }
  return out;
}

export function importSecretarios(content: string, format: 'csv' | 'json'): ExtractedSecretario[] {
  if (format === 'json') {
    const parsed = JSON.parse(content);
    const list = Array.isArray(parsed) ? parsed : parsed.secretarios || [];
    return parseSecretariosFromRecords(list, 'json');
  }
  return parseSecretariosFromRecords(parseCsvObjects(content), 'csv');
}

export function importDotacoes(content: string, format: 'csv' | 'json'): ExtractedDotacao[] {
  if (format === 'json') {
    const parsed = JSON.parse(content);
    const list = Array.isArray(parsed) ? parsed : parsed.dotacoes || [];
    return parseDotacoesFromRecords(list, 'json');
  }
  return parseDotacoesFromRecords(parseCsvObjects(content), 'csv');
}
