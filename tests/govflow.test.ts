import { describe, expect, it, beforeAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import PDFKitDocument from 'pdfkit';
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import JSZip from 'jszip';

// Configura banco temporário isolado antes de importar módulos que usam getDb()
const tmpDbPath = path.join(os.tmpdir(), `govflow-test-${Date.now()}.db`);
process.env.GOVFLOW_DB_PATH = tmpDbPath;

import { getDataDir, getDb, isServerlessRuntime } from '../server/db/database.js';
import vercelHandler from '../api/index.js';
import {
  approveAndSignPiece,
  createProcess,
  getProcessBundle,
  listInstitutions,
  listPieceVersions,
  restorePieceVersion,
  saveManualPieceEdit,
  updateProcess,
  upsertInstitution
} from '../server/db/repository.js';
import { isValidCnpj } from '../server/services/cnpjService.js';
import {
  extractFromHtmlContent,
  importDotacoes,
  importSecretarios
} from '../server/services/scraperService.js';
import {
  getAllowedCriteria,
  getAllowedDisputeModes,
  validateCertameConfiguration
} from '../server/services/legalRules.js';
import {
  executeAgentStep,
  mergeLegalAlerts,
  mergeStructuredJson
} from '../server/services/agentEngine.js';
import {
  analyzePricePortfolio,
  buildAgentSpecificTaskPrompt,
  buildAgentSystemPrompt,
  formatPrefeitoRoleAndName
} from '../server/services/promptRegistry.js';
import {
  buildGeminiGenerationConfig,
  parseJsonPayload,
  tryGenerateWithLlm
} from '../server/services/llmClient.js';
import { generateConsolidatedPdf } from '../server/services/exportPdf.js';
import {
  exportConsolidatedDocx,
  exportDossierZip,
  exportSinglePieceDocx
} from '../server/services/exportDocx.js';
import { parsePriceResearchFile } from '../server/services/priceResearchParser.js';
import {
  clearGeminiAuthCache,
  createServiceAccountJwtAssertion,
  DEFAULT_GEMINI_MODEL,
  diagnoseGeminiApiHttpError,
  getGeminiAuthHeadersAndUrl,
  normalizeGeminiModelName,
  resolveGeminiCredential,
  sanitizeGeminiApiKey,
  validateManualGeminiApiKey
} from '../server/services/geminiAuth.js';
import {
  clearTcuLiveCache,
  searchTcuJurisprudence
} from '../server/services/tcuJurisprudence.js';
import { createApp } from '../server/index.js';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

describe('GOVFLOW 14.133 — Testes Integrados de Arquitetura, Regras Legais, Agentes e Exportação', () => {
  beforeAll(() => {
    if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
    getDb();
  });

  it('valida dígitos verificadores de CNPJ corretamente', () => {
    expect(isValidCnpj('00.000.000/0001-91')).toBe(true); // Banco do Brasil
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11.111.111/1111-11')).toBe(false);
    expect(isValidCnpj('00.000.000/0001-00')).toBe(false);
  });

  it('extrai secretários e dotações de HTML do Portal da Transparência e importa CSV/JSON', () => {
    const mockHtml = `
      <html><head><title>Portal Transparência Teste</title></head><body>
        <table>
          <thead><tr><th>Secretaria</th><th>Nome</th><th>Cargo</th><th>Portaria</th></tr></thead>
          <tbody>
            <tr><td>Secretaria de Cultura</td><td>Ana Clara Souza</td><td>Secretária de Cultura</td><td>Portaria nº 099/2026</td></tr>
          </tbody>
        </table>
        <table>
          <thead><tr><th>Órgão</th><th>Unidade Orçamentária</th><th>Função</th><th>Elemento</th><th>Fonte</th><th>Saldo</th></tr></thead>
          <tbody>
            <tr><td>02</td><td>02.08.01</td><td>13</td><td>3.3.90.39.00</td><td>1.500.000</td><td>R$ 150.000,00</td></tr>
          </tbody>
        </table>
      </body></html>
    `;
    const scraped = extractFromHtmlContent(mockHtml, 'https://transparencia.teste.gov.br');
    expect(scraped.secretarios.length).toBe(1);
    expect(scraped.secretarios[0].nome).toBe('Ana Clara Souza');
    expect(scraped.dotacoes.length).toBe(1);
    expect(scraped.dotacoes[0].saldo_disponivel).toBe(150000);

    const csvSecs = importSecretarios(
      'secretaria;nome;cargo;portaria\nSecretaria de Esportes;Carlos Lima;Secretário;Portaria 10/2026',
      'csv'
    );
    expect(csvSecs.length).toBe(1);
    expect(csvSecs[0].secretaria).toBe('Secretaria de Esportes');

    const jsonDots = importDotacoes(
      JSON.stringify([{ orgao: '02', unidade: '02.09.01', elemento: '4.4.90.52.00', saldo: 90000 }]),
      'json'
    );
    expect(jsonDots.length).toBe(1);
    expect(jsonDots[0].elemento_despesa).toBe('4.4.90.52.00');
  });

  it('aplica regras estritas da Lei nº 14.133/2021 (Art. 28, 33, 56, 82)', () => {
    expect(getAllowedCriteria('PREGAO_ELETRONICO')).toEqual(['MENOR_PRECO', 'MAIOR_DESCONTO']);
    expect(getAllowedCriteria('LEILAO')).toEqual(['MAIOR_LANCE']);
    expect(getAllowedDisputeModes('PREGAO_ELETRONICO', 'MENOR_PRECO')).not.toContain('FECHADO');
    expect(getAllowedDisputeModes('CONCORRENCIA_ELETRONICA', 'TECNICA_E_PRECO')).not.toContain('ABERTO');

    const alerts = validateCertameConfiguration({
      modalidade: 'PREGAO_ELETRONICO',
      modo_disputa: 'FECHADO',
      criterio_julgamento: 'MENOR_PRECO',
      formato_lance: 'POR_ITEM',
      usar_srp: true,
      numero_processo_licitatorio: '099/2026',
      numero_processo_administrativo: '200/2026',
      secretario_id: 's1',
      dotacao_id: 'd1'
    });
    expect(alerts.some((a) => a.severity === 'critical' && a.article.includes('Art. 56'))).toBe(true);
  });

  it('executa encadeamento completo dos 11 agentes, versionamento, integridade estrutural e exportação PDF/DOCX/ZIP', async () => {
    const inst = listInstitutions()[0];
    expect(inst).toBeTruthy();

    const created = createProcess({
      institution_id: inst.id,
      numero_processo_licitatorio: '077/2026',
      numero_processo_administrativo: '1.555/2026',
      titulo_resumido: 'Aquisição de medicamentos da atenção básica para as UBS municipais',
      modalidade: 'PREGAO_ELETRONICO',
      modo_disputa: 'ABERTO_FECHADO',
      criterio_julgamento: 'MENOR_PRECO',
      formato_lance: 'POR_ITEM',
      usar_srp: true,
      valor_estimado_global: 180000,
      demanda_bruta: 'Necessidade de suprir 8 UBS com 500 caixas de medicamentos essenciais e 300 kits de curativos.',
      responsavel_requisitante: 'Farm. Beatriz Santos',
      cargo_requisitante: 'Coordenadora de Assistência Farmacêutica'
    });

    // Agente 08 deve estar ativo (PENDENTE) porque usar_srp = true
    expect(created.pieces.find((p) => p.agent_number === 8)?.status).toBe('PENDENTE');

    // Tentar pular do Agente 01 direto para o Agente 03 deve falhar
    await expect(
      executeAgentStep({ processId: created.process.id, agentNumber: 3 })
    ).rejects.toThrow(/Encadeamento sequencial obrigatório/);

    // Verifica interpolação do Prompt Base e Prompt do Agente 01
    const sysPrompt = buildAgentSystemPrompt(created);
    expect(sysPrompt).toContain('[CONTEXTO INSTITUCIONAL E PROCESSUAL]');
    expect(sysPrompt).toContain('[DIRETRIZES GERAIS DE REDAÇÃO ADMINISTRATIVA]');
    expect(sysPrompt).toContain('077/2026');
    const ag1Prompt = buildAgentSpecificTaskPrompt(1, created, '', '');
    expect(ag1Prompt).toContain('EXPOSIÇÃO DE DEMANDA E NECESSIDADE ADMINISTRATIVA');
    expect(ag1Prompt).toContain('500 caixas de medicamentos essenciais');

    // Executa e aprova sequencialmente todos os 11 agentes
    for (let num = 1; num <= 11; num++) {
      const piece = await executeAgentStep({ processId: created.process.id, agentNumber: num });
      expect(piece.html_content.length).toBeGreaterThan(100);
      expect(piece.status).toBe('AGUARDANDO_REVISAO');

      if (num === 1) {
        expect(piece.html_content).toContain('EXPOSIÇÃO DE DEMANDA E NECESSIDADE ADMINISTRATIVA');
        expect(piece.html_content).toContain('1. Identificação da Área Requisitante');
        expect(piece.html_content).toContain('5. Alinhamento Estratégico');
        expect(piece.html_content).toContain('Cenário de Inércia');
      }

      if (num === 2) {
        const ag2Prompt = buildAgentSpecificTaskPrompt(2, getProcessBundle(created.process.id)!, '', '', {
          dataPretendida: '30/12/2026',
          prioridade: 'Alto'
        });
        expect(ag2Prompt).toContain('DOCUMENTO DE FORMALIZAÇÃO DA DEMANDA (DFD)');
        expect(ag2Prompt).toContain('30/12/2026');
        expect(ag2Prompt).toContain('Alto');
        expect(piece.html_content).toContain('1. Setor Requisitante e Responsável pela Demanda');
        expect(piece.html_content).toContain('6. Indicação de Vinculação com o Plano de Contratações Anual (PCA)');
        expect(piece.html_content).toContain('7. Indicação da Equipe de Planejamento da Contratação');
        expect(piece.html_content).toContain('8. Adequação Orçamentária Preliminar');
        expect(piece.html_content).toContain('Cronograma Macro');
      }

      if (num === 3) {
        // Verifica os 13 incisos do Art. 18 § 1º no ETP e o prompt especialista do Agente 03
        const incisos = piece.structured_json.incisos_art18_par1;
        expect(Object.keys(incisos).length).toBe(13);
        const prompt3 = buildAgentSpecificTaskPrompt(3, getProcessBundle(created.process.id)!, '', '', {
          pesquisaMercado: 'Cotação PNCP nº 123/2026'
        });
        expect(prompt3).toContain('IN SEGES/ME nº 58/2022');
        expect(prompt3).toContain('Cotação PNCP nº 123/2026');
        expect(piece.html_content).toContain('Memória de Cálculo');
        expect(piece.html_content).toContain('Art. 45');
        expect(piece.html_content).toContain('Custo Total de Propriedade');
        expect(piece.html_content).toContain('IN SEGES/ME nº 65/2021');
        expect(piece.html_content).toContain('VIABILIDADE TÉCNICA, SOCIOECONÔMICA E AMBIENTAL DA CONTRATAÇÃO');
      }

      if (num === 4) {
        // Verifica Mapa de Gerenciamento de Riscos (3 fases x 4 riscos = 12 + Matriz Art. 103) e prompt do Agente 04
        const prompt4 = buildAgentSpecificTaskPrompt(4, getProcessBundle(created.process.id)!, '', '');
        expect(prompt4).toContain('Art. 18, inciso X, e Art. 22');
        expect(prompt4).toContain('MAPA DE GERENCIAMENTO DE RISCOS');
        expect(prompt4).not.toContain('{{peca_03.conteudo}}');
        expect(piece.structured_json.fases.planejamento.length).toBe(4);
        expect(piece.structured_json.fases.selecao_fornecedor.length).toBe(4);
        expect(piece.structured_json.fases.gestao_contratual.length).toBe(4);
        expect(piece.structured_json.total_riscos).toBe(12);
        expect(Array.isArray(piece.structured_json.alocacao_riscos_art103)).toBe(true);
        expect(piece.structured_json.alocacao_riscos_art103.length).toBe(4);
        expect(piece.html_content).toContain('Nota Metodológica');
        expect(piece.html_content).toContain('Fase 1: Planejamento da Contratação');
        expect(piece.html_content).toContain('Fase 2: Seleção do Fornecedor');
        expect(piece.html_content).toContain('Fase 3: Gestão Contratual e Execução');
        expect(piece.html_content).toContain('Art. 103');
        expect(piece.html_content).toContain('Bloco de Assinatura — Equipe de Planejamento da Contratação');
      }

      if (num === 5) {
        // Verifica todas as 10 alíneas do Art. 6º, XXIII no Termo de Referência (Anexo I) e prompt do Agente 05
        const prompt5 = buildAgentSpecificTaskPrompt(5, getProcessBundle(created.process.id)!, '', '');
        expect(prompt5).toContain('Art. 6º, inciso XXIII, Art. 40 e Art. 41');
        expect(prompt5).not.toContain('{{peca_04.conteudo}}');
        expect(prompt5).not.toContain('{{peca_03.conteudo}}');
        expect(Object.keys(piece.structured_json.alineas_art6_xxiii).length).toBe(10);
        expect(piece.structured_json.srp_dispensa_dotacao_art17_dec11462).toBe(true);
        expect(piece.html_content).toContain('Código CATMAT/CATSER');
        expect(piece.html_content).toContain('Art. 41');
        expect(piece.html_content).toContain('Art. 122');
        expect(piece.html_content).toContain('Art. 96');
        expect(piece.html_content).toContain('Art. 140');
        expect(piece.html_content).toContain('Art. 141');
        expect(piece.html_content).toContain('Art. 67');
        expect(piece.html_content).toContain('Instrumento de Medição de Resultados (IMR)');
        expect(piece.html_content).toContain('Liquidez Geral');
        expect(piece.html_content).toContain('Súmula nº 263');
        expect(piece.html_content).toContain('Art. 17 do Decreto nº 11.462/2023');
        expect(piece.html_content).toContain('ANEXO I DO EDITAL');
      }

      if (num === 6) {
        // Verifica Termo de Autuação e interpolação de {{peca_05.objeto_resumido}}
        const prompt6 = buildAgentSpecificTaskPrompt(6, getProcessBundle(created.process.id)!, '', '');
        expect(prompt6).toContain('TERMO DE AUTUAÇÃO DE PROCESSO LICITATÓRIO');
        expect(prompt6).toContain('Art. 18 e Art. 12, inciso VI');
        expect(prompt6).not.toContain('{{peca_05.objeto_resumido}}');
        expect(piece.structured_json.sumario_autos.length).toBe(7);
        expect(piece.html_content).toContain('1. Cabeçalho Oficial de Autuação');
        expect(piece.html_content).toContain('2. Certidão de Abertura e Registro');
        expect(piece.html_content).toContain('3. Sumário Inicial dos Autos (Fls.)');
        expect(piece.html_content).toContain('Quadro de Conferência Documental');
        expect(piece.html_content).toContain('4. Encaminhamento Processual');
        expect(piece.html_content).toContain('5. Bloco de Assinatura');
        expect(piece.html_content).toContain('Capa de Autuação');
        expect(piece.html_content).toContain('Despacho de Encaminhamento');
      }

      if (num === 7) {
        // Verifica Minuta de Contrato Administrativo (13 cláusulas do Art. 92 e prompt do Agente 07)
        const prompt7 = buildAgentSpecificTaskPrompt(7, getProcessBundle(created.process.id)!, '', '');
        expect(prompt7).toContain(`MINUTA DE CONTRATO ADMINISTRATIVO Nº ___/${new Date().getFullYear()}`);
        expect(prompt7).not.toContain('{{peca_05.conteudo}}');
        expect(prompt7).not.toContain('{{ano_atual}}');
        expect(piece.structured_json.clausulas_minuta.length).toBe(13);
        expect(piece.html_content).toContain('Cláusula Primeira – Do Objeto');
        expect(piece.html_content).toContain('Cláusula Sexta – Do Reajuste / Repactuação');
        expect(piece.html_content).toContain('Art. 25, § 7º');
        expect(piece.html_content).toContain('Art. 92, XVII');
        expect(piece.html_content).toContain('Dosimetria Objetiva');
        expect(piece.html_content).toContain('Cláusula Décima Terceira – Do Foro');
        expect(piece.html_content).toContain('20 (vinte) dias úteis');
      }

      if (num === 8) {
        // Verifica Minuta da Ata de Registro de Preços (SRP - Arts. 82 a 86 e Decreto 11.462/2023)
        const prompt8 = buildAgentSpecificTaskPrompt(8, getProcessBundle(created.process.id)!, '', '');
        expect(prompt8).toContain(`MINUTA DE ATA DE REGISTRO DE PREÇOS Nº ___/${new Date().getFullYear()}`);
        expect(prompt8).not.toContain('{{peca_05.conteudo}}');
        expect(prompt8).not.toContain('{{ano_atual}}');
        expect(piece.structured_json.clausulas_arp.length).toBe(7);
        expect(piece.html_content).toContain('Marca / Modelo');
        expect(piece.html_content).toContain('Qtd. Máxima Estimada');
        expect(piece.html_content).toContain('Cláusula Segunda – Órgão Gerenciador e Participantes');
        expect(piece.html_content).toContain('50%');
        expect(piece.html_content).toContain('dobro');
        expect(piece.html_content).toContain('Cadastro de Reserva');
        expect(piece.html_content).toContain('primeiro dia útil subsequente à data de divulgação no PNCP');
        expect(piece.html_content).toContain('11.462/2023');
      }

      if (num === 9) {
        // Verifica Edital Consolidado (13 capítulos quando SRP ativo, Arts. 17, 56, 59, 60, 61, 63, 164, 165 e 6 anexos)
        const prompt9 = buildAgentSpecificTaskPrompt(9, getProcessBundle(created.process.id)!, '', '');
        expect(prompt9).toContain('EDITAL DE Pregão Eletrônico');
        expect(prompt9).not.toContain('{{peca_07.conteudo}}');
        expect(prompt9).not.toContain('{{peca_08.conteudo}}');
        expect(piece.structured_json.total_capitulos).toBe(13);
        expect(piece.structured_json.anexos.length).toBe(6);
        expect(piece.html_content).toContain('1. PREÂMBULO OFICIAL');
        expect(piece.html_content).toContain('3. DO REGISTRO DE PREÇOS');
        expect(piece.html_content).toContain('Art. 60');
        expect(piece.html_content).toContain('Art. 61');
        expect(piece.html_content).toContain('Art. 63');
        expect(piece.html_content).toContain('Liquidez Geral');
        expect(piece.html_content).toContain('Anexo VI – Modelo de Proposta Comercial e Declarações Conjuntas');
      }

      if (num === 10) {
        // Parecer jurídico deve possuir checklist, todas as 6 seções e interpolação completa (Peças 01 a 09)
        const prompt10 = buildAgentSpecificTaskPrompt(10, getProcessBundle(created.process.id)!, '', '');
        expect(prompt10).toContain(`PARECER JURÍDICO REFERENCIAL / CONCLUSIVO Nº ___/${new Date().getFullYear()}`);
        expect(prompt10).not.toContain('{{peca_06.conteudo}}');
        expect(prompt10).not.toContain('{{peca_09.conteudo}}');
        expect(Array.isArray(piece.structured_json.checklist_conformidade)).toBe(true);
        expect(piece.structured_json.checklist_conformidade.length).toBe(7);
        expect(piece.html_content).toContain('1. Relatório');
        expect(piece.html_content).toContain('2. Finalidade e Abrangência do Parecer');
        expect(piece.html_content).toContain('3. Análise da Instrução da Fase Preparatória');
        expect(piece.html_content).toContain('4. Análise das Minutas');
        expect(piece.html_content).toContain('5. Checklist de Conformidade Legal');
        expect(piece.html_content).toContain('6. Conclusão e Recomendações');
        expect(piece.html_content).toContain('Art. 53, caput e § 1º, incisos I e II');
        expect(piece.html_content).toContain('Art. 29');
        expect(piece.html_content).toContain('Art. 9º');
        expect(piece.html_content).toContain('Súmula nº 272/TCU');
        expect(piece.html_content).toContain('OAB/');
      }

      if (num === 11) {
        // Verifica Fechamento do Dossiê (Bloco A + Bloco B, 11 peças indexadas e {{auditoria.logs_json}})
        const prompt11 = buildAgentSpecificTaskPrompt(11, getProcessBundle(created.process.id)!, '', '');
        expect(prompt11).toContain('BLOCO A: TERMO DE AUTORIZAÇÃO DE ABERTURA DE LICITAÇÃO');
        expect(prompt11).toContain('BLOCO B: RELATÓRIO DE TRILHA DE AUDITORIA E ÍNDICE DO DOSSIÊ');
        expect(prompt11).not.toContain('{{peca_10.conteudo}}');
        expect(prompt11).not.toContain('{{auditoria.logs_json}}');
        expect(piece.structured_json.total_pecas_indexadas).toBe(11);
        expect(piece.html_content).toContain('BLOCO A: TERMO DE AUTORIZAÇÃO DE ABERTURA DE LICITAÇÃO');
        expect(piece.html_content).toContain('BLOCO B: RELATÓRIO DE TRILHA DE AUDITORIA E ÍNDICE DO DOSSIÊ');
        expect(piece.html_content).toContain('Quadro Síntese Executivo');
        expect(piece.html_content).toContain('Diário Oficial do Município');
        expect(piece.html_content).toContain('Portal Nacional de Contratações Públicas (PNCP)');
        expect(piece.html_content).toContain('Art. 7º, § 1º');
      }

      const approved = approveAndSignPiece({
        processId: created.process.id,
        agentNumber: num,
        actorName: 'Dr. Henrique Almeida',
        actorRole: 'Secretário Municipal'
      });
      expect(approved.status).toBe('APROVADO');
      expect(approved.content_hash).toBeTruthy();
    }

    // Testa edição manual + regeneração com feedback + restauração de versão
    const edited = saveManualPieceEdit({
      processId: created.process.id,
      agentNumber: 5,
      htmlContent: '<h2>5. TERMO DE REFERÊNCIA EDITADO</h2><p>Texto revisado manualmente.</p>',
      actorName: 'Revisor Técnico'
    });
    expect(edited.current_version).toBe(2);

    const regen = await executeAgentStep({
      processId: created.process.id,
      agentNumber: 5,
      feedback: 'Incluir entrega parcelada em 10 dias úteis'
    });
    expect(regen.current_version).toBe(3);
    expect(regen.html_content).toContain('Incluir entrega parcelada em 10 dias úteis');

    const versions = listPieceVersions(regen.id);
    expect(versions.length).toBe(3);
    const restored = restorePieceVersion({
      processId: created.process.id,
      agentNumber: 5,
      versionNumber: 2,
      actorName: 'Revisor Técnico'
    });
    expect(restored.current_version).toBe(4);
    expect(restored.html_content).toContain('TERMO DE REFERÊNCIA EDITADO');

    // Testa integridade ao alterar número do processo e dados da prefeitura
    upsertInstitution({ id: inst.id, nome_fantasia: 'Prefeitura Atualizada de Teste' });
    const updatedBundle = updateProcess(created.process.id, {
      numero_processo_licitatorio: '088/2026',
      usar_srp: false
    });
    expect(updatedBundle?.pieces.find((p) => p.agent_number === 8)?.status).toBe('DISPENSADO');
    expect(updatedBundle?.pieces.find((p) => p.agent_number === 1)?.html_content).toContain('088/2026');

    // Reativa SRP e re-executa peça 8/9/10/11 para exportação completa
    updateProcess(created.process.id, { usar_srp: true });
    const finalBundle = getProcessBundle(created.process.id)!;

    // Exportações: PDF Consolidado, DOCX Peça, DOCX Consolidado, ZIP
    const pdfBuf = await generateConsolidatedPdf(finalBundle);
    expect(pdfBuf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    const pdfDoc = await PDFDocument.load(pdfBuf);
    expect(pdfDoc.getPageCount()).toBeGreaterThanOrEqual(3);

    const singleDocx = await exportSinglePieceDocx(finalBundle, 1);
    expect(singleDocx.subarray(0, 2).toString('utf8')).toBe('PK'); // DOCX é um container ZIP

    const fullDocx = await exportConsolidatedDocx(finalBundle);
    expect(fullDocx.subarray(0, 2).toString('utf8')).toBe('PK');

    const zipBuf = await exportDossierZip(finalBundle);
    const zip = await JSZip.loadAsync(zipBuf);
    const fileNames = Object.keys(zip.files);
    expect(fileNames).toContain('00_Dossie_Completo_Consolidado.docx');
    expect(fileNames).toContain('trilha_auditoria.json');
    expect(fileNames.some((f) => f.startsWith('01_'))).toBe(true);
  });

  it('adapta fluxo para Contratação Direta (Dispensa Art. 75) e responde via API HTTP Express', async () => {
    const app = createApp();
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const address = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const healthRes = await fetch(`${baseUrl}/api/health`);
      expect(healthRes.status).toBe(200);
      const health = (await healthRes.json()) as any;
      expect(health.ok).toBe(true);

      const insts = (await (await fetch(`${baseUrl}/api/institutions`)).json()) as any[];
      expect(insts.length).toBeGreaterThan(0);

      const createRes = await fetch(`${baseUrl}/api/processes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          institution_id: insts[0].id,
          numero_processo_licitatorio: '012/2026-DL',
          numero_processo_administrativo: '450/2026',
          titulo_resumido: 'Contratação direta de manutenção emergencial de nobreak central',
          modalidade: 'DISPENSA',
          modo_disputa: 'NAO_APLICAVEL',
          criterio_julgamento: 'MENOR_PRECO',
          formato_lance: 'GLOBAL',
          usar_srp: false,
          valor_estimado_global: 28000,
          demanda_bruta: 'Nobreak principal da data center municipal queimou e exige substituição/manutenção imediata.'
        })
      });
      expect(createRes.status).toBe(201);
      const bundle = (await createRes.json()) as any;
      expect(bundle.pieces.find((p: any) => p.agent_number === 8).status).toBe('DISPENSADO');

      // Executa sequência 1..9 pulando o 8 (dispensado)
      for (const n of [1, 2, 3, 4, 5, 6, 7, 9]) {
        const execRes = await fetch(`${baseUrl}/api/processes/${bundle.process.id}/agents/${n}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        expect(execRes.status).toBe(200);
        const execData = (await execRes.json()) as any;
        if (n === 9) {
          expect(execData.piece.structured_json.tipo_instrumento).toBe('Aviso de Contratação Direta');
          expect(execData.piece.html_content).toContain('AVISO DE CONTRATAÇÃO DIRETA');
        }
      }

      const zipRes = await fetch(`${baseUrl}/api/processes/${bundle.process.id}/export/zip`);
      expect(zipRes.status).toBe(200);
      const zipArrayBuf = await zipRes.arrayBuffer();
      const zip = await JSZip.loadAsync(zipArrayBuf);
      expect(Object.keys(zip.files)).not.toContain('08_minuta_arp.docx');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('extrai Descrição, Medida, Quantidade e Valor de Pesquisa de Preço em Excel (.xlsx), Word (.docx) e PDF (.pdf)', async () => {
    // 1. Planilha Excel (.xlsx)
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Item', 'Descrição do Objeto', 'Medida', 'Quantidade', 'Valor Unitário (R$)', 'Valor Total (R$)'],
      [1, 'Papel Sulfite A4 75g Branco', 'CX', 100, 'R$ 240,50', 'R$ 24.050,00'],
      [2, 'Cartucho de Toner Preto Alto Rendimento', 'UN', 25, 'R$ 180,00', 'R$ 4.500,00']
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Cotacao');
    const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const parsedXlsx = await parsePriceResearchFile(xlsxBuf, 'cotacao_almoxarifado.xlsx');
    expect(parsedXlsx.format).toBe('EXCEL');
    expect(parsedXlsx.itens.length).toBe(2);
    expect(parsedXlsx.itens[0].descricao).toBe('Papel Sulfite A4 75g Branco');
    expect(parsedXlsx.itens[0].medida).toBe('CX');
    expect(parsedXlsx.itens[0].quantidade).toBe(100);
    expect(parsedXlsx.itens[0].valor_unitario).toBe(240.5);
    expect(parsedXlsx.itens[0].valor_total).toBe(24050);
    expect(parsedXlsx.valor_total_estimado).toBe(28550);

    // 2. Documento Word (.docx) com tabela de pesquisa
    const makeCell = (text: string) => new TableCell({ children: [new Paragraph(text)] });
    const docxDoc = new Document({
      sections: [
        {
          children: [
            new Paragraph('PESQUISA DE PREÇOS — PAINEL PNCP'),
            new Table({
              rows: [
                new TableRow({
                  children: [
                    makeCell('Descrição'),
                    makeCell('Unidade de Medida'),
                    makeCell('Qtd'),
                    makeCell('Valor Unitário'),
                    makeCell('Valor Total')
                  ]
                }),
                new TableRow({
                  children: [
                    makeCell('Notebook Corporativo i7 16GB'),
                    makeCell('UN'),
                    makeCell('12'),
                    makeCell('R$ 4.500,00'),
                    makeCell('R$ 54.000,00')
                  ]
                }),
                new TableRow({
                  children: [
                    makeCell('Switch Gerenciável 24 Portas'),
                    makeCell('PC'),
                    makeCell('4'),
                    makeCell('R$ 1.850,00'),
                    makeCell('R$ 7.400,00')
                  ]
                })
              ]
            })
          ]
        }
      ]
    });
    const docxBuf = await Packer.toBuffer(docxDoc);
    const parsedDocx = await parsePriceResearchFile(docxBuf, 'pesquisa_ti.docx');
    expect(parsedDocx.format).toBe('WORD');
    expect(parsedDocx.itens.length).toBe(2);
    expect(parsedDocx.itens[0].descricao).toBe('Notebook Corporativo i7 16GB');
    expect(parsedDocx.itens[0].medida).toBe('UN');
    expect(parsedDocx.itens[0].quantidade).toBe(12);
    expect(parsedDocx.itens[0].valor_unitario).toBe(4500);
    expect(parsedDocx.valor_total_estimado).toBe(61400);

    // 3. Documento PDF (.pdf) com colunas alinhadas em X/Y
    const pdfBuf = await new Promise<Buffer>((resolve, reject) => {
      const pdfDoc = new PDFKitDocument({ size: 'A4', margin: 40 });
      const chunks: Buffer[] = [];
      pdfDoc.on('data', (c: Buffer) => chunks.push(c));
      pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
      pdfDoc.on('error', reject);

      pdfDoc.fontSize(11).text('PESQUISA DE PREÇO - COMBUSTÍVEIS', 40, 40, { lineBreak: false });
      pdfDoc.fontSize(9);
      const drawRow = (y: number, cols: [string, string, string, string, string]) => {
        pdfDoc.text(cols[0], 40, y, { lineBreak: false });
        pdfDoc.text(cols[1], 260, y, { lineBreak: false });
        pdfDoc.text(cols[2], 320, y, { lineBreak: false });
        pdfDoc.text(cols[3], 390, y, { lineBreak: false });
        pdfDoc.text(cols[4], 470, y, { lineBreak: false });
      };
      drawRow(80, ['Descrição', 'Medida', 'Qtd', 'Valor Unitário', 'Valor Total']);
      drawRow(105, ['Combustível Óleo Diesel S10', 'L', '10.000', 'R$ 5,89', 'R$ 58.900,00']);
      drawRow(130, ['Agente Redutor Arla 32', 'GL', '200', 'R$ 95,00', 'R$ 19.000,00']);
      pdfDoc.end();
    });

    const parsedPdf = await parsePriceResearchFile(pdfBuf, 'pesquisa_combustivel.pdf');
    expect(parsedPdf.format).toBe('PDF');
    expect(parsedPdf.itens.length).toBeGreaterThanOrEqual(2);
    expect(parsedPdf.itens[0].descricao).toContain('Diesel S10');
    expect(parsedPdf.itens[0].medida).toBe('L');
    expect(parsedPdf.itens[0].quantidade).toBe(10000);
    expect(parsedPdf.itens[0].valor_unitario).toBe(5.89);
    expect(parsedPdf.itens[0].valor_total).toBe(58900);
  });

  it('recebe upload de Pesquisa de Preço, elabora todas as peças (01–11) conforme campos e modalidade e gera Word (.docx) de cada peça', async () => {
    const app = createApp();
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const address = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const insts = (await (await fetch(`${baseUrl}/api/institutions`)).json()) as any[];

      // Cria planilha real de pesquisa de preço
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([
        ['Item', 'Descrição', 'Medida', 'Quantidade', 'Valor Unitário', 'Valor Total'],
        [1, 'Luva de Procedimento Látex M', 'CX', 300, '38,50', '11.550,00'],
        [2, 'Máscara Cirúrgica Tripla Descartável', 'PCT', 400, '18,00', '7.200,00']
      ]);
      XLSX.utils.book_append_sheet(wb, ws, 'Pesquisa');
      const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

      const fd = new FormData();
      fd.append(
        'file',
        new Blob([new Uint8Array(xlsxBuf)], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        }),
        'pesquisa_epis_2026.xlsx'
      );

      const parseRes = await fetch(`${baseUrl}/api/price-research/parse`, {
        method: 'POST',
        body: fd
      });
      expect(parseRes.status).toBe(200);
      const parsed = (await parseRes.json()) as any;
      expect(parsed.itens.length).toBe(2);
      expect(parsed.valor_total_estimado).toBe(18750);

      // Cria processo em Pregão Presencial + SRP usando os itens extraídos
      const createRes = await fetch(`${baseUrl}/api/processes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          institution_id: insts[0].id,
          numero_processo_licitatorio: '099/2026',
          numero_processo_administrativo: '2.450/2026',
          titulo_resumido: 'Aquisição de EPIs Hospitalares para Atenção Básica',
          modalidade: 'PREGAO_PRESENCIAL',
          modo_disputa: 'ABERTO',
          criterio_julgamento: 'MENOR_PRECO',
          formato_lance: 'POR_ITEM',
          usar_srp: true,
          responsavel_requisitante: 'Dra. Helena Campos',
          cargo_requisitante: 'Coordenadora de Suprimentos Médicos',
          valor_estimado_global: parsed.valor_total_estimado,
          pesquisa_preco_arquivo: parsed.filename,
          pesquisa_preco_resumo: parsed.resumo_texto,
          pesquisa_preco_itens: parsed.itens,
          demanda_bruta: 'Suprimento contínuo de luvas e máscaras para as unidades de saúde.'
        })
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as any;

      // Elabora todas as peças 01 a 11 com os agentes
      const batchRes = await fetch(`${baseUrl}/api/processes/${created.process.id}/agents/execute-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actorName: 'Dra. Helena Campos' })
      });
      expect(batchRes.status).toBe(200);
      const batchData = (await batchRes.json()) as any;
      expect(batchData.executed_agents).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

      const pieceMap = new Map<number, any>(
        batchData.bundle.pieces.map((p: any) => [p.agent_number, p])
      );
      for (const num of [1, 3, 5, 8, 9]) {
        const html = pieceMap.get(num)?.html_content || '';
        expect(html).toContain('Luva de Procedimento Látex M');
        expect(html).toContain('CX');
        expect(html).toContain('Máscara Cirúrgica Tripla Descartável');
        expect(html).toContain('PCT');
      }
      expect(pieceMap.get(9)?.html_content).toContain('Local da Sessão Pública Presencial');
      expect(pieceMap.get(9)?.html_content).toContain('Sessão pública PRESENCIAL');
      expect(pieceMap.get(1)?.html_content).toContain('áudio e vídeo');

      // Verifica exportação individual em Word (.docx) de múltiplas peças + Dossiê Consolidado + ZIP
      for (const num of [1, 5, 9]) {
        const docxRes = await fetch(`${baseUrl}/api/processes/${created.process.id}/export/docx/${num}`);
        expect(docxRes.status).toBe(200);
        const ab = await docxRes.arrayBuffer();
        const bytes = new Uint8Array(ab);
        expect(bytes[0]).toBe(0x50);
        expect(bytes[1]).toBe(0x4b);
        const docxZip = await JSZip.loadAsync(ab);
        const docXml = await docxZip.file('word/document.xml')!.async('string');
        expect(docXml).toContain('Luva de Procedimento');
        expect(docXml).toContain('CX');
        expect(docXml).toContain('Pregão Presencial');
      }

      const zipRes = await fetch(`${baseUrl}/api/processes/${created.process.id}/export/zip`);
      expect(zipRes.status).toBe(200);
      const zip = await JSZip.loadAsync(await zipRes.arrayBuffer());
      const names = Object.keys(zip.files);
      expect(names).toContain('00_Dossie_Completo_Consolidado.docx');
      for (let i = 1; i <= 11; i++) {
        const prefix = `${String(i).padStart(2, '0')}_`;
        expect(names.some((n) => n.startsWith(prefix) && n.endsWith('.docx'))).toBe(true);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('detecta credenciais Gemini automaticamente (env, Google ADC OAuth2 e Service Account) sem exigir token manual na UI', async () => {
    const savedEnv = {
      AI_PROVIDER: process.env.AI_PROVIDER,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      APPDATA: process.env.APPDATA,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'govflow-adc-'));
    const emptyConfigRoot = path.join(tmpDir, 'empty-config');
    fs.mkdirSync(emptyConfigRoot, { recursive: true });

    const restoreEnv = () => {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      clearGeminiAuthCache();
    };

    const app = createApp();
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const address = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${address.port}`;

      delete process.env.AI_PROVIDER;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      process.env.APPDATA = emptyConfigRoot;
      process.env.XDG_CONFIG_HOME = emptyConfigRoot;
      getDb().prepare("DELETE FROM app_settings WHERE key IN ('ai_provider', 'gemini_api_key')").run();

      // 1. Sem credenciais: modo padrão 'auto' entra em fallback seguro local
      const defaultRes = await fetch(`${baseUrl}/api/settings/ai`);
      expect(defaultRes.status).toBe(200);
      const defaultJson = (await defaultRes.json()) as any;
      expect(defaultJson.provider).toBe('auto');
      expect(defaultJson.effectiveProvider).toBe('local');
      expect(defaultJson.authSource).toBe('none');
      expect(defaultJson.hasGeminiKey).toBe(false);

      // Endpoint POST /api/settings/ai/test sem token
      const testLocalRes = await fetch(`${baseUrl}/api/settings/ai/test`, { method: 'POST' });
      expect(testLocalRes.status).toBe(200);
      const testLocalJson = (await testLocalRes.json()) as any;
      expect(testLocalJson.ok).toBe(true);
      expect(testLocalJson.effectiveProvider).toBe('local');
      expect(testLocalJson.authSource).toBe('none');
      expect(testLocalJson.authSourceLabel).toBeTruthy();

      // 2. Detecção automática via GOOGLE_API_KEY sem PUT na UI
      process.env.GOOGLE_API_KEY = 'auto-google-key-sample';
      const googleEnvRes = (await (await fetch(`${baseUrl}/api/settings/ai`)).json()) as any;
      expect(googleEnvRes.provider).toBe('auto');
      expect(googleEnvRes.effectiveProvider).toBe('gemini');
      expect(googleEnvRes.authSource).toBe('env_google_key');
      expect(googleEnvRes.hasGeminiKey).toBe(true);

      // 3. Prioridade GEMINI_API_KEY sobre GOOGLE_API_KEY
      process.env.GEMINI_API_KEY = 'auto-gemini-key-sample';
      const geminiEnvRes = (await (await fetch(`${baseUrl}/api/settings/ai`)).json()) as any;
      expect(geminiEnvRes.effectiveProvider).toBe('gemini');
      expect(geminiEnvRes.authSource).toBe('env_gemini_key');

      // 4. Detecção via Google ADC authorized_user
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      const authUserPath = path.join(tmpDir, 'adc_authorized_user.json');
      fs.writeFileSync(
        authUserPath,
        JSON.stringify({
          type: 'authorized_user',
          client_id: 'test-client.apps.googleusercontent.com',
          client_secret: 'test-secret',
          refresh_token: '1//test-refresh-token',
          quota_project_id: 'govflow-quota-proj'
        })
      );
      process.env.GOOGLE_APPLICATION_CREDENTIALS = authUserPath;

      const adcUserRes = (await (await fetch(`${baseUrl}/api/settings/ai`)).json()) as any;
      expect(adcUserRes.effectiveProvider).toBe('gemini');
      expect(adcUserRes.authSource).toBe('adc_authorized_user');
      expect(adcUserRes.hasGeminiKey).toBe(true);

      const resolvedUser = resolveGeminiCredential('');
      const userAuthHeaders = await getGeminiAuthHeadersAndUrl(
        resolvedUser,
        'gemini-2.5-flash',
        (async () =>
          new Response(JSON.stringify({ access_token: 'mock-oauth-token', expires_in: 3600 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })) as typeof fetch
      );
      expect(userAuthHeaders.headers.Authorization).toBe('Bearer mock-oauth-token');
      expect(userAuthHeaders.headers['x-goog-user-project']).toBe('govflow-quota-proj');

      // 5. Detecção via Google ADC service_account + assinatura RS256 JWT
      const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' }
      });
      const saPath = path.join(tmpDir, 'adc_service_account.json');
      fs.writeFileSync(
        saPath,
        JSON.stringify({
          type: 'service_account',
          project_id: 'govflow-sa-proj',
          client_email: 'govflow-bot@govflow-sa-proj.iam.gserviceaccount.com',
          private_key: privateKey,
          token_uri: 'https://oauth2.googleapis.com/token'
        })
      );
      clearGeminiAuthCache();
      process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;

      const adcSaRes = (await (await fetch(`${baseUrl}/api/settings/ai`)).json()) as any;
      expect(adcSaRes.effectiveProvider).toBe('gemini');
      expect(adcSaRes.authSource).toBe('adc_service_account');

      const resolvedSa = resolveGeminiCredential('');
      expect(resolvedSa.adcInfo?.type).toBe('service_account');
      if (resolvedSa.adcInfo?.type === 'service_account') {
        const jwt = createServiceAccountJwtAssertion(resolvedSa.adcInfo);
        expect(jwt.split('.').length).toBe(3);
      }
      const saAuthHeaders = await getGeminiAuthHeadersAndUrl(
        resolvedSa,
        'gemini-2.5-flash',
        (async () =>
          new Response(JSON.stringify({ access_token: 'mock-sa-token', expires_in: 3600 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })) as typeof fetch
      );
      expect(saAuthHeaders.headers.Authorization).toBe('Bearer mock-sa-token');
      expect(saAuthHeaders.headers['x-goog-user-project']).toBe('govflow-sa-proj');
    } finally {
      restoreEnv();
      getDb().prepare("DELETE FROM app_settings WHERE key IN ('ai_provider', 'gemini_api_key')").run();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('suporta Tipo da Contratação (Aquisição/Obras/Serviços) e múltiplas Dotações Orçamentárias (selecionadas + manuais)', async () => {
    const app = createApp();
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const address = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const insts = (await (await fetch(`${baseUrl}/api/institutions`)).json()) as any[];
      const instDetail = (await (
        await fetch(`${baseUrl}/api/institutions/${insts[0].id}`)
      ).json()) as any;
      const dots = instDetail.dotacoes as any[];
      expect(dots.length).toBeGreaterThanOrEqual(2);

      // 1. Cria processo classificado explicitamente como SERVICOS com múltiplas dotações (2 cadastradas + 1 manual)
      const manualEntry = '02.09.01 - Fundo Municipal de Transporte | 3.3.90.39.19 | Fonte 1.500.000 [Red. 905]';
      const createRes = await fetch(`${baseUrl}/api/processes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          institution_id: insts[0].id,
          numero_processo_licitatorio: '120/2026',
          numero_processo_administrativo: '3.100/2026',
          titulo_resumido: 'Serviços contínuos de lavagem e higienização de veículos oficiais',
          tipo_contratacao: 'SERVICOS',
          data_certame: '2026-12-10',
          horario_disputa: '09:30',
          modalidade: 'PREGAO_ELETRONICO',
          modo_disputa: 'ABERTO',
          criterio_julgamento: 'MENOR_PRECO',
          formato_lance: 'POR_ITEM',
          usar_srp: false,
          dotacao_ids: [dots[0].id, dots[1].id],
          dotacoes_manuais: [manualEntry],
          valor_estimado_global: 145000,
          demanda_bruta: 'Necessidade contínua de lavagem preventiva e higienização interna da frota leve e pesada.'
        })
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as any;
      expect(created.process.tipo_contratacao).toBe('SERVICOS');
      expect(created.process.data_certame).toBe('2026-12-10');
      expect(created.process.horario_disputa).toBe('09:30');
      expect(created.process.dotacao_ids).toEqual([dots[0].id, dots[1].id]);
      expect(created.process.dotacoes_manuais).toEqual([manualEntry]);
      expect(created.dotacoes_vinculadas.length).toBe(2);
      expect(
        created.validation_alerts.some((a: any) => a.id === 'missing-dotacao')
      ).toBe(false);

      // 2. Elabora agentes 01–05: como Tipo = SERVICOS, deve enquadrar como CATSER/Serviços (e não aquisição de veículo)
      const batchRes = await fetch(
        `${baseUrl}/api/processes/${created.process.id}/agents/execute-all`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ actorName: 'Equipe Planejamento' })
        }
      );
      expect(batchRes.status).toBe(200);
      const batch = (await batchRes.json()) as any;
      const p1 = batch.bundle.pieces.find((p: any) => p.agent_number === 1);
      const p5 = batch.bundle.pieces.find((p: any) => p.agent_number === 5);

      expect(p1.html_content).toContain('Serviços (Gerais / Continuados / Terceirização)');
      expect(p1.html_content).toContain(dots[0].elemento_despesa);
      expect(p1.html_content).toContain(dots[1].elemento_despesa);
      expect(p1.html_content).toContain(manualEntry);

      expect(p5.structured_json.codigo_catalogo_tipo).toBe('CATSER');
      expect(p5.html_content).toContain('Serviços (Gerais / Continuados / Terceirização)');
      expect(p5.html_content).toContain(manualEntry);

      // 3. Atualiza para OBRAS_ENGENHARIA apenas com dotação manual e verifica enquadramento técnico + exportação DOCX
      const updRes = await fetch(`${baseUrl}/api/processes/${created.process.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tipo_contratacao: 'OBRAS_ENGENHARIA',
          dotacao_ids: [],
          dotacoes_manuais: ['02.07.01 - Sec. Obras | 4.4.90.51.00 | Fonte 1.700 [Red. 777]']
        })
      });
      expect(updRes.status).toBe(200);
      const updatedBundle = (await updRes.json()) as any;
      expect(updatedBundle.process.tipo_contratacao).toBe('OBRAS_ENGENHARIA');
      expect(updatedBundle.validation_alerts.some((a: any) => a.id === 'missing-dotacao')).toBe(false);

      const ag5Res = await fetch(`${baseUrl}/api/processes/${created.process.id}/agents/5/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(ag5Res.status).toBe(200);
      const ag5Data = (await ag5Res.json()) as any;
      expect(ag5Data.piece.html_content).toContain('Obras e Engenharia');
      expect(ag5Data.piece.html_content).toContain('CREA/CAU');
      expect(ag5Data.piece.html_content).toContain('02.07.01 - Sec. Obras | 4.4.90.51.00 | Fonte 1.700 [Red. 777]');

      const ag6Res = await fetch(`${baseUrl}/api/processes/${created.process.id}/agents/6/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(ag6Res.status).toBe(200);
      const ag6Data = (await ag6Res.json()) as any;
      expect(ag6Data.piece.html_content).toContain('10/12/2026 às 09h30');

      const ag9Res = await fetch(`${baseUrl}/api/processes/${created.process.id}/agents/9/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(ag9Res.status).toBe(200);
      const ag9Data = (await ag9Res.json()) as any;
      expect(ag9Data.piece.html_content).toContain('10/12/2026 às 09h30');

      const docxRes = await fetch(`${baseUrl}/api/processes/${created.process.id}/export/docx`);
      expect(docxRes.status).toBe(200);
      const docxZip = await JSZip.loadAsync(await docxRes.arrayBuffer());
      const docXml = await docxZip.file('word/document.xml')!.async('string');
      expect(docXml).toContain('Obras e Engenharia');
      expect(docXml).toContain('10/12/2026 às 09h30');
      expect(docXml).toContain('02.07.01 - Sec. Obras | 4.4.90.51.00 | Fonte 1.700 [Red. 777]');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('valida Agente 07 (Prefeito exclusivo + valores/duração abertos), TCU no Agente 10, UTF-8/Arial DOCX+PDF e Modo Teste Online', async () => {
    const app = createApp();
    const server = await new Promise<import('node:http').Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });

    try {
      const port = (server.address() as any).port;
      const baseUrl = `http://127.0.0.1:${port}`;

      // 1. Verifica status Modo Teste Online e alternância persistida
      const statusRes = await fetch(`${baseUrl}/api/platform/online-status`);
      expect(statusRes.status).toBe(200);
      const onlineStatus = (await statusRes.json()) as any;
      expect(onlineStatus.online).toBe(true);
      expect(onlineStatus.test_mode).toBe(true);
      expect(onlineStatus.database_ok).toBe(true);

      // 2. Consulta base curada de jurisprudência TCU
      const tcuSearchRes = await fetch(`${baseUrl}/api/tcu/acordaos?q=marca`);
      expect(tcuSearchRes.status).toBe(200);
      const tcuSearch = (await tcuSearchRes.json()) as any;
      expect(tcuSearch.items.length).toBeGreaterThan(0);
      expect(tcuSearch.items.some((it: any) => it.numero.includes('1.264/2019'))).toBe(true);

      // 3. Executa Sandbox 01-11 via rota oficial de Modo Teste Online
      const sandboxRes = await fetch(`${baseUrl}/api/platform/sandbox-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoRunAll: true })
      });
      expect(sandboxRes.status).toBe(201);
      const sandbox = (await sandboxRes.json()) as any;
      expect(sandbox.created_sandbox).toBe(true);
      const bundle = sandbox.bundle;
      const inst = bundle.institution;
      const sec = bundle.secretario;

      const ag7 = bundle.pieces.find((p: any) => p.agent_number === 7);
      const ag10 = bundle.pieces.find((p: any) => p.agent_number === 10);
      expect(ag7).toBeTruthy();
      expect(ag10).toBeTruthy();

      // Agente 07: Preâmbulo/Assinatura EXCLUSIVO do Prefeito + Valores/Duração em aberto
      expect(ag7.structured_json.representante_contratante).toBe(inst.prefeito_nome);
      expect(ag7.structured_json.ordenador_signatario).toBeUndefined();
      expect(ag7.structured_json.valores_em_aberto).toBe(true);
      expect(ag7.structured_json.duracao_em_aberto).toBe(true);
      expect(ag7.html_content).toContain(`Prefeito(a) Municipal`);
      expect(ag7.html_content).toContain(inst.prefeito_nome);
      if (sec?.nome && sec.nome !== inst.prefeito_nome) {
        expect(ag7.html_content).not.toContain(sec.nome);
      }
      expect(ag7.html_content).toContain('[VALOR CONTRATUAL EM ABERTO');
      expect(ag7.html_content).toContain('[DURAÇÃO CONTRATUAL EM ABERTO');
      expect(ag7.html_content).toContain('[PRAZO DE EXECUÇÃO EM ABERTO');
      expect(ag7.html_content).toContain('R$ [__________]');

      // Agente 10: Ementa Jurídica, doutrina STF/LINDB, TCU vinculado e Matriz 4.4
      expect(ag10.html_content).toContain('Ementa Jurídica');
      expect(ag10.html_content).toContain('STF MS nº 24.631');
      expect(ag10.html_content).toContain('LINDB Art. 28');
      expect(ag10.html_content).toContain('4.4. Matriz de Jurisprudência Aplicável do TCU');
      expect(ag10.html_content).toContain('1.875/2021');
      expect(ag10.html_content).toContain('1.264/2019');

      // Vincular um acórdão extra ao processo marca Agente 10 como DESATUALIZADO e inclui na regeneração
      const extraPrecedent = {
        id: 'tcu-custom-test-999',
        numero: 'Acórdão nº 2.999/2025-TCU-Plenário',
        tipo: 'ACORDAO',
        colegiado: 'Plenário TCU',
        tema: 'CONTROLE_PREVIO_ART53',
        tema_label: 'Controle Prévio & Parecer Jurídico (Art. 53)',
        artigos_relacionados: 'Art. 53 da Lei nº 14.133/2021',
        ementa: 'Controle jurídico preventivo deve auditar cláusulas contratuais e orçamentação.',
        aplicacao_pratica: 'Aplicação direta em pareceres referenciais.',
        fonte: 'BASE_CURADA_TCU'
      };
      const pinRes = await fetch(`${baseUrl}/api/processes/${bundle.process.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tcu_acordaos_vinculados: [...bundle.process.tcu_acordaos_vinculados, extraPrecedent]
        })
      });
      expect(pinRes.status).toBe(200);
      const afterPin = (await pinRes.json()) as any;
      expect(afterPin.pieces.find((p: any) => p.agent_number === 10).status).toBe('DESATUALIZADO');

      const regen10Res = await fetch(`${baseUrl}/api/processes/${bundle.process.id}/agents/10/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actorName: 'Procurador Teste' })
      });
      expect(regen10Res.status).toBe(200);
      const regen10 = (await regen10Res.json()) as any;
      expect(regen10.piece.html_content).toContain('Acórdão nº 2.999/2025-TCU-Plenário');

      // 4. Tipografia Canônica (Arial + pt-BR) e Preservação UTF-8 em DOCX e PDF
      const docx10Res = await fetch(`${baseUrl}/api/processes/${bundle.process.id}/export/docx/10`);
      expect(docx10Res.status).toBe(200);
      const docx10Zip = await JSZip.loadAsync(await docx10Res.arrayBuffer());
      const doc10Xml = await docx10Zip.file('word/document.xml')!.async('string');
      const stylesXml = await docx10Zip.file('word/styles.xml')!.async('string');

      expect(stylesXml).toContain('Arial');
      expect(stylesXml).toContain('pt-BR');
      expect(doc10Xml).not.toContain('Calibri');
      expect(doc10Xml).toContain('§');
      expect(doc10Xml).toContain('nº');
      expect(doc10Xml).toContain('Contratações');
      expect(doc10Xml).not.toContain('\uFFFD');
      expect(doc10Xml).not.toContain('Ã§');

      const pdfRes = await fetch(`${baseUrl}/api/processes/${bundle.process.id}/export/pdf`);
      expect(pdfRes.status).toBe(200);
      const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
      expect(pdfBuf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(pdfBuf.length).toBeGreaterThan(2000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('Inteligência Artificial Aprimorada: Curva ABC, LegalAlert schema, Blindagem JSON/Prefeito e Estrutura Editorial Limpa', async () => {
    // 1. Curva ABC / Pareto e amplitude de preços unitários
    const analytics = analyzePricePortfolio([
      { item: '01', descricao: 'Servidor Rack Enterprise', medida: 'UN', quantidade: 2, valor_unitario: 42000, valor_total: 84000 },
      { item: '02', descricao: 'Switch Gerenciável L3', medida: 'UN', quantidade: 4, valor_unitario: 3000, valor_total: 12000 },
      { item: '03', descricao: 'Cabo Patch Cord Cat6', medida: 'CX', quantidade: 10, valor_unitario: 400, valor_total: 4000 }
    ]);
    expect(analytics.itemCount).toBe(3);
    expect(analytics.effectiveTotal).toBe(100000);
    expect(analytics.classeACount).toBe(1);
    expect(analytics.classeACumulativePct).toBeCloseTo(84.0, 1);
    expect(analytics.dispersionRatio).toBe(105);
    expect(analytics.summaryText).toContain('Curva ABC (Pareto)');
    expect(analytics.summaryText).toContain('84.0%');

    // 2. Normalização completa de LegalAlert e limpeza de cercas HTML no llmClient
    const parsedLlm = parseJsonPayload(
      JSON.stringify({
        structured_json: { objeto_tecnico: 'Teste' },
        html_content: '```html\n<h2>Título</h2><blockquote class="exec-summary">Resumo</blockquote>\n```',
        legal_alerts: [
          {
            level: 'warning',
            article: 'Art. 40, § 2º',
            message: 'Concentração de 84% em único item exige justificativa técnica.'
          }
        ]
      }),
      'Gemini Mock'
    );
    expect(parsedLlm).not.toBeNull();
    expect(parsedLlm!.html_content).toContain('<div class="gov-doc">');
    expect(parsedLlm!.html_content).not.toContain('```html');
    expect(parsedLlm!.legal_alerts[0]).toMatchObject({
      id: 'llm-alert-1',
      severity: 'warning',
      article: 'Art. 40, § 2º',
      title: 'Ponto de Atenção — Art. 40, § 2º'
    });

    // 3. Blindagem de invariantes no mergeStructuredJson (Agente 07 & 10) e deduplicação de alertas
    const merged07 = mergeStructuredJson(
      7,
      {
        representante_contratante: 'Tadeu Barreto',
        valores_em_aberto: true,
        duracao_em_aberto: true,
        clausulas_minuta: ['C1', 'C2']
      },
      {
        representante_contratante: 'Secretário Alucinado',
        ordenador_signatario: 'Secretário',
        valores_em_aberto: false,
        clausulas_minuta: []
      }
    );
    expect(merged07.representante_contratante).toBe('Tadeu Barreto');
    expect(merged07.valores_em_aberto).toBe(true);
    expect(merged07.duracao_em_aberto).toBe(true);
    expect(merged07.ordenador_signatario).toBeUndefined();
    expect(merged07.clausulas_minuta).toEqual(['C1', 'C2']);

    const mergedAlerts = mergeLegalAlerts(
      [
        {
          id: 'llm-1',
          severity: 'warning',
          article: 'Art. 23',
          title: 'Concentração Classe A',
          message: 'Item 01 concentra 84% do valor estimado.'
        }
      ],
      [
        {
          id: 'loc-1',
          severity: 'warning',
          article: 'Art. 23',
          title: 'Concentração Classe A',
          message: 'Item 01 concentra 84% do valor estimado.'
        },
        {
          id: 'loc-2',
          severity: 'info',
          article: 'Art. 92',
          title: 'Preâmbulo Exclusivo',
          message: 'Prefeito Municipal qualificado exclusivamente.'
        }
      ]
    );
    expect(mergedAlerts.length).toBe(2);

    // 4. Deduplicação de titulação genérica do Prefeito Municipal em peças 07, 08 e 11
    const genericPref = formatPrefeitoRoleAndName('Prefeito(a) Municipal');
    expect(genericPref.isGenericPlaceholder).toBe(true);
    expect(genericPref.qualifiedTitle).toBe('Prefeito(a) Municipal');

    const namedPref = formatPrefeitoRoleAndName('Tadeu Barreto');
    expect(namedPref.isGenericPlaceholder).toBe(false);
    expect(namedPref.qualifiedTitle).toBe('Prefeito(a) Municipal Tadeu Barreto');

    const instList = listInstitutions();
    const baseInst = instList[0];
    upsertInstitution({
      ...baseInst,
      prefeito_nome: 'Prefeito(a) Municipal'
    });

    try {
      const cleanProc = createProcess({
        institution_id: baseInst.id,
        titulo_resumido: 'Aquisição de Equipamentos de TI com Curva ABC',
        demanda_bruta: 'Modernização da rede municipal com servidores e switches.',
        tipo_contratacao: 'AQUISICAO',
        modalidade: 'PREGAO_ELETRONICO',
        modo_disputa: 'ABERTO',
        criterio_julgamento: 'MENOR_PRECO',
        formato_lance: 'POR_ITEM',
        usar_srp: true,
        pesquisa_preco_itens: [
          { item: 1, descricao: 'Servidor Rack Enterprise', medida: 'UN', quantidade: 2, valor_unitario: 42000, valor_total: 84000 },
          { item: 2, descricao: 'Switch Gerenciável L3', medida: 'UN', quantidade: 4, valor_unitario: 3000, valor_total: 12000 }
        ],
        valor_estimado_global: 96000,
        responsavel_requisitante: 'Analista TI',
        cargo_requisitante: 'Coordenador'
      });

      const pieces = [];
      for (let i = 1; i <= 11; i++) {
        const piece = await executeAgentStep({ processId: cleanProc.process.id, agentNumber: i });
        pieces.push(piece);
        approveAndSignPiece({
          processId: cleanProc.process.id,
          agentNumber: i,
          actorName: 'Auditor QA',
          actorRole: 'Secretário Municipal'
        });
      }

      for (const p of pieces) {
        expect(p.html_content).toContain('<blockquote class="exec-summary">');
        expect(p.html_content).not.toContain('Prefeito(a) Municipal <strong>Prefeito(a) Municipal</strong>');
        expect(p.html_content).not.toContain('Prefeito(a) <strong>Prefeito(a) Municipal</strong>');
        expect(p.html_content).not.toContain('Prefeito(a) Municipal Prefeito(a) Municipal');
      }

      const p1 = pieces.find((p) => p.agent_number === 1)!;
      const p7 = pieces.find((p) => p.agent_number === 7)!;
      const p10 = pieces.find((p) => p.agent_number === 10)!;
      expect(p1.html_content).toContain('table class="meta-table"');
      expect(p1.html_content).toContain('Curva ABC (Pareto)');
      expect(p7.html_content).toContain('table class="meta-table"');
      expect(p10.html_content).toContain('table class="meta-table"');
      expect(p10.html_content).toContain('Curva ABC');

      // Exportação DOCX preserva blockquote e Ficha Técnica sem erros
      const finalCleanBundle = getProcessBundle(cleanProc.process.id)!;
      const docx7Buf = await exportSinglePieceDocx(finalCleanBundle, 7);
      const docx7Zip = await JSZip.loadAsync(docx7Buf);
      const docx7Xml = await docx7Zip.file('word/document.xml')!.async('string');
      expect(docx7Xml).toContain('Diretrizes Contratuais e Blindagem Jurídica');
      expect(docx7Xml).not.toContain('Prefeito(a) Municipal Prefeito(a) Municipal');
    } finally {
      upsertInstitution({
        ...baseInst,
        prefeito_nome: baseInst.prefeito_nome
      });
    }
  });

  it('rejeita chaves Gemini mascaradas/inválidas, detalha erros HTTP/OAuth2 e executa reset limpo de credenciais', async () => {
    const savedEnv: Record<string, string | undefined> = {
      AI_PROVIDER: process.env.AI_PROVIDER,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      APPDATA: process.env.APPDATA,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME
    };
    const emptyCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'govflow-reset-cfg-'));
    const app = createApp();
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const address = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${address.port}`;

      delete process.env.AI_PROVIDER;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      process.env.APPDATA = emptyCfg;
      process.env.XDG_CONFIG_HOME = emptyCfg;
      getDb().prepare("DELETE FROM app_settings WHERE key IN ('ai_provider', 'gemini_api_key')").run();
      clearGeminiAuthCache();

      // Sanitização e validação de chaves mascaradas/entre aspas
      expect(sanitizeGeminiApiKey('••••••••••••••••••••••')).toBe('');
      expect(sanitizeGeminiApiKey('"AIzaSyDummyValidKeyForUnitTest123"')).toBe('AIzaSyDummyValidKeyForUnitTest123');
      expect(validateManualGeminiApiKey('••••••••••••••••••••••').ok).toBe(false);

      // PUT com caracteres mascarados deve falhar com HTTP 400 sem sujar o banco
      const badPut = await fetch(`${baseUrl}/api/settings/ai`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'gemini', geminiApiKey: '••••••••••••••••••••••' })
      });
      expect(badPut.status).toBe(400);

      // Diagnóstico detalhado de erros da API Gemini sem expor segredos
      const fakeDbRes = resolveGeminiCredential('AIzaSyDummyValidKeyForUnitTest123');
      const diag400 = diagnoseGeminiApiHttpError(
        400,
        JSON.stringify({
          error: {
            code: 400,
            message: 'API key not valid. Please pass a valid API key.',
            details: [{ reason: 'API_KEY_INVALID' }]
          }
        }),
        fakeDbRes,
        'gemini-2.5-flash'
      );
      expect(diag400.errorCode).toBe('API_KEY_INVALID');
      expect(diag400.message).not.toContain('AIzaSyDummyValidKeyForUnitTest123');

      // Erro OAuth2 estruturado em exchangeAdcAccessToken
      const adcRes = {
        source: 'adc_authorized_user' as const,
        sourceLabel: 'ADC Teste',
        hasCredential: true,
        adcInfo: {
          type: 'authorized_user' as const,
          client_id: 'cid',
          client_secret: 'csec',
          refresh_token: '1//revoked-token'
        }
      };
      await expect(
        getGeminiAuthHeadersAndUrl(
          adcRes,
          'gemini-2.5-flash',
          (async () =>
            new Response(
              JSON.stringify({
                error: 'invalid_grant',
                error_description: 'Token has been expired or revoked.'
              }),
              { status: 400, headers: { 'Content-Type': 'application/json' } }
            )) as typeof fetch
        )
      ).rejects.toThrow(/invalid_grant.*expired or revoked/i);

      // Simula chave antiga salva no SQLite e executa POST /api/settings/ai/gemini/reset
      const putValidShape = await fetch(`${baseUrl}/api/settings/ai`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'gemini', geminiApiKey: 'AIzaSyDummyValidKeyForUnitTest123' })
      });
      expect(putValidShape.status).toBe(200);
      const beforeReset = (await putValidShape.json()) as any;
      expect(beforeReset.authSource).toBe('db_api_key');

      const resetRes = await fetch(`${baseUrl}/api/settings/ai/gemini/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setAutoProvider: true })
      });
      expect(resetRes.status).toBe(200);
      const resetJson = (await resetRes.json()) as any;
      expect(resetJson.clearedDbKey).toBe(true);
      expect(resetJson.settings.provider).toBe('auto');
      expect(resetJson.settings.authSource).toBe('none');
      expect(resetJson.settings.effectiveProvider).toBe('local');
      expect(resetJson.diagnostic.ok).toBe(true);

      // Modelo padrão Gemini 4 Hydrogen + normalização de alias + generationConfig Gemini 4
      expect(DEFAULT_GEMINI_MODEL).toBe('gemini-4-hydrogen');
      expect(normalizeGeminiModelName('4 hydrogen')).toBe('gemini-4-hydrogen');
      expect(normalizeGeminiModelName('models/gemini-4-hydrogen')).toBe('gemini-4-hydrogen');
      const g4Cfg = buildGeminiGenerationConfig('gemini-4-hydrogen');
      expect(g4Cfg.maxOutputTokens).toBe(32768);
      expect(g4Cfg.thinkingConfig?.thinkingLevel).toBe('MEDIUM');
      expect(g4Cfg.temperature).toBeUndefined();

      const putModelRes = await fetch(`${baseUrl}/api/settings/ai`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'gemini',
          geminiModel: '4 hydrogen',
          geminiApiKey: 'AIzaSyDummyValidKeyForUnitTest123'
        })
      });
      expect(putModelRes.status).toBe(200);
      const putModelJson = (await putModelRes.json()) as any;
      expect(putModelJson.geminiModel).toBe('gemini-4-hydrogen');

      let capturedUrl = '';
      let capturedBody: any = null;
      const llmOut = await tryGenerateWithLlm(
        {
          agentNumber: 1,
          agentTitle: 'Teste Gemini 4 Hydrogen',
          legalBasis: 'Art. 18',
          systemPrompt: 'Especialista 14.133',
          userPrompt: 'Analise a demanda.'
        },
        (async (input: RequestInfo | URL, init?: RequestInit) => {
          capturedUrl = String(input);
          capturedBody = JSON.parse(String(init?.body || '{}'));
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      { thought: true, text: 'Raciocínio interno que não deve ir para JSON.parse' },
                      {
                        text: JSON.stringify({
                          structured_json: { objeto: 'Teste Gemini 4 Hydrogen' },
                          html_content: '<div class="gov-doc"><h2>Teste Gemini 4 Hydrogen</h2></div>',
                          legal_alerts: []
                        })
                      }
                    ]
                  }
                }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }) as typeof fetch
      );
      expect(capturedUrl).toContain('/models/gemini-4-hydrogen:generateContent');
      expect(capturedBody?.generationConfig?.thinkingConfig?.thinkingLevel).toBe('MEDIUM');
      expect(capturedBody?.generationConfig?.maxOutputTokens).toBe(32768);
      expect(capturedBody?.generationConfig?.temperature).toBeUndefined();
      expect(llmOut?.providerLabel).toContain('gemini-4-hydrogen');
      expect(llmOut?.structured_json?.objeto).toBe('Teste Gemini 4 Hydrogen');
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      clearGeminiAuthCache();
      getDb().prepare("DELETE FROM app_settings WHERE key IN ('ai_provider', 'gemini_api_key', 'gemini_model')").run();
      fs.rmSync(emptyCfg, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('testa CRUD completo via HTTP (Instituições, CNPJ, Logo, Secretários, Dotações, Import CSV/JSON, SRP toggle, Guarda Sequencial, Versões/Restore, Delete em Cascata e Exports)', async () => {
    const app = createApp();
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const address = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${address.port}`;

      // 1. Validação CNPJ inválido retorna 400
      const badCnpj = await fetch(`${baseUrl}/api/cnpj/11111111111111`);
      expect(badCnpj.status).toBe(400);

      // 2. Criar e atualizar Instituição (POST/PUT/GET + 404)
      const createInstRes = await fetch(`${baseUrl}/api/institutions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cnpj: '11222333000181',
          razao_social: 'PREFEITURA MUNICIPAL DE TESTE INTEGRADO',
          nome_fantasia: 'Prefeitura de Teste Integrado',
          municipio: 'Teste do Sul',
          uf: 'MG',
          prefeito_nome: 'Prefeita Clara Mendes'
        })
      });
      expect(createInstRes.status).toBe(201);
      const newInst = (await createInstRes.json()) as any;
      expect(newInst.cnpj).toBe('11.222.333/0001-81');

      const updateInstRes = await fetch(`${baseUrl}/api/institutions/${newInst.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portal_transparencia_url: 'https://transparencia.teste.mg.gov.br' })
      });
      expect(updateInstRes.status).toBe(200);
      const updatedInst = (await updateInstRes.json()) as any;
      expect(updatedInst.portal_transparencia_url).toBe('https://transparencia.teste.mg.gov.br');

      expect((await fetch(`${baseUrl}/api/institutions/inexistente-999`)).status).toBe(404);

      // 3. Upload de Logo (rejeita javascript: URL e aceita multipart PNG válido)
      const badLogoRes = await fetch(`${baseUrl}/api/institutions/${newInst.id}/logo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logo_data_url: 'javascript:alert(1)' })
      });
      expect(badLogoRes.status).toBe(400);

      const tinyPngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const logoFd = new FormData();
      logoFd.append(
        'logo',
        new Blob([Buffer.from(tinyPngBase64, 'base64')], { type: 'image/png' }),
        'brasao.png'
      );
      const logoRes = await fetch(`${baseUrl}/api/institutions/${newInst.id}/logo`, {
        method: 'POST',
        body: logoFd
      });
      expect(logoRes.status).toBe(200);
      const withLogo = (await logoRes.json()) as any;
      expect(withLogo.logo_data_url).toContain('data:image/png;base64,');

      // 4. CRUD Secretários & Dotações + validações 400/404
      expect(
        (
          await fetch(`${baseUrl}/api/institutions/${newInst.id}/secretarios`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secretaria: '', nome: '' })
          })
        ).status
      ).toBe(400);

      const secRes = await fetch(`${baseUrl}/api/institutions/${newInst.id}/secretarios`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secretaria: 'Secretaria Municipal de Obras Públicas',
          nome: 'Eng. Roberto Lima',
          cargo: 'Secretário Municipal de Obras',
          portaria_nomeacao: 'Portaria nº 088/2026'
        })
      });
      expect(secRes.status).toBe(201);
      const sec = (await secRes.json()) as any;

      const secPutRes = await fetch(`${baseUrl}/api/institutions/${newInst.id}/secretarios/${sec.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portaria_nomeacao: 'Portaria nº 099/2026' })
      });
      expect(secPutRes.status).toBe(200);
      expect(((await secPutRes.json()) as any).portaria_nomeacao).toBe('Portaria nº 099/2026');

      const dotRes = await fetch(`${baseUrl}/api/institutions/${newInst.id}/dotacoes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgao: '02 - Executivo',
          unidade_orcamentaria: '02.07 - Secretaria de Obras',
          elemento_despesa: '4.4.90.51.00 - Obras e Instalações',
          fonte_recurso: '1.500.000.0000',
          codigo_reduzido: '405',
          saldo_disponivel: 950000
        })
      });
      expect(dotRes.status).toBe(201);
      const dot = (await dotRes.json()) as any;
      expect(dot.saldo_disponivel).toBe(950000);

      const dotPutRes = await fetch(`${baseUrl}/api/institutions/${newInst.id}/dotacoes/${dot.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ saldo_disponivel: 1200000 })
      });
      expect(dotPutRes.status).toBe(200);
      expect(((await dotPutRes.json()) as any).saldo_disponivel).toBe(1200000);

      // 5. Importação CSV & JSON via HTTP
      const impRes = await fetch(`${baseUrl}/api/institutions/${newInst.id}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'secretarios',
          format: 'csv',
          content: 'secretaria;nome;cargo;portaria\nSecretaria de Cultura;Marina Alves;Secretária de Cultura;Portaria 10/2026'
        })
      });
      expect(impRes.status).toBe(200);
      const impJson = (await impRes.json()) as any;
      expect(impJson.imported).toBe(1);

      const delSec = await fetch(
        `${baseUrl}/api/institutions/${newInst.id}/secretarios/${impJson.items[0].id}`,
        { method: 'DELETE' }
      );
      expect(delSec.status).toBe(200);
      expect(
        (
          await fetch(`${baseUrl}/api/institutions/${newInst.id}/dotacoes/nao-existe`, {
            method: 'DELETE'
          })
        ).status
      ).toBe(404);

      // 6. Toggle Modo Teste Online via HTTP
      const toggleOff = await fetch(`${baseUrl}/api/platform/online-test-mode`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false })
      });
      expect(toggleOff.status).toBe(200);
      expect(((await toggleOff.json()) as any).test_mode).toBe(false);

      const toggleOn = await fetch(`${baseUrl}/api/platform/online-test-mode`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true })
      });
      expect(toggleOn.status).toBe(200);
      expect(((await toggleOn.json()) as any).test_mode).toBe(true);

      // 7. Processo Concorrência Eletrônica (Obras) + Toggle SRP + Guarda Sequencial + Feedback + Edit/Restore + Exports + Delete Cascata
      const procRes = await fetch(`${baseUrl}/api/processes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          institution_id: newInst.id,
          secretario_id: sec.id,
          dotacao_ids: [dot.id],
          tipo_contratacao: 'OBRAS_ENGENHARIA',
          numero_processo_licitatorio: '045/2026',
          numero_processo_administrativo: '890/2026',
          titulo_resumido: 'Pavimentação asfáltica em CBUQ de vias urbanas municipais',
          modalidade: 'CONCORRENCIA_ELETRONICA',
          modo_disputa: 'ABERTO',
          criterio_julgamento: 'MENOR_PRECO',
          formato_lance: 'GLOBAL',
          usar_srp: true,
          valor_estimado_global: 850000,
          demanda_bruta: 'Execução de pavimentação asfáltica em CBUQ, drenagem pluvial e sinalização viária.'
        })
      });
      expect(procRes.status).toBe(201);
      const procBundle = (await procRes.json()) as any;
      const procId = procBundle.process.id;
      expect(procBundle.pieces.find((p: any) => p.agent_number === 8).status).not.toBe('DISPENSADO');

      // Guarda sequencial: tentar executar Agente 5 antes do Agente 1 deve retornar HTTP 400
      const outOfOrderRes = await fetch(`${baseUrl}/api/processes/${procId}/agents/5/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(outOfOrderRes.status).toBe(400);

      // Alternar SRP true -> false deve dispensar Agente 08
      const srpOffRes = await fetch(`${baseUrl}/api/processes/${procId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usar_srp: false })
      });
      expect(srpOffRes.status).toBe(200);
      const srpOffBundle = (await srpOffRes.json()) as any;
      expect(srpOffBundle.pieces.find((p: any) => p.agent_number === 8).status).toBe('DISPENSADO');

      // Execução em lote 01–11 (10 peças ativas, pulando 08)
      const batchRes = await fetch(`${baseUrl}/api/processes/${procId}/agents/execute-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actorName: 'Eng. Roberto Lima', autoApprove: false })
      });
      expect(batchRes.status).toBe(200);
      const batchJson = (await batchRes.json()) as any;
      expect(batchJson.executed_agents).toEqual([1, 2, 3, 4, 5, 6, 7, 9, 10, 11]);
      // Agente 11 deve conter o Brasão carregado
      const ag11 = batchJson.bundle.pieces.find((p: any) => p.agent_number === 11);
      expect(ag11.html_content).toContain(tinyPngBase64);

      // Regenerar Agente 2 com Feedback via HTTP
      const fbText = 'Incluir cláusula expressa de vistoria técnica facultativa no canteiro de obras.';
      const fbRes = await fetch(`${baseUrl}/api/processes/${procId}/agents/2/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: fbText })
      });
      expect(fbRes.status).toBe(200);
      const fbJson = (await fbRes.json()) as any;
      expect(fbJson.piece.current_version).toBe(2);
      expect(fbJson.piece.html_content).toContain(fbText);
      expect(fbJson.piece.structured_json.feedback_incorporado).toBe(fbText);

      // Edição Manual -> Versões -> Restore v1 -> Aprovar e Assinar (SHA-256)
      const editRes = await fetch(`${baseUrl}/api/processes/${procId}/agents/2`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html_content: `${fbJson.piece.html_content}<p>Parágrafo incluído manualmente para auditoria.</p>`,
          actorName: 'Dra. Carla Revisor'
        })
      });
      expect(editRes.status).toBe(200);
      const editJson = (await editRes.json()) as any;
      expect(editJson.piece.current_version).toBe(3);

      const versionsRes = await fetch(`${baseUrl}/api/processes/${procId}/agents/2/versions`);
      expect(versionsRes.status).toBe(200);
      const versionsList = (await versionsRes.json()) as any[];
      expect(versionsList.length).toBeGreaterThanOrEqual(3);

      const restoreRes = await fetch(`${baseUrl}/api/processes/${procId}/agents/2/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionNumber: 1, actorName: 'Dra. Carla Revisor' })
      });
      expect(restoreRes.status).toBe(200);
      const restoreJson = (await restoreRes.json()) as any;
      expect(restoreJson.piece.current_version).toBe(4);
      expect(restoreJson.piece.html_content).not.toContain('Parágrafo incluído manualmente');

      const approveRes = await fetch(`${baseUrl}/api/processes/${procId}/agents/2/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actorName: 'Eng. Roberto Lima', actorRole: 'Secretário de Obras' })
      });
      expect(approveRes.status).toBe(200);
      const approveJson = (await approveRes.json()) as any;
      expect(approveJson.piece.status).toBe('APROVADO');
      expect(approveJson.piece.content_hash).toMatch(/^[a-f0-9]{64}$/);

      // Exports HTTP (PDF, DOCX consolidado, DOCX avulso Ag. 09 e ZIP sem Ag. 08)
      const pdfRes = await fetch(`${baseUrl}/api/processes/${procId}/export/pdf`);
      expect(pdfRes.status).toBe(200);
      expect(pdfRes.headers.get('content-type')).toContain('application/pdf');
      const pdfBytes = await pdfRes.arrayBuffer();
      expect(pdfBytes.byteLength).toBeGreaterThan(2000);

      const docxRes = await fetch(`${baseUrl}/api/processes/${procId}/export/docx`);
      expect(docxRes.status).toBe(200);
      expect(docxRes.headers.get('content-type')).toContain('wordprocessingml');

      const singleDocxRes = await fetch(`${baseUrl}/api/processes/${procId}/export/docx/9`);
      expect(singleDocxRes.status).toBe(200);

      const zipRes = await fetch(`${baseUrl}/api/processes/${procId}/export/zip`);
      expect(zipRes.status).toBe(200);
      const zipLoaded = await JSZip.loadAsync(await zipRes.arrayBuffer());
      const zipEntries = Object.keys(zipLoaded.files);
      expect(zipEntries).toContain('00_Dossie_Completo_Consolidado.docx');
      expect(zipEntries.some((f) => f.startsWith('09_') && f.endsWith('.docx'))).toBe(true);
      expect(zipEntries.some((f) => f.startsWith('08_'))).toBe(false);

      // Delete em cascata
      const delProcRes = await fetch(`${baseUrl}/api/processes/${procId}`, { method: 'DELETE' });
      expect(delProcRes.status).toBe(200);
      expect((await fetch(`${baseUrl}/api/processes/${procId}`)).status).toBe(404);
      const remainingPieces = getDb()
        .prepare('SELECT COUNT(*) as c FROM agent_pieces WHERE process_id = ?')
        .get(procId) as { c: number };
      expect(remainingPieces.c).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('aplica cache TTL 5m na API TCU Dados Abertos e relata fallback HTTP 429 honesto em tcu_probe', async () => {
    clearTcuLiveCache();
    let fetchCalls = 0;

    // 1. Live API HTTP 200 -> 1ª chamada vai à rede, 2ª usa cache TTL
    const mockFetchOk = (async () => {
      fetchCalls++;
      return new Response(
        JSON.stringify([
          {
            numeroAcordao: '9876',
            anoAcordao: '2026',
            colegiado: 'Plenário TCU',
            sumario: 'Pesquisa de preços ampla em obras e serviços comuns.'
          }
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const r1 = await searchTcuJurisprudence({ q: 'pesquisa', includeLiveApi: true }, mockFetchOk);
    expect(r1.live_consulted).toBe(true);
    expect(r1.live_api_ok).toBe(true);
    expect(r1.items.some((i) => i.numero.includes('9876/2026'))).toBe(true);
    expect(fetchCalls).toBe(1);

    const r2 = await searchTcuJurisprudence({ q: 'pesquisa', includeLiveApi: true }, mockFetchOk);
    expect(r2.live_api_ok).toBe(true);
    expect(r2.live_diagnostics).toContain('cache 5m');
    expect(fetchCalls).toBe(1);

    // 2. Live API HTTP 429 -> live_api_ok = false, preserva Base Curada Verificada e respeita backoff cache
    clearTcuLiveCache();
    let rateLimitedCalls = 0;
    const mockFetch429 = (async () => {
      rateLimitedCalls++;
      return new Response('Too Many Requests', { status: 429 });
    }) as typeof fetch;

    const r429 = await searchTcuJurisprudence({ q: 'preços', includeLiveApi: true }, mockFetch429);
    expect(r429.live_consulted).toBe(true);
    expect(r429.live_api_ok).toBe(false);
    expect(r429.live_diagnostics).toContain('HTTP 429');
    expect(r429.items.length).toBeGreaterThan(0);
    expect(rateLimitedCalls).toBe(1);

    const r429Cached = await searchTcuJurisprudence({ q: 'preços', includeLiveApi: true }, mockFetch429);
    expect(r429Cached.live_api_ok).toBe(false);
    expect(rateLimitedCalls).toBe(1);

    clearTcuLiveCache();
  });

  it(
    'operações e resiliência: PRAGMAs WAL/busy_timeout + índices, /api/health, /api/processes/:id/clone, DELETE 404, erro JSON malformado e exportações PDF concorrentes',
    async () => {
      const db = getDb();
      const timeoutRow = db.prepare('PRAGMA busy_timeout').get() as Record<string, unknown>;
      expect(Object.values(timeoutRow)[0]).toBe(5000);
      const journalRow = db.prepare('PRAGMA journal_mode').get() as Record<string, unknown>;
      expect(String(Object.values(journalRow)[0]).toLowerCase()).toBe('wal');

      const expectedIndexes = [
        'idx_secretarios_inst',
        'idx_dotacoes_inst',
        'idx_processes_inst_updated',
        'idx_agent_pieces_proc_num',
        'idx_piece_versions_piece_ver',
        'idx_audit_logs_proc_created'
      ];
      const idxRows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
        .all() as Array<{ name: string }>;
      const idxNames = idxRows.map((r) => r.name);
      for (const expectedIdx of expectedIndexes) {
        expect(idxNames).toContain(expectedIdx);
      }

      const app = createApp();
      const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });

      try {
        const address = server.address() as { port: number };
        const baseUrl = `http://127.0.0.1:${address.port}`;

        // 1. /api/health com diagnóstico vivo do SQLite
        const healthRes = await fetch(`${baseUrl}/api/health`);
        expect(healthRes.status).toBe(200);
        const healthJson = (await healthRes.json()) as any;
        expect(healthJson.ok).toBe(true);
        expect(healthJson.db_ok).toBe(true);
        expect(String(healthJson.journal_mode).toLowerCase()).toBe('wal');
        expect(typeof healthJson.uptime_seconds).toBe('number');
        expect(healthJson.memory_mb).toBeGreaterThan(0);

        // 2. JSON malformado devolve JSON estruturado 400 em vez de HTML
        const malformedRes = await fetch(`${baseUrl}/api/processes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{json_invalido'
        });
        expect(malformedRes.status).toBe(400);
        expect(malformedRes.headers.get('content-type')).toContain('application/json');
        const malformedJson = (await malformedRes.json()) as any;
        expect(malformedJson.error).toBeTruthy();

        // 3. DELETE e Clone em IDs inexistentes retornam 404
        const missingDelRes = await fetch(`${baseUrl}/api/processes/id-inexistente-999`, {
          method: 'DELETE'
        });
        expect(missingDelRes.status).toBe(404);
        const missingCloneRes = await fetch(`${baseUrl}/api/processes/id-inexistente-999/clone`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        expect(missingCloneRes.status).toBe(404);

        // 4. Criar processo completo, executar Agente 01 e clonar processo
        const insts = (await (await fetch(`${baseUrl}/api/institutions`)).json()) as any[];
        const instDetail = (await (
          await fetch(`${baseUrl}/api/institutions/${insts[0].id}`)
        ).json()) as any;

        const samplePrecedent = {
          id: 'tcu-1875-2021',
          numero: 'Acórdão 1875/2021 - Plenário',
          tipo: 'ACORDAO' as const,
          colegiado: 'Plenário',
          tema: 'PESQUISA_PRECOS' as const,
          tema_label: 'Pesquisa de Preços',
          artigos_relacionados: 'Art. 23, § 1º',
          ementa: 'Cesta aceitável de preços na fase preparatória.',
          aplicacao_pratica: 'Documentar múltiplos parâmetros de preços.',
          fonte: 'BASE_CURADA_TCU' as const
        };

        const createRes = await fetch(`${baseUrl}/api/processes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            institution_id: insts[0].id,
            secretario_id: instDetail.secretarios[0]?.id || null,
            dotacao_ids: instDetail.dotacoes[0] ? [instDetail.dotacoes[0].id] : [],
            numero_processo_administrativo: 'PA-OPS-2026-01',
            numero_processo_licitatorio: 'PE-OPS-2026-01',
            titulo_resumido: 'Aquisição Operacional de Equipamentos de TI',
            tipo_objeto: 'PRODUTOS_COMUNS',
            tipo_contratacao: 'AQUISICAO',
            modalidade: 'PREGAO_ELETRONICO',
            criterio_julgamento: 'MENOR_PRECO',
            modo_disputa: 'ABERTO',
            usar_srp: false,
            valor_estimado_global: 125000,
            prazo_execucao: '12 meses',
            responsavel_requisitante: 'Gestor Teste Ops',
            cargo_requisitante: 'Diretor de TI',
            demanda_bruta: 'Aquisição de estações de trabalho para modernização operacional.',
            pesquisa_preco_itens: [
              {
                item: 1,
                descricao: 'Estação de Trabalho Corporativa',
                medida: 'UN',
                quantidade: 25,
                valor_unitario: 5000,
                valor_total: 125000
              }
            ],
            tcu_acordaos_vinculados: [samplePrecedent]
          })
        });
        expect(createRes.status).toBe(201);
        const srcBundle = (await createRes.json()) as any;
        const srcId = srcBundle.process.id as string;

        const exec1Res = await fetch(`${baseUrl}/api/processes/${srcId}/agents/1/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ actorName: 'Gestor Teste Ops' })
        });
        expect(exec1Res.status).toBe(200);

        const cloneRes = await fetch(`${baseUrl}/api/processes/${srcId}/clone`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        expect(cloneRes.status).toBe(201);
        const clonedBundle = (await cloneRes.json()) as any;
        expect(clonedBundle.process.id).not.toBe(srcId);
        expect(clonedBundle.process.numero_processo_licitatorio).toContain('COPIA');
        expect(clonedBundle.process.valor_estimado_global).toBe(125000);
        expect(clonedBundle.process.pesquisa_preco_itens.length).toBe(1);
        expect(clonedBundle.process.pesquisa_preco_itens[0]?.medida).toBe('UN');
        expect(clonedBundle.process.dotacao_ids).toEqual(srcBundle.process.dotacao_ids);
        expect(clonedBundle.process.tcu_acordaos_vinculados?.[0]?.numero).toBe(
          'Acórdão 1875/2021 - Plenário'
        );

        const clonedAg1 = clonedBundle.pieces.find((p: any) => p.agent_number === 1);
        expect(clonedAg1.status).toBe('PENDENTE');
        expect(clonedAg1.html_content).toBe('');
        expect(
          clonedBundle.audit_logs.some((log: any) => log.action === 'PROCESSO_CLONADO')
        ).toBe(true);

        // 5. Duas exportações PDF concorrentes enfileiradas e concluídas com PDFs válidos
        const [pdfResA, pdfResB] = await Promise.all([
          fetch(`${baseUrl}/api/processes/${srcId}/export/pdf`),
          fetch(`${baseUrl}/api/processes/${srcId}/export/pdf`)
        ]);
        expect(pdfResA.status).toBe(200);
        expect(pdfResB.status).toBe(200);
        const bufA = Buffer.from(await pdfResA.arrayBuffer());
        const bufB = Buffer.from(await pdfResB.arrayBuffer());
        expect(bufA.subarray(0, 5).toString('utf8')).toBe('%PDF-');
        expect(bufB.subarray(0, 5).toString('utf8')).toBe('%PDF-');

        // Limpeza e verificação de DELETE duplicado -> 404
        const delCloneRes = await fetch(`${baseUrl}/api/processes/${clonedBundle.process.id}`, {
          method: 'DELETE'
        });
        expect(delCloneRes.status).toBe(200);
        const delSrcRes = await fetch(`${baseUrl}/api/processes/${srcId}`, { method: 'DELETE' });
        expect(delSrcRes.status).toBe(200);
        const delSrcTwiceRes = await fetch(`${baseUrl}/api/processes/${srcId}`, { method: 'DELETE' });
        expect(delSrcTwiceRes.status).toBe(404);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    60000
  );

  it('configuração Vercel + Git: resolve /tmp no modo serverless, roteia /api/index corretamente e valida vercel.json/.gitignore', async () => {
    const gitignore = fs.readFileSync(path.resolve(process.cwd(), '.gitignore'), 'utf8');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('data/');
    expect(gitignore).toContain('.env');

    const vercelCfg = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf8')
    ) as any;
    expect(vercelCfg.buildCommand).toBe('npm run build');
    expect(vercelCfg.outputDirectory).toBe('dist');
    expect(vercelCfg.functions['api/index.ts']?.maxDuration).toBe(60);
    expect(vercelCfg.rewrites.some((r: any) => r.source === '/api/(.*)' && r.destination === '/api')).toBe(true);

    const prevVercel = process.env.VERCEL;
    const prevDataDir = process.env.GOVFLOW_DATA_DIR;
    process.env.VERCEL = '1';
    delete process.env.GOVFLOW_DATA_DIR;

    const server = http.createServer(vercelHandler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

    try {
      expect(isServerlessRuntime()).toBe(true);
      expect(getDataDir()).toBe(path.join(os.tmpdir(), 'govflow-data'));

      const port = (server.address() as { port: number }).port;
      const baseUrl = `http://127.0.0.1:${port}`;

      const h1 = await fetch(`${baseUrl}/api/health`);
      expect(h1.status).toBe(200);
      const j1 = (await h1.json()) as any;
      expect(j1.ok).toBe(true);
      expect(j1.persistence_mode).toBe('serverless_tmp');

      // Simula rewrite que tenha removido o prefixo /api antes de entregar à função
      const h2 = await fetch(`${baseUrl}/health`);
      expect(h2.status).toBe(200);
      const j2 = (await h2.json()) as any;
      expect(j2.ok).toBe(true);
    } finally {
      if (prevVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = prevVercel;
      if (prevDataDir === undefined) delete process.env.GOVFLOW_DATA_DIR;
      else process.env.GOVFLOW_DATA_DIR = prevDataDir;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
