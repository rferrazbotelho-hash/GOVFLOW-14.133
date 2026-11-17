import type {
  CriterioJulgamento,
  LegalAlert,
  ModalidadeLicitacao,
  ModoDisputa,
  ProcurementProcess
} from '../../shared/types.js';

export function isDirectContracting(modalidade: ModalidadeLicitacao): boolean {
  return modalidade === 'DISPENSA' || modalidade === 'INEXIGIBILIDADE';
}

export function getAllowedCriteria(modalidade: ModalidadeLicitacao): CriterioJulgamento[] {
  switch (modalidade) {
    case 'PREGAO_ELETRONICO':
    case 'PREGAO_PRESENCIAL':
      // Art. 6º, XLI: Pregão exige Menor Preço ou Maior Desconto
      return ['MENOR_PRECO', 'MAIOR_DESCONTO'];
    case 'CONCORRENCIA_ELETRONICA':
    case 'CONCORRENCIA_PRESENCIAL':
      // Art. 6º, XXXVIII: Concorrência aceita todos exceto Maior Lance
      return [
        'MENOR_PRECO',
        'MAIOR_DESCONTO',
        'MELHOR_TECNICA',
        'TECNICA_E_PRECO',
        'MAIOR_RETORNO_ECONOMICO'
      ];
    case 'CONCURSO':
      // Art. 30: Concurso é para escolha de trabalho técnico, científico ou artístico
      return ['MELHOR_TECNICA'];
    case 'LEILAO':
      // Art. 6º, XL / Art. 31: Leilão exige Maior Lance
      return ['MAIOR_LANCE'];
    case 'DIALOGO_COMPETITIVO':
      return ['MENOR_PRECO', 'TECNICA_E_PRECO', 'MELHOR_TECNICA', 'MAIOR_RETORNO_ECONOMICO'];
    case 'DISPENSA':
    case 'INEXIGIBILIDADE':
      return ['MENOR_PRECO', 'MAIOR_DESCONTO', 'TECNICA_E_PRECO'];
  }
}

export function getAllowedDisputeModes(
  modalidade: ModalidadeLicitacao,
  criterio: CriterioJulgamento
): ModoDisputa[] {
  if (modalidade === 'INEXIGIBILIDADE') {
    return ['NAO_APLICAVEL'];
  }
  if (modalidade === 'DISPENSA') {
    return ['ABERTO', 'NAO_APLICAVEL'];
  }
  if (modalidade === 'LEILAO') {
    return ['ABERTO'];
  }
  if (modalidade === 'CONCURSO') {
    return ['FECHADO'];
  }

  // Art. 56, § 1º: É vedada a utilização isolada do modo fechado quando adotados menor preço ou maior desconto
  if (criterio === 'MENOR_PRECO' || criterio === 'MAIOR_DESCONTO') {
    return ['ABERTO', 'ABERTO_FECHADO', 'FECHADO_ABERTO'];
  }

  // Art. 56, § 2º: É vedada a utilização do modo aberto quando o critério for técnica e preço
  if (criterio === 'TECNICA_E_PRECO') {
    return ['FECHADO', 'ABERTO_FECHADO', 'FECHADO_ABERTO'];
  }

  return ['ABERTO', 'FECHADO', 'ABERTO_FECHADO', 'FECHADO_ABERTO'];
}

export function validateCertameConfiguration(
  proc: Pick<
    ProcurementProcess,
    | 'modalidade'
    | 'modo_disputa'
    | 'criterio_julgamento'
    | 'formato_lance'
    | 'usar_srp'
    | 'numero_processo_licitatorio'
    | 'numero_processo_administrativo'
    | 'secretario_id'
    | 'dotacao_id'
    | 'dotacao_ids'
    | 'dotacoes_manuais'
  >
): LegalAlert[] {
  const alerts: LegalAlert[] = [];

  if (!proc.numero_processo_licitatorio?.trim() || !proc.numero_processo_administrativo?.trim()) {
    alerts.push({
      id: 'missing-process-numbers',
      severity: 'warning',
      article: 'Art. 12, VI c/c Art. 18',
      title: 'Numeração Processual Incompleta',
      message:
        'Os números do Processo Licitatório e do Processo Administrativo devem estar preenchidos para correta autuação dos autos.',
      recommendation: 'Informe ambos os números nos Dados do Certame.'
    });
  }

  if (!proc.secretario_id) {
    alerts.push({
      id: 'missing-secretario',
      severity: 'warning',
      article: 'Art. 7º e Art. 18',
      title: 'Ordenador de Despesa não vinculado',
      message: 'Nenhuma Secretaria/Ordenador de Despesa foi selecionado para o certame.',
      recommendation: 'Selecione ou cadastre o Secretário responsável para assinar o DFD e Termo de Autorização.'
    });
  }

  const hasDotacao = Boolean(
    proc.dotacao_id ||
      (proc.dotacao_ids && proc.dotacao_ids.length > 0) ||
      (proc.dotacoes_manuais && proc.dotacoes_manuais.length > 0)
  );

  if (!hasDotacao && !proc.usar_srp) {
    alerts.push({
      id: 'missing-dotacao',
      severity: 'warning',
      article: 'Art. 18, caput e Art. 150',
      title: 'Dotação Orçamentária não informada',
      message:
        'Contratações fora do SRP exigem indicação da disponibilidade de créditos orçamentários antes da contratação.',
      recommendation: 'Vincule ao menos uma dotação orçamentária vigente ou marque SRP (Art. 82).'
    });
  } else if (!hasDotacao && proc.usar_srp) {
    alerts.push({
      id: 'srp-dotacao-info',
      severity: 'info',
      article: 'Art. 82 e Decreto nº 11.462/2023 (Art. 17)',
      title: 'SRP: Dotação facultativa na fase de registro',
      message:
        'No Sistema de Registro de Preços, a indicação da disponibilidade de créditos orçamentários somente será exigida para a formalização do contrato ou instrumento hábil.',
      recommendation: 'Ainda assim, recomenda-se indicar a dotação referencial estimativa no ETP/TR.'
    });
  }

  // Modalidade presencial alerta Art. 17 § 2º e § 5º
  if (proc.modalidade === 'PREGAO_PRESENCIAL' || proc.modalidade === 'CONCORRENCIA_PRESENCIAL') {
    alerts.push({
      id: 'presencial-motivation',
      severity: 'warning',
      article: 'Art. 17, § 2º e § 5º',
      title: 'Excepcionalidade da Forma Presencial',
      message:
        'As licitações deverão ser realizadas preferencialmente sob a forma eletrônica. A forma presencial exige motivação expressa nos autos e gravação da sessão em áudio e vídeo.',
      recommendation: 'Inclua justificativa técnica/local robusta no ETP e no Termo de Referência.'
    });
  }

  // Critério permitido pela modalidade
  const allowedCriteria = getAllowedCriteria(proc.modalidade);
  if (!allowedCriteria.includes(proc.criterio_julgamento)) {
    alerts.push({
      id: 'invalid-criterio-modalidade',
      severity: 'critical',
      article: 'Art. 6º, XXXVIII-XLI e Art. 33',
      title: 'Incompatibilidade entre Modalidade e Critério de Julgamento',
      message: `O critério "${proc.criterio_julgamento}" não é admitido para a modalidade "${proc.modalidade}" na Lei nº 14.133/2021.`,
      recommendation: `Ajuste o critério de julgamento para um dos permitidos: ${allowedCriteria.join(', ')}.`
    });
  }

  // Modo de disputa permitido
  const allowedModes = getAllowedDisputeModes(proc.modalidade, proc.criterio_julgamento);
  if (!allowedModes.includes(proc.modo_disputa)) {
    alerts.push({
      id: 'invalid-modo-disputa',
      severity: 'critical',
      article: 'Art. 56, § 1º e § 2º',
      title: 'Modo de Disputa Vedado pela Lei nº 14.133/2021',
      message: `O modo de disputa "${proc.modo_disputa}" é incompatível com a modalidade "${proc.modalidade}" e critério "${proc.criterio_julgamento}".`,
      recommendation: `Selecione um modo válido: ${allowedModes.join(', ')}.`
    });
  }

  // SRP compatibilidade (Art. 82 § 6º)
  if (
    proc.usar_srp &&
    !['PREGAO_ELETRONICO', 'PREGAO_PRESENCIAL', 'CONCORRENCIA_ELETRONICA', 'CONCORRENCIA_PRESENCIAL', 'DISPENSA', 'INEXIGIBILIDADE'].includes(
      proc.modalidade
    )
  ) {
    alerts.push({
      id: 'invalid-srp-modalidade',
      severity: 'critical',
      article: 'Art. 82, § 6º',
      title: 'SRP Incompatível com a Modalidade',
      message:
        'O Sistema de Registro de Preços aplica-se às modalidades Pregão, Concorrência e às hipóteses de Contratação Direta (Dispensa/Inexigibilidade).',
      recommendation: 'Desmarque o SRP ou altere a modalidade para Pregão ou Concorrência.'
    });
  }

  // Formato de lance Por Lote / Global -> Súmula 247 TCU e Art. 40 § 2º
  if (
    (proc.criterio_julgamento === 'MENOR_PRECO' || proc.criterio_julgamento === 'MAIOR_DESCONTO') &&
    (proc.formato_lance === 'POR_LOTE' || proc.formato_lance === 'GLOBAL')
  ) {
    alerts.push({
      id: 'parcelamento-sumula-247',
      severity: 'info',
      article: 'Art. 40, § 2º e § 3º / Súmula 247 TCU',
      title: 'Aglutinação em Lote ou Global exige Justificativa no ETP',
      message:
        'A regra geral da Lei nº 14.133/2021 é o parcelamento por item. A adjudicação por lote ou preço global exige demonstração de prejuízo técnico ou perda de economia de escala.',
      recommendation: 'O Agente 03 (ETP) e o Agente 05 (TR) incluirão justificativa detalhada para o agrupamento.'
    });
  }

  if (proc.usar_srp) {
    alerts.push({
      id: 'srp-active-arp',
      severity: 'info',
      article: 'Art. 82 a 86',
      title: 'SRP Ativado: Agente 08 (Minuta de ARP) Obrigatório',
      message:
        'Como o Sistema de Registro de Preços foi selecionado, o Agente 08 está ativado na esteira e o Edital incluirá a ARP como anexo obrigatório.',
      recommendation: 'Revise regras de validade (1 ano + 1 ano) e adesão (carona) no Agente 08.'
    });
  }

  return alerts;
}
