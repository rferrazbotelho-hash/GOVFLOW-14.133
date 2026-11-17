import fs from 'node:fs';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer-core';
import { PDFDocument } from 'pdf-lib';
import PDFKitDocument from 'pdfkit';
import type { AgentPiece, ProcessBundle } from '../../shared/types.js';
import {
  CANONICAL_UI_FONT_STACK,
  normalizeUtf8Text,
  normalizeWinAnsiFallback
} from '../../shared/typography.js';
import {
  formatCnpj,
  formatCurrencyBRL,
  formatDateBR,
  formatDateTimeBR,
  formatSessaoPublicaLabel,
  getCriterioLabel,
  getFormatoLanceLabel,
  getModalidadeLabel,
  getModoDisputaLabel,
  getTipoContratacaoLabel
} from '../../shared/labels.js';
import { formatDotacoesSummary } from '../db/repository.js';

function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function findBrowserExecutable(): string | null {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const PDF_STYLES = `
  <style>
    @page {
      size: A4;
      margin: 31mm 16mm 20mm 16mm;
    }
    * { box-sizing: border-box; }
    body {
      font-family: ${CANONICAL_UI_FONT_STACK};
      color: #1E293B;
      font-size: 10.5pt;
      line-height: 1.5;
      margin: 0;
      padding: 0;
    }
    .page-break { page-break-before: always; break-before: page; }
    .cover-box {
      border: 2px solid #071D41;
      padding: 28px 26px;
      border-radius: 6px;
      background: #F8FAFC;
    }
    .cover-header {
      text-align: center;
      border-bottom: 2px solid #1351B4;
      padding-bottom: 18px;
      margin-bottom: 22px;
    }
    .cover-logo {
      max-height: 128px;
      max-width: 240px;
      width: auto;
      height: auto;
      object-fit: contain;
      margin-bottom: 12px;
    }
    .cover-org {
      font-size: 14pt;
      font-weight: 700;
      color: #071D41;
      text-transform: uppercase;
      margin: 0;
    }
    .cover-sub {
      font-size: 9.5pt;
      color: #475569;
      margin: 4px 0 0 0;
    }
    .cover-title {
      text-align: center;
      margin: 26px 0;
    }
    .cover-title .badge {
      display: inline-block;
      background: #071D41;
      color: #FFFFFF;
      font-size: 8.5pt;
      font-weight: 700;
      letter-spacing: 0.08em;
      padding: 5px 14px;
      border-radius: 999px;
      text-transform: uppercase;
      margin-bottom: 12px;
    }
    .cover-title h1 {
      font-size: 19pt;
      color: #071D41;
      margin: 6px 0;
    }
    .cover-title p {
      font-size: 11pt;
      color: #334155;
      margin: 4px 0;
    }
    .meta-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 16px;
    }
    .meta-table td {
      border: 1px solid #CBD5E1;
      padding: 7px 10px;
      font-size: 9.5pt;
      vertical-align: top;
    }
    .meta-table td:first-child {
      width: 34%;
      font-weight: 700;
      background: #EFF6FF;
      color: #071D41;
    }
    h2 {
      font-size: 13pt;
      color: #071D41;
      border-bottom: 2px solid #1351B4;
      padding-bottom: 5px;
      margin: 0 0 12px 0;
      page-break-after: avoid;
    }
    h3 {
      font-size: 11pt;
      color: #1351B4;
      margin: 14px 0 6px 0;
      page-break-after: avoid;
    }
    h4 {
      font-size: 10pt;
      font-weight: 700;
      color: #071D41;
      margin: 10px 0 4px 0;
      page-break-after: avoid;
    }
    blockquote {
      border-left: 4px solid #1351B4;
      background: #F8FAFC;
      border-top: 1px solid #E2E8F0;
      border-right: 1px solid #E2E8F0;
      border-bottom: 1px solid #E2E8F0;
      padding: 8px 12px;
      margin: 10px 0 12px 0;
      font-size: 9.8pt;
      line-height: 1.5;
      text-align: justify;
      page-break-inside: avoid;
    }
    blockquote p:last-child {
      margin-bottom: 0;
    }
    p {
      margin: 0 0 8px 0;
      text-align: justify;
    }
    ul, ol {
      margin: 0 0 10px 0;
      padding-left: 20px;
    }
    li {
      margin-bottom: 4px;
      text-align: justify;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 10px 0 14px 0;
      font-size: 9pt;
    }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    th, td {
      border: 1px solid #CBD5E1;
      padding: 6px 8px;
      text-align: left;
      vertical-align: top;
    }
    td p, th p {
      text-align: left;
      margin-bottom: 2px;
    }
    td p:last-child, th p:last-child {
      margin-bottom: 0;
    }
    th {
      background: #071D41;
      color: #FFFFFF;
      font-weight: 600;
    }
    tbody tr:nth-child(even) {
      background: #F8FAFC;
    }
    .piece-meta-banner {
      background: #F1F5F9;
      border-left: 4px solid #1351B4;
      padding: 6px 10px;
      font-size: 8.5pt;
      color: #334155;
      margin-bottom: 12px;
    }
    .signature-stamp {
      margin-top: 16px;
      border: 1px dashed #16A34A;
      background: #F0FDF4;
      padding: 8px 12px;
      font-size: 8.5pt;
      color: #166534;
      border-radius: 4px;
      page-break-inside: avoid;
    }
  </style>
`;

function buildHeaderTemplate(bundle: ProcessBundle): string {
  const { institution: inst, process: proc } = bundle;
  const logoImg = inst.logo_data_url
    ? `<img src="${inst.logo_data_url}" style="height:46px;width:auto;max-width:110px;object-fit:contain;" />`
    : '';

  return `
  <div style="width:100%;font-family:'Segoe UI',Arial,sans-serif;font-size:8px;color:#334155;border-bottom:1.5px solid #071D41;padding:0 16mm 4px 16mm;display:flex;align-items:center;justify-content:space-between;box-sizing:border-box;">
    <div style="display:flex;align-items:center;gap:8px;">
      ${logoImg}
      <div>
        <div style="font-weight:700;color:#071D41;font-size:8.5px;text-transform:uppercase;">${escapeHtml(inst.razao_social)}</div>
        <div style="color:#475569;font-size:7.5px;">CNPJ: ${escapeHtml(formatCnpj(inst.cnpj))} — ${escapeHtml(inst.municipio)}/${escapeHtml(inst.uf)}</div>
      </div>
    </div>
    <div style="text-align:right;font-size:7.5px;line-height:1.3;">
      <div><strong>Proc. Licitatório:</strong> ${escapeHtml(proc.numero_processo_licitatorio)}</div>
      <div><strong>Proc. Administrativo:</strong> ${escapeHtml(proc.numero_processo_administrativo)}</div>
    </div>
  </div>`;
}

function buildFooterTemplate(bundle: ProcessBundle): string {
  return `
  <div style="width:100%;font-family:'Segoe UI',Arial,sans-serif;font-size:7.5px;color:#475569;border-top:1px solid #CBD5E1;padding:4px 16mm 0 16mm;display:flex;justify-content:space-between;align-items:center;box-sizing:border-box;">
    <div>GOVFLOW 14.133 — Dossiê Auditável (Lei nº 14.133/2021) | ${escapeHtml(getModalidadeLabel(bundle.process.modalidade))}</div>
    <div>Página <span class="pageNumber"></span> de <span class="totalPages"></span></div>
  </div>`;
}

function buildCoverSectionHtml(bundle: ProcessBundle): string {
  const { institution: inst, process: proc, secretario: sec, dotacao: dot } = bundle;
  const logo = inst.logo_data_url
    ? `<img src="${inst.logo_data_url}" class="cover-logo" alt="Brasão" />`
    : '';
  return `
  <div class="cover-box">
    <div class="cover-header">
      ${logo}
      <p class="cover-org">${escapeHtml(inst.razao_social)}</p>
      <p class="cover-sub">${escapeHtml(inst.nome_fantasia)} | CNPJ: ${escapeHtml(formatCnpj(inst.cnpj))}<br/>
      ${escapeHtml(inst.endereco_completo)} — CEP ${escapeHtml(inst.cep)} — ${escapeHtml(inst.municipio)}/${escapeHtml(inst.uf)}</p>
    </div>

    <div class="cover-title">
      <div class="badge">Dossiê Oficial de Contratação Pública — Lei nº 14.133/2021</div>
      <h1>PROCESSO LICITATÓRIO Nº ${escapeHtml(proc.numero_processo_licitatorio)}</h1>
      <p>Processo Administrativo nº <strong>${escapeHtml(proc.numero_processo_administrativo)}</strong></p>
    </div>

    <table class="meta-table">
      <tbody>
        <tr><td>Objeto Resumido</td><td>${escapeHtml(proc.titulo_resumido)}</td></tr>
        <tr><td>Tipo da Contratação</td><td>${escapeHtml(getTipoContratacaoLabel(proc.tipo_contratacao))}</td></tr>
        <tr><td>Modalidade</td><td>${escapeHtml(getModalidadeLabel(proc.modalidade))}</td></tr>
        <tr><td>Data e Horário da Sessão</td><td>${escapeHtml(formatSessaoPublicaLabel(proc.data_certame, proc.horario_disputa))}</td></tr>
        <tr><td>Modo de Disputa</td><td>${escapeHtml(getModoDisputaLabel(proc.modo_disputa))}</td></tr>
        <tr><td>Critério de Julgamento</td><td>${escapeHtml(getCriterioLabel(proc.criterio_julgamento))} (${escapeHtml(getFormatoLanceLabel(proc.formato_lance))})</td></tr>
        <tr><td>Sistema Auxiliar</td><td>${proc.usar_srp ? 'Sistema de Registro de Preços (SRP — Art. 82)' : 'Contratação Convencional (Sem SRP)'}</td></tr>
        <tr><td>Valor Global Estimado</td><td><strong>${escapeHtml(formatCurrencyBRL(proc.valor_estimado_global))}</strong></td></tr>
        <tr><td>Secretaria / Ordenador</td><td>${escapeHtml(sec?.secretaria || 'Não vinculada')} — ${escapeHtml(sec?.nome || 'A designar')} (${escapeHtml(sec?.portaria_nomeacao || '—')})</td></tr>
        <tr><td>Dotação(ões) Orçamentária(s)</td><td>${escapeHtml(formatDotacoesSummary(bundle.dotacoes_vinculadas ?? (dot ? [dot] : []), proc.dotacoes_manuais))}</td></tr>
        <tr><td>Autoridade Máxima</td><td>${escapeHtml(inst.prefeito_nome)} — ${escapeHtml(inst.comarca_foro || `${inst.municipio}/${inst.uf}`)}</td></tr>
        <tr><td>Data de Compilação</td><td>${escapeHtml(formatDateTimeBR(new Date()))}</td></tr>
      </tbody>
    </table>
  </div>`;
}

function buildAuditSectionHtml(bundle: ProcessBundle): string {
  const rows = bundle.audit_logs
    .slice()
    .reverse()
    .map(
      (l) => `
      <tr>
        <td>${escapeHtml(formatDateTimeBR(l.created_at))}</td>
        <td>${escapeHtml(l.action)}</td>
        <td>${l.agent_number ? `Ag. ${String(l.agent_number).padStart(2, '0')}` : 'Geral'}</td>
        <td>${escapeHtml(l.actor_name)}<br/><small>${escapeHtml(l.actor_role)}</small></td>
        <td>${escapeHtml(l.details)}${l.content_hash ? `<br/><small>Hash: ${escapeHtml(l.content_hash.slice(0, 16))}</small>` : ''}</td>
      </tr>`
    )
    .join('');

  return `
    <h2>TRILHA DE AUDITORIA E RASTREABILIDADE PROCESSUAL</h2>
    <p>Registro cronológico imutável de autoria, revisões humanas, regenerações com feedback e assinaturas de aprovação das peças do processo <strong>${escapeHtml(bundle.process.numero_processo_licitatorio)}</strong>.</p>
    <table>
      <thead>
        <tr>
          <th>Data/Hora</th>
          <th>Evento</th>
          <th>Etapa</th>
          <th>Responsável / Agente</th>
          <th>Detalhamento e Integridade</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="5">Nenhum evento registrado.</td></tr>'}
      </tbody>
    </table>
  `;
}

function buildPieceSectionHtml(piece: AgentPiece): string {
  const stamp = piece.approved_at
    ? `<div class="signature-stamp"><strong>ASSINATURA E APROVAÇÃO REGISTRADA:</strong> Peça v${piece.current_version} aprovada por <strong>${escapeHtml(piece.approved_by || 'Gestor')}</strong> (${escapeHtml(piece.approved_role || '')}) em ${escapeHtml(formatDateTimeBR(piece.approved_at))} | SHA-256: <code>${escapeHtml((piece.content_hash || '').slice(0, 24))}...</code></div>`
    : `<div class="piece-meta-banner">Status atual: <strong>${escapeHtml(piece.status)}</strong> | Versão: v${piece.current_version} | Motor: ${escapeHtml(piece.ai_provider_used)}</div>`;

  const body =
    piece.html_content.trim() ||
    `<p><em>Peça ainda não executada/redigida até o momento da exportação (${escapeHtml(piece.title)}).</em></p>`;

  return `
    <div class="piece-meta-banner">
      <strong>${escapeHtml(piece.title)}</strong> — Fundamentação: ${escapeHtml(piece.legal_basis)}
    </div>
    ${body}
    ${stamp}
  `;
}

function buildTocHtml(
  procNumber: string,
  entries: { label: string; legalBasis: string; status: string; page: number }[]
): string {
  const rows = entries
    .map(
      (e) => `
      <tr>
        <td>${escapeHtml(e.label)}</td>
        <td>${escapeHtml(e.legalBasis)}</td>
        <td>${escapeHtml(e.status)}</td>
        <td style="text-align:right;"><strong>Pág. ${e.page}</strong></td>
      </tr>`
    )
    .join('');

  return `
    <h2>ÍNDICE REMISSIVO PAGINADO DO DOSSIÊ</h2>
    <p>Sumário oficial com paginação conferida de todas as peças integrantes dos autos do Processo Licitatório nº <strong>${escapeHtml(procNumber)}</strong>.</p>
    <table>
      <thead>
        <tr>
          <th>Peça / Seção Processual</th>
          <th>Fundamentação Legal</th>
          <th>Situação</th>
          <th style="text-align:right;width:72px;">Página</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

let pdfRenderQueue: Promise<unknown> = Promise.resolve();

function runSerializedPdfTask<T>(task: () => Promise<T>): Promise<T> {
  const next = pdfRenderQueue.then(task, task);
  pdfRenderQueue = next.catch(() => {});
  return next;
}

export async function generateConsolidatedPdf(bundle: ProcessBundle): Promise<Buffer> {
  return runSerializedPdfTask(() => renderConsolidatedPdfInternal(bundle));
}

async function renderConsolidatedPdfInternal(bundle: ProcessBundle): Promise<Buffer> {
  const activePieces = bundle.pieces.filter((p) => p.status !== 'DISPENSADO');
  const executablePath = findBrowserExecutable();

  if (!executablePath) {
    return generatePdfFallback(bundle, activePieces);
  }

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
    });

    const headerTemplate = buildHeaderTemplate(bundle);
    const footerTemplate = buildFooterTemplate(bundle);

    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);

    try {
      const measureSectionPages = async (sectionHtml: string): Promise<number> => {
        await page.setContent(
          `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"/>${PDF_STYLES}</head><body>${sectionHtml}</body></html>`,
          { waitUntil: 'load', timeout: 30_000 }
        );
        const buf = await page.pdf({
          format: 'A4',
          printBackground: true,
          displayHeaderFooter: true,
          headerTemplate,
          footerTemplate,
          margin: { top: '28mm', bottom: '20mm', left: '16mm', right: '16mm' }
        });
        const doc = await PDFDocument.load(buf);
        return doc.getPageCount();
      };

      const coverHtml = buildCoverSectionHtml(bundle);
      const auditHtml = buildAuditSectionHtml(bundle);
      const pieceHtmls = activePieces.map((p) => buildPieceSectionHtml(p));

      // Pass 1 (aba única reutilizada): mede páginas de cada seção sem criar 14 instâncias de página
      const coverPages = await measureSectionPages(coverHtml);
      const placeholderTocEntries = [
        { label: 'Capa Oficial do Processo', legalBasis: 'Art. 12, VI e Art. 18', status: 'CONCLUÍDO', page: 1 },
        { label: 'Índice Remissivo Paginado', legalBasis: 'Organização dos Autos', status: 'CONCLUÍDO', page: coverPages + 1 },
        { label: 'Trilha de Auditoria e Rastreabilidade', legalBasis: 'Governança e Controle', status: 'ATIVO', page: coverPages + 2 },
        ...activePieces.map((p, idx) => ({
          label: p.title,
          legalBasis: p.legal_basis,
          status: p.status,
          page: coverPages + 3 + idx
        }))
      ];
      const tocPages = await measureSectionPages(
        buildTocHtml(bundle.process.numero_processo_licitatorio, placeholderTocEntries)
      );
      const auditPages = await measureSectionPages(auditHtml);

      let cursor = 1 + coverPages; // página inicial do TOC
      const finalTocEntries: { label: string; legalBasis: string; status: string; page: number }[] = [
        { label: 'Capa Oficial do Processo', legalBasis: 'Art. 12, VI e Art. 18', status: 'CONCLUÍDO', page: 1 },
        { label: 'Índice Remissivo Paginado', legalBasis: 'Organização dos Autos', status: 'CONCLUÍDO', page: cursor }
      ];
      cursor += tocPages;

      finalTocEntries.push({
        label: 'Trilha de Auditoria e Rastreabilidade',
        legalBasis: 'Governança e Controle',
        status: `${bundle.audit_logs.length} evento(s)`,
        page: cursor
      });
      cursor += auditPages;

      for (let i = 0; i < activePieces.length; i++) {
        const p = activePieces[i];
        const count = await measureSectionPages(pieceHtmls[i]);
        finalTocEntries.push({
          label: p.title,
          legalBasis: p.legal_basis,
          status: `${p.status} (v${p.current_version})`,
          page: cursor
        });
        cursor += count;
      }

      // Pass 2: Renderiza o documento único consolidado na mesma aba com a numeração exata verificada
      const tocHtmlFinal = buildTocHtml(bundle.process.numero_processo_licitatorio, finalTocEntries);
      const unifiedHtml = `<!DOCTYPE html>
      <html lang="pt-BR">
        <head><meta charset="utf-8"/>${PDF_STYLES}</head>
        <body>
          <div>${coverHtml}</div>
          <div class="page-break">${tocHtmlFinal}</div>
          <div class="page-break">${auditHtml}</div>
          ${pieceHtmls.map((h) => `<div class="page-break">${h}</div>`).join('\n')}
        </body>
      </html>`;

      await page.setContent(unifiedHtml, { waitUntil: 'load', timeout: 30_000 });
      const pdfBytes = await page.pdf({
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate,
        footerTemplate,
        margin: { top: '28mm', bottom: '20mm', left: '16mm', right: '16mm' }
      });
      return Buffer.from(pdfBytes);
    } finally {
      await page.close().catch(() => {});
    }
  } catch (err: any) {
    console.warn(`[GOVFLOW PDF] Falha na renderização Chromium (${err?.message || 'erro'}). Ativando fallback PDFKit.`);
    return generatePdfFallback(bundle, activePieces);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

function findUnicodeFontPair(): { regular: string; bold: string } | null {
  const candidates: Array<{ regular: string; bold: string }> = [
    { regular: 'C:\\Windows\\Fonts\\arial.ttf', bold: 'C:\\Windows\\Fonts\\arialbd.ttf' },
    { regular: 'C:\\Windows\\Fonts\\calibri.ttf', bold: 'C:\\Windows\\Fonts\\calibrib.ttf' },
    { regular: 'C:\\Windows\\Fonts\\segoeui.ttf', bold: 'C:\\Windows\\Fonts\\segoeuib.ttf' },
    { regular: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', bold: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' },
    { regular: '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', bold: '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf' }
  ];
  for (const pair of candidates) {
    if (fs.existsSync(pair.regular)) {
      return {
        regular: pair.regular,
        bold: fs.existsSync(pair.bold) ? pair.bold : pair.regular
      };
    }
  }
  return null;
}

function htmlToPlainText(html: string): string {
  const raw = (html || '')
    .replace(/<\/(p|h1|h2|h3|h4|li|tr|div)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ');
  const $ = cheerio.load(`<div id="__pdf_plain">${raw}</div>`, null, false);
  return normalizeUtf8Text($('#__pdf_plain').text())
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function generatePdfFallback(bundle: ProcessBundle, activePieces: AgentPiece[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFKitDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const fontPair = findUnicodeFontPair();
    let regularFont = 'Helvetica';
    let boldFont = 'Helvetica-Bold';
    if (fontPair) {
      doc.registerFont('DocRegular', fontPair.regular);
      doc.registerFont('DocBold', fontPair.bold);
      regularFont = 'DocRegular';
      boldFont = 'DocBold';
    }
    const fmt = (text: unknown): string =>
      fontPair ? normalizeUtf8Text(text) : normalizeWinAnsiFallback(text);

    const { institution: inst, process: proc } = bundle;

    // Capa
    doc.font(boldFont).fontSize(15).fillColor('#071D41').text(fmt(inst.razao_social), { align: 'center' });
    doc.font(regularFont).fontSize(10).fillColor('#475569').text(fmt(`CNPJ: ${formatCnpj(inst.cnpj)} — ${inst.municipio}/${inst.uf}`), { align: 'center' });
    doc.moveDown(2);
    doc.font(boldFont).fontSize(18).fillColor('#071D41').text(fmt(`DOSSIÊ DO PROCESSO LICITATÓRIO Nº ${proc.numero_processo_licitatorio}`), { align: 'center' });
    doc.font(regularFont).fontSize(12).text(fmt(`Processo Administrativo nº ${proc.numero_processo_administrativo}`), { align: 'center' });
    doc.moveDown(1.5);
    doc.font(regularFont).fontSize(10).fillColor('#1E293B');
    doc.text(fmt(`Objeto: ${proc.titulo_resumido}`));
    doc.text(fmt(`Modalidade: ${getModalidadeLabel(proc.modalidade)}`));
    doc.text(fmt(`Modo de Disputa: ${getModoDisputaLabel(proc.modo_disputa)}`));
    doc.text(fmt(`Critério de Julgamento: ${getCriterioLabel(proc.criterio_julgamento)}`));
    doc.text(fmt(`Valor Estimado: ${formatCurrencyBRL(proc.valor_estimado_global)}`));
    doc.text(fmt(`Compilado em: ${formatDateBR(new Date())}`));

    for (const piece of activePieces) {
      doc.addPage();
      doc.font(boldFont).fontSize(13).fillColor('#071D41').text(fmt(piece.title));
      doc.font(regularFont).fontSize(9).fillColor('#1351B4').text(fmt(`Fundamentação: ${piece.legal_basis} | Status: ${piece.status} (v${piece.current_version})`));
      doc.moveDown(0.5);
      doc.font(regularFont).fontSize(10).fillColor('#1E293B').text(fmt(htmlToPlainText(piece.html_content) || 'Peça pendente de execução.'));
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.font(regularFont).fontSize(8).fillColor('#64748B').text(
        fmt(`${inst.razao_social} | Proc. ${proc.numero_processo_licitatorio} | Página ${i + 1} de ${range.count}`),
        50,
        doc.page.height - 35,
        { align: 'center', width: doc.page.width - 100 }
      );
    }

    doc.end();
  });
}
