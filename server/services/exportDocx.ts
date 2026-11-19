import * as cheerio from 'cheerio';
import JSZip from 'jszip';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx';
import type { AgentPiece, ContractAnalysisRecord, Institution, ProcessBundle } from '../../shared/types.js';
import {
  CANONICAL_DOCUMENT_FONT,
  CANONICAL_MONO_FONT,
  normalizeUtf8Text
} from '../../shared/typography.js';
import {
  formatCnpj,
  formatCurrencyBRL,
  formatDateTimeBR,
  formatSessaoPublicaLabel,
  getCriterioLabel,
  getFormatoLanceLabel,
  getModalidadeLabel,
  getModoDisputaLabel,
  getTipoContratacaoLabel
} from '../../shared/labels.js';
import { formatDotacoesSummary } from '../db/repository.js';

// PNG 1x1 transparente válido como fallback caso o logo enviado seja SVG
const FALLBACK_1PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

function createDocxDocumentStyles() {
  return {
    default: {
      document: {
        run: {
          font: CANONICAL_DOCUMENT_FONT,
          size: 21,
          color: '1E293B',
          language: { value: 'pt-BR' }
        }
      }
    }
  };
}

function extractImageDimensions(
  mimeSubtype: string,
  buffer: Buffer
): { width: number; height: number } | null {
  try {
    if (mimeSubtype === 'png' && buffer.length >= 24 && buffer.toString('ascii', 12, 16) === 'IHDR') {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      if (width > 0 && height > 0) return { width, height };
    }
    if (mimeSubtype === 'gif' && buffer.length >= 10) {
      const width = buffer.readUInt16LE(6);
      const height = buffer.readUInt16LE(8);
      if (width > 0 && height > 0) return { width, height };
    }
    if ((mimeSubtype === 'jpeg' || mimeSubtype === 'jpg') && buffer.length >= 4) {
      let i = 2;
      while (i + 9 < buffer.length) {
        if (buffer[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buffer[i + 1];
        if (marker === 0xd8 || marker === 0xd9) {
          i += 2;
          continue;
        }
        if (i + 3 >= buffer.length) break;
        const segLen = buffer.readUInt16BE(i + 2);
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc &&
          i + 8 < buffer.length
        ) {
          const height = buffer.readUInt16BE(i + 5);
          const width = buffer.readUInt16BE(i + 7);
          if (width > 0 && height > 0) return { width, height };
        }
        if (segLen < 2) break;
        i += 2 + segLen;
      }
    }
    if (mimeSubtype.includes('svg')) {
      const svgText = buffer.toString('utf8', 0, Math.min(buffer.length, 4096));
      const vb = svgText.match(/viewBox\s*=\s*["'][\s,]*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
      if (vb) {
        const w = Number(vb[1]);
        const h = Number(vb[2]);
        if (w > 0 && h > 0) return { width: w, height: h };
      }
      const wMatch = svgText.match(/\bwidth\s*=\s*["']([\d.]+)/i);
      const hMatch = svgText.match(/\bheight\s*=\s*["']([\d.]+)/i);
      if (wMatch && hMatch) {
        const w = Number(wMatch[1]);
        const h = Number(hMatch[1]);
        if (w > 0 && h > 0) return { width: w, height: h };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function fitWithinBox(
  naturalWidth: number | undefined,
  naturalHeight: number | undefined,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  if (!naturalWidth || !naturalHeight || naturalWidth <= 0 || naturalHeight <= 0) {
    return { width: maxHeight, height: maxHeight };
  }
  const scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight);
  return {
    width: Math.max(24, Math.round(naturalWidth * scale)),
    height: Math.max(24, Math.round(naturalHeight * scale))
  };
}

function buildLogoImageRun(
  logoDataUrl: string | undefined,
  maxWidth = 115,
  maxHeight = 68
): ImageRun | null {
  if (!logoDataUrl || !logoDataUrl.startsWith('data:image/')) return null;
  const match = logoDataUrl.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!match) return null;

  const mimeSubtype = match[1].toLowerCase();
  const buffer = Buffer.from(match[2], 'base64');
  const dims = extractImageDimensions(mimeSubtype, buffer);
  const transformation = fitWithinBox(dims?.width, dims?.height, maxWidth, maxHeight);

  if (mimeSubtype === 'png') {
    return new ImageRun({
      type: 'png',
      data: buffer,
      transformation
    });
  }
  if (mimeSubtype === 'jpeg' || mimeSubtype === 'jpg') {
    return new ImageRun({
      type: 'jpg',
      data: buffer,
      transformation
    });
  }
  if (mimeSubtype === 'gif') {
    return new ImageRun({
      type: 'gif',
      data: buffer,
      transformation
    });
  }
  if (mimeSubtype.includes('svg')) {
    return new ImageRun({
      type: 'svg',
      data: buffer,
      transformation,
      fallback: { type: 'png', data: FALLBACK_1PX_PNG }
    });
  }
  return null;
}

function buildInstitutionalHeader(bundle: ProcessBundle): Header {
  const { institution: inst, process: proc } = bundle;
  const logoRun = buildLogoImageRun(inst.logo_data_url);

  const leftChildren: any[] = [];
  if (logoRun) {
    leftChildren.push(
      new Paragraph({
        children: [logoRun],
        alignment: AlignmentType.CENTER
      })
    );
  }

  const centerParagraph = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      new TextRun({ text: normalizeUtf8Text(inst.razao_social.toUpperCase()), font: CANONICAL_DOCUMENT_FONT, bold: true, size: 18, color: '071D41' }),
      new TextRun({ break: 1, text: normalizeUtf8Text(`CNPJ: ${formatCnpj(inst.cnpj)} — ${inst.municipio}/${inst.uf}`), font: CANONICAL_DOCUMENT_FONT, size: 16, color: '475569' }),
      new TextRun({ break: 1, text: normalizeUtf8Text(inst.endereco_completo || ''), font: CANONICAL_DOCUMENT_FONT, size: 15, color: '64748B' })
    ]
  });

  const rightParagraph = new Paragraph({
    alignment: AlignmentType.RIGHT,
    children: [
      new TextRun({ text: normalizeUtf8Text(`Proc. Lic.: ${proc.numero_processo_licitatorio}`), font: CANONICAL_DOCUMENT_FONT, bold: true, size: 16, color: '071D41' }),
      new TextRun({ break: 1, text: normalizeUtf8Text(`Proc. Adm.: ${proc.numero_processo_administrativo}`), font: CANONICAL_DOCUMENT_FONT, size: 15, color: '334155' })
    ]
  });

  const noBorders = {
    top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    bottom: { style: BorderStyle.SINGLE, size: 8, color: '071D41' }
  };

  return new Header({
    children: [
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: [
              new TableCell({
                width: { size: 20, type: WidthType.PERCENTAGE },
                borders: noBorders,
                children: leftChildren.length > 0 ? leftChildren : [new Paragraph('')]
              }),
              new TableCell({
                width: { size: 56, type: WidthType.PERCENTAGE },
                borders: noBorders,
                children: [centerParagraph]
              }),
              new TableCell({
                width: { size: 24, type: WidthType.PERCENTAGE },
                borders: noBorders,
                children: [rightParagraph]
              })
            ]
          })
        ]
      })
    ]
  });
}

function buildInstitutionalFooter(bundle: ProcessBundle): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' } },
        spacing: { before: 80 },
        children: [
          new TextRun({
            text: normalizeUtf8Text(`GOVFLOW 14.133 — ${bundle.institution.nome_fantasia || bundle.institution.razao_social} | Proc. ${bundle.process.numero_processo_licitatorio} | Página `),
            font: CANONICAL_DOCUMENT_FONT,
            size: 16,
            color: '64748B'
          }),
          new TextRun({ children: [PageNumber.CURRENT], font: CANONICAL_DOCUMENT_FONT, size: 16, color: '64748B' }),
          new TextRun({ text: ' de ', font: CANONICAL_DOCUMENT_FONT, size: 16, color: '64748B' }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], font: CANONICAL_DOCUMENT_FONT, size: 16, color: '64748B' })
        ]
      })
    ]
  });
}

const TABLE_CELL_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
  left: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
  right: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' }
};

const TABLE_CELL_MARGINS = {
  top: 75,
  bottom: 75,
  left: 110,
  right: 110
};

const A4_SECTION_PROPERTIES = {
  page: {
    size: {
      width: 11906,
      height: 16838
    },
    margin: {
      top: 1500,
      right: 1134,
      bottom: 1200,
      left: 1134,
      header: 520,
      footer: 520
    }
  }
};

interface InlineStyleFlags {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  code?: boolean;
  small?: boolean;
  color?: string;
}

function extractInlineRuns(
  $: cheerio.CheerioAPI,
  el: any,
  style: InlineStyleFlags = {}
): TextRun[] {
  const runs: TextRun[] = [];
  $(el)
    .contents()
    .each((_, node) => {
      if (node.type === 'text') {
        const txt = normalizeUtf8Text((node as any).data as string);
        if (txt && txt.replace(/\s+/g, ' ').trim().length > 0) {
          runs.push(
            new TextRun({
              text: txt.replace(/\s+/g, ' '),
              bold: Boolean(style.bold),
              italics: Boolean(style.italic),
              underline: style.underline ? {} : undefined,
              font: style.code ? CANONICAL_MONO_FONT : CANONICAL_DOCUMENT_FONT,
              size: style.code ? 17 : style.small ? 17 : 21,
              color: style.color
            })
          );
        } else if (txt === ' ') {
          runs.push(new TextRun({ text: ' ', font: style.code ? CANONICAL_MONO_FONT : CANONICAL_DOCUMENT_FONT, size: style.small ? 17 : 21 }));
        }
      } else if (node.type === 'tag') {
        const tag = (node as any).tagName?.toLowerCase();
        if (tag === 'br') {
          runs.push(new TextRun({ break: 1 }));
        } else {
          runs.push(
            ...extractInlineRuns($, node, {
              bold: style.bold || tag === 'strong' || tag === 'b',
              italic: style.italic || tag === 'em' || tag === 'i',
              underline: style.underline || tag === 'u',
              code: style.code || tag === 'code',
              small: style.small || tag === 'small',
              color: style.color
            })
          );
        }
      }
    });
  return runs;
}

function buildTableCellChildren(
  $: cheerio.CheerioAPI,
  cell: any,
  isHeaderRow: boolean,
  isMetaLabelCell = false
): Paragraph[] {
  const $cell = $(cell);
  const imgSrc = $cell.find('img').first().attr('src');
  if (imgSrc && imgSrc.startsWith('data:image/')) {
    const imgRun = buildLogoImageRun(imgSrc, 155, 88);
    if (imgRun) {
      return [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [imgRun]
        })
      ];
    }
  }

  const textColor = isHeaderRow ? 'FFFFFF' : isMetaLabelCell ? '071D41' : '1E293B';
  const runs = extractInlineRuns($, cell, {
    bold: isHeaderRow || isMetaLabelCell,
    small: true,
    color: textColor
  });

  return [
    new Paragraph({
      spacing: { before: 20, after: 20 },
      children:
        runs.length > 0
          ? runs
          : [
              new TextRun({
                text: normalizeUtf8Text($cell.text().trim().replace(/\s+/g, ' ')) || ' ',
                bold: isHeaderRow || isMetaLabelCell,
                color: textColor,
                font: CANONICAL_DOCUMENT_FONT,
                size: 18
              })
            ]
    })
  ];
}

function appendElementBlocks(
  $: cheerio.CheerioAPI,
  el: any,
  blocks: (Paragraph | Table)[]
): void {
  const tag = (el as any).tagName?.toLowerCase();

  if (tag === 'h1' || tag === 'h2') {
    blocks.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 220, after: 100 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '1351B4' } },
        children: [
          new TextRun({
            text: normalizeUtf8Text($(el).text().trim()),
            bold: true,
            font: CANONICAL_DOCUMENT_FONT,
            size: 26,
            color: '071D41'
          })
        ]
      })
    );
  } else if (tag === 'h3' || tag === 'h4') {
    blocks.push(
      new Paragraph({
        heading: tag === 'h3' ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_4,
        spacing: { before: 160, after: 80 },
        children: [
          new TextRun({
            text: normalizeUtf8Text($(el).text().trim()),
            bold: true,
            font: CANONICAL_DOCUMENT_FONT,
            size: tag === 'h3' ? 23 : 21,
            color: tag === 'h3' ? '1351B4' : '071D41'
          })
        ]
      })
    );
  } else if (tag === 'hr') {
    blocks.push(
      new Paragraph({
        spacing: { before: 100, after: 120 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CBD5E1' } },
        children: []
      })
    );
  } else if (tag === 'div') {
    const hasBlockChildren = $(el).children('h1,h2,h3,h4,p,blockquote,div,ul,ol,table,hr').length > 0;
    if (hasBlockChildren) {
      $(el)
        .children()
        .each((_, child) => appendElementBlocks($, child, blocks));
    } else {
      const runs = extractInlineRuns($, el);
      if (runs.length > 0) {
        blocks.push(
          new Paragraph({
            alignment: AlignmentType.JUSTIFIED,
            spacing: { after: 110 },
            children: runs
          })
        );
      }
    }
  } else if (tag === 'blockquote') {
    const runs = extractInlineRuns($, el);
    if (runs.length > 0) {
      blocks.push(
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          indent: { left: 160, right: 120 },
          spacing: { before: 100, after: 140 },
          border: {
            left: { style: BorderStyle.SINGLE, size: 18, color: '1351B4', space: 10 }
          },
          shading: { type: ShadingType.CLEAR, fill: 'F8FAFC', color: 'auto' },
          children: runs
        })
      );
    }
  } else if (tag === 'p') {
    const runs = extractInlineRuns($, el);
    if (runs.length > 0) {
      blocks.push(
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          spacing: { after: 110 },
          children: runs
        })
      );
    }
  } else if (tag === 'ul' || tag === 'ol') {
    $(el)
      .children('li')
      .each((idx, li) => {
        const prefix = tag === 'ol' ? `${idx + 1}. ` : '• ';
        const runs = [
          new TextRun({ text: prefix, bold: true, font: CANONICAL_DOCUMENT_FONT, size: 21 }),
          ...extractInlineRuns($, li)
        ];
        blocks.push(
          new Paragraph({
            alignment: AlignmentType.JUSTIFIED,
            indent: { left: 360 },
            spacing: { after: 70 },
            children: runs
          })
        );
      });
  } else if (tag === 'table') {
    const isMetaTable = $(el).hasClass('meta-table');
    const tableRows: TableRow[] = [];
    $(el)
      .find('tr')
      .each((rowIdx, tr) => {
        if ($(tr).closest('table')[0] !== el) return;
        const cells = $(tr).find('th, td').toArray();
        if (cells.length === 0) return;
        const isHeaderRow = $(tr).parent().is('thead') || $(cells[0]).is('th');
        const docxCells = cells.map((cell, cellIdx) => {
          const colSpan = Number($(cell).attr('colspan') || 1);
          const isMetaLabelCell = isMetaTable && !isHeaderRow && cellIdx === 0;
          return new TableCell({
            columnSpan: colSpan > 1 ? colSpan : undefined,
            borders: TABLE_CELL_BORDERS,
            margins: TABLE_CELL_MARGINS,
            shading: isHeaderRow
              ? { type: ShadingType.CLEAR, fill: '071D41', color: 'auto' }
              : isMetaLabelCell
                ? { type: ShadingType.CLEAR, fill: 'F1F5F9', color: 'auto' }
                : rowIdx % 2 === 1
                  ? { type: ShadingType.CLEAR, fill: 'F8FAFC', color: 'auto' }
                  : undefined,
            children: buildTableCellChildren($, cell, isHeaderRow, isMetaLabelCell)
          });
        });
        tableRows.push(new TableRow({ children: docxCells, tableHeader: isHeaderRow }));
      });

    if (tableRows.length > 0) {
      blocks.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: tableRows
        })
      );
      blocks.push(new Paragraph({ spacing: { after: 110 }, children: [] }));
    }
  }
}

function htmlToDocxBlocks(html: string): (Paragraph | Table)[] {
  if (!html || !html.trim()) {
    return [
      new Paragraph({
        children: [new TextRun({ text: 'Peça ainda não gerada.', italics: true, color: '64748B', font: CANONICAL_DOCUMENT_FONT, size: 21 })]
      })
    ];
  }

  const $ = cheerio.load(`<div id="__root">${normalizeUtf8Text(html)}</div>`, null, false);
  const blocks: (Paragraph | Table)[] = [];

  $('#__root')
    .children()
    .each((_, el) => appendElementBlocks($, el, blocks));

  return blocks;
}

function pieceFooterStamp(piece: AgentPiece): Paragraph[] {
  if (!piece.approved_at) return [];
  return [
    new Paragraph({
      spacing: { before: 180, after: 120 },
      border: {
        top: { style: BorderStyle.DASHED, size: 4, color: '16A34A' },
        bottom: { style: BorderStyle.DASHED, size: 4, color: '16A34A' },
        left: { style: BorderStyle.DASHED, size: 4, color: '16A34A' },
        right: { style: BorderStyle.DASHED, size: 4, color: '16A34A' }
      },
      children: [
        new TextRun({
          text: normalizeUtf8Text(`ASSINATURA E APROVAÇÃO: Peça v${piece.current_version} aprovada por ${piece.approved_by || 'Gestor'} (${piece.approved_role || ''}) em ${formatDateTimeBR(piece.approved_at)} | Hash SHA-256: ${(piece.content_hash || '').slice(0, 24)}...`),
          font: CANONICAL_DOCUMENT_FONT,
          size: 18,
          color: '166534',
          bold: true
        })
      ]
    })
  ];
}

export async function exportSinglePieceDocx(bundle: ProcessBundle, agentNumber: number): Promise<Buffer> {
  const piece = bundle.pieces.find((p) => p.agent_number === agentNumber);
  if (!piece) {
    throw new Error(`Peça do agente ${agentNumber} não encontrada.`);
  }

  const doc = new Document({
    styles: createDocxDocumentStyles(),
    sections: [
      {
        properties: A4_SECTION_PROPERTIES,
        headers: { default: buildInstitutionalHeader(bundle) },
        footers: { default: buildInstitutionalFooter(bundle) },
        children: [
          new Paragraph({
            spacing: { after: 120 },
            children: [
              new TextRun({ text: normalizeUtf8Text(`${piece.title} — ${piece.legal_basis}`), font: CANONICAL_DOCUMENT_FONT, size: 18, color: '1351B4', italics: true })
            ]
          }),
          ...htmlToDocxBlocks(piece.html_content),
          ...pieceFooterStamp(piece)
        ]
      }
    ]
  });

  return Buffer.from(await Packer.toBuffer(doc));
}

export async function exportConsolidatedDocx(bundle: ProcessBundle): Promise<Buffer> {
  const activePieces = bundle.pieces.filter((p) => p.status !== 'DISPENSADO');
  const { process: proc, institution: inst, secretario: sec, dotacao: dot } = bundle;

  const coverBlocks: (Paragraph | Table)[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 400, after: 120 },
      children: [
        new TextRun({
          text: 'DOSSIÊ OFICIAL DE CONTRATAÇÃO PÚBLICA — LEI Nº 14.133/2021',
          font: CANONICAL_DOCUMENT_FONT,
          bold: true,
          size: 24,
          color: '1351B4'
        })
      ]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({
          text: normalizeUtf8Text(`PROCESSO LICITATÓRIO Nº ${proc.numero_processo_licitatorio}`),
          font: CANONICAL_DOCUMENT_FONT,
          bold: true,
          size: 34,
          color: '071D41'
        }),
        new TextRun({
          break: 1,
          text: normalizeUtf8Text(`Processo Administrativo nº ${proc.numero_processo_administrativo}`),
          font: CANONICAL_DOCUMENT_FONT,
          size: 24,
          color: '334155'
        })
      ]
    }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        ['Órgão Promotor', `${inst.razao_social} (CNPJ ${formatCnpj(inst.cnpj)})`],
        ['Objeto', proc.titulo_resumido],
        ['Tipo da Contratação', getTipoContratacaoLabel(proc.tipo_contratacao)],
        ['Modalidade', getModalidadeLabel(proc.modalidade)],
        ['Data e Horário da Sessão', formatSessaoPublicaLabel(proc.data_certame, proc.horario_disputa)],
        ['Modo de Disputa', getModoDisputaLabel(proc.modo_disputa)],
        ['Critério / Lance', `${getCriterioLabel(proc.criterio_julgamento)} (${getFormatoLanceLabel(proc.formato_lance)})`],
        ['SRP (Art. 82)', proc.usar_srp ? 'Sim — Ata de Registro de Preços Obrigatória' : 'Não'],
        [
          'Pesquisa de Preço (Art. 23)',
          proc.pesquisa_preco_itens?.length
            ? `${proc.pesquisa_preco_arquivo || 'Anexo carregado'} — ${proc.pesquisa_preco_itens.length} item(ns) estruturado(s)`
            : proc.pesquisa_preco_arquivo || 'Estimativa padronizada / Preenchimento no ETP'
        ],
        ['Valor Global Estimado', formatCurrencyBRL(proc.valor_estimado_global)],
        ['Ordenador de Despesas', `${sec?.secretaria || '—'} | ${sec?.nome || 'A designar'} (${sec?.portaria_nomeacao || '—'})`],
        ['Dotação(ões) Orçamentária(s)', formatDotacoesSummary(bundle.dotacoes_vinculadas ?? (dot ? [dot] : []), proc.dotacoes_manuais)]
      ].map(
        ([k, v]) =>
          new TableRow({
            children: [
              new TableCell({
                width: { size: 32, type: WidthType.PERCENTAGE },
                borders: TABLE_CELL_BORDERS,
                margins: TABLE_CELL_MARGINS,
                shading: { type: ShadingType.CLEAR, fill: 'EFF6FF', color: 'auto' },
                children: [new Paragraph({ children: [new TextRun({ text: normalizeUtf8Text(k), bold: true, size: 19, color: '071D41', font: CANONICAL_DOCUMENT_FONT })] })]
              }),
              new TableCell({
                width: { size: 68, type: WidthType.PERCENTAGE },
                borders: TABLE_CELL_BORDERS,
                margins: TABLE_CELL_MARGINS,
                children: [new Paragraph({ children: [new TextRun({ text: normalizeUtf8Text(v), size: 19, font: CANONICAL_DOCUMENT_FONT })] })]
              })
            ]
          })
      )
    })
  ];

  const allChildren: (Paragraph | Table)[] = [...coverBlocks];

  for (const piece of activePieces) {
    allChildren.push(new Paragraph({ children: [new PageBreak()] }));
    allChildren.push(
      new Paragraph({
        spacing: { after: 100 },
        children: [new TextRun({ text: normalizeUtf8Text(`${piece.title} (${piece.legal_basis})`), font: CANONICAL_DOCUMENT_FONT, size: 18, color: '1351B4', italics: true })]
      })
    );
    allChildren.push(...htmlToDocxBlocks(piece.html_content));
    allChildren.push(...pieceFooterStamp(piece));
  }

  const doc = new Document({
    styles: createDocxDocumentStyles(),
    sections: [
      {
        properties: A4_SECTION_PROPERTIES,
        headers: { default: buildInstitutionalHeader(bundle) },
        footers: { default: buildInstitutionalFooter(bundle) },
        children: allChildren
      }
    ]
  });

  return Buffer.from(await Packer.toBuffer(doc));
}

export async function exportDossierZip(bundle: ProcessBundle): Promise<Buffer> {
  const zip = new JSZip();
  const activePieces = bundle.pieces.filter((p) => p.status !== 'DISPENSADO');

  const consolidatedDocx = await exportConsolidatedDocx(bundle);
  zip.file('00_Dossie_Completo_Consolidado.docx', consolidatedDocx);

  for (const piece of activePieces) {
    const safeKey = piece.agent_key.replace(/[^a-z0-9_]/gi, '_');
    const fileName = `${String(piece.agent_number).padStart(2, '0')}_${safeKey}.docx`;
    const buf = await exportSinglePieceDocx(bundle, piece.agent_number);
    zip.file(fileName, buf);
  }

  zip.file(
    'trilha_auditoria.json',
    JSON.stringify(
      {
        processo_licitatorio: bundle.process.numero_processo_licitatorio,
        processo_administrativo: bundle.process.numero_processo_administrativo,
        orgao: bundle.institution.razao_social,
        cnpj: bundle.institution.cnpj,
        exportado_em: new Date().toISOString(),
        audit_logs: bundle.audit_logs
      },
      null,
      2
    )
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export async function exportContractAnalysisDocx(
  analysis: ContractAnalysisRecord,
  institution?: Institution | null
): Promise<Buffer> {
  const orgTitle =
    institution?.razao_social ||
    analysis.institution_name ||
    analysis.extracted_metadata.contratante ||
    'GOVFLOW 14.133 — Controladoria & Procuradoria';

  const headerPara = new Paragraph({
    alignment: AlignmentType.CENTER,
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: '071D41' } },
    spacing: { after: 100 },
    children: [
      new TextRun({
        text: normalizeUtf8Text(orgTitle.toUpperCase()),
        font: CANONICAL_DOCUMENT_FONT,
        bold: true,
        size: 18,
        color: '071D41'
      }),
      new TextRun({
        break: 1,
        text: normalizeUtf8Text('Análise Técnica e Jurídica de Contratos Administrativos — Lei nº 14.133/2021 (Art. 92)'),
        font: CANONICAL_DOCUMENT_FONT,
        size: 15,
        color: '475569'
      })
    ]
  });

  const footerPara = new Paragraph({
    alignment: AlignmentType.CENTER,
    border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' } },
    spacing: { before: 80 },
    children: [
      new TextRun({
        text: normalizeUtf8Text(`GOVFLOW 14.133 — Análise de Contrato (${analysis.title}) | Página `),
        font: CANONICAL_DOCUMENT_FONT,
        size: 16,
        color: '475569'
      }),
      new TextRun({ children: [PageNumber.CURRENT], font: CANONICAL_DOCUMENT_FONT, size: 16, color: '475569' }),
      new TextRun({ text: ' de ', font: CANONICAL_DOCUMENT_FONT, size: 16, color: '475569' }),
      new TextRun({ children: [PageNumber.TOTAL_PAGES], font: CANONICAL_DOCUMENT_FONT, size: 16, color: '475569' })
    ]
  });

  const doc = new Document({
    styles: createDocxDocumentStyles(),
    sections: [
      {
        properties: A4_SECTION_PROPERTIES,
        headers: { default: new Header({ children: [headerPara] }) },
        footers: { default: new Footer({ children: [footerPara] }) },
        children: [
          new Paragraph({
            spacing: { after: 100 },
            children: [
              new TextRun({
                text: normalizeUtf8Text(`Parecer de Auditoria Contratual — Conformidade: ${analysis.compliance_score}% (${analysis.verdict}) | Motor: ${analysis.ai_provider_used}`),
                font: CANONICAL_DOCUMENT_FONT,
                size: 18,
                color: '1351B4',
                italics: true
              })
            ]
          }),
          ...htmlToDocxBlocks(analysis.report_html)
        ]
      }
    ]
  });

  return Buffer.from(await Packer.toBuffer(doc));
}
