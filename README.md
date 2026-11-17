# GOVFLOW 14.133 — Sistema Multi-Agente de Contratações Públicas

Aplicação web Full-Stack para elaboração, validação jurídica, versionamento e compilação auditável de processos de contratação pública sob a **Lei Federal nº 14.133/2021**.

## Arquitetura

- **Frontend:** React + TypeScript + Vite + Tailwind CSS + Editor Rico TipTap (`client/`).
- **Backend API & Orquestrador:** Express + TypeScript + SQLite nativo (`node:sqlite` em `server/`).
- **Motor Multi-Agente Híbrido:** Opera out-of-the-box com o **Motor Jurídico Especialista Local 14.133** (determinístico e offline) e suporta integração opcional com **Gemini** ou **OpenAI** via tela *Motor de Agentes* ou `.env`.
- **Integrações:**
  - Consulta de CNPJ via **BrasilAPI** com fallback automático para **ReceitaWS** (`GET /api/cnpj/:cnpj`).
  - Agente Extrator (Web Scraping HTML/JSON) do Portal da Transparência + Importação CSV/JSON (`POST /api/institutions/:id/scrape` e `/import`).
- **Exportação Oficial:**
  - **PDF Consolidado** (Puppeteer/Chromium com cabeçalho/rodapé institucional com Brasão em todas as páginas + Índice Remissivo Paginado em 2 passos via `pdf-lib`, com fallback automático em `pdfkit`).
  - **DOCX Editável** (peça individual, consolidado e pacote **ZIP** completo via `docx` + `jszip`).

## Como Executar

```bash
# Instalar dependências (se ainda não instalado)
npm install

# Rodar Frontend (5173) e Backend API (3001) em desenvolvimento
npm run dev

# Executar suíte de testes automatizados
npm test

# Build de produção e start em servidor único
npm run build
npm start
```

## Deploy via GitHub + Vercel

O repositório já inclui configuração para deploy na **Vercel** (`vercel.json`, entrypoint serverless em `api/index.ts`, `.gitignore` e runtime `engines.node = "24.x"` para suporte nativo a `node:sqlite`):

1. **Publicar no GitHub:** inicialize o repositório Git local, crie o repositório no GitHub e envie o código (`data/`, `.env`, `dist/`, `dist-server/` e `node_modules/` já estão protegidos no `.gitignore`).
2. **Importar na Vercel:** conecte o repositório na Vercel (Build Command: `npm run build`, Output Directory: `dist`).
3. **Variáveis de Ambiente na Vercel (opcional):** defina `AI_PROVIDER` (`auto`, `gemini`, `openai` ou `local`), `GEMINI_API_KEY`, `GEMINI_MODEL` (`gemini-4-hydrogen`) e/ou `OPENAI_API_KEY` conforme o provedor desejado.
4. **Nota sobre persistência:** em funções serverless da Vercel (`VERCEL=1`), o SQLite grava automaticamente em diretório temporário gravável (`/tmp/govflow-data`) com dados efêmeros entre *cold starts* e exportação de PDF via fallback `pdfkit`. Para persistência contínua de processos em disco e Chromium nativo, execute com `npm start` em VPS/servidor Node.js persistente.
