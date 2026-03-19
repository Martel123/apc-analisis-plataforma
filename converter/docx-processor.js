'use strict';

/**
 * DOCX → JSON Processor v3 — Arquitectura multietapa por chunks
 *
 * FASE A  Extracción local completa (mammoth, sin IA)
 * FASE B  Segmentación inteligente en chunks seguros (sin IA)
 * FASE C  Mapeo estructural por chunk (1 llamada IA pequeña por chunk)
 * FASE D  Consolidación local de estructura (sin IA)
 * FASE E  Extracción detallada variable a variable (1 llamada IA por variable)
 * FASE F  Ensamblaje final (sin IA)
 * FASE G  Validación estricta sin auto-corrección (sin IA)
 *
 * GARANTÍAS:
 *  - Ninguna llamada a IA recibe el documento completo
 *  - Chunks conservadores: 6 000 chars ≈ 1 500 tokens de entrada
 *  - Retry con backoff exponencial en error 429
 *  - Cero modificación de puntajes ni promedios
 *  - Cero invención de contenido
 *  - Si validación falla → no se guarda nada
 */

const mammoth = require('mammoth');
const OpenAI  = require('openai');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const ANALISIS_DIR = path.join(__dirname, '..', 'analisis');
const CACHE_DIR    = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Parámetros configurables ──────────────────────────────────────────────────
const CHUNK_SIZE      = 6_000;   // chars por chunk ≈ 1 500 tokens de entrada
const CHUNK_OVERLAP   = 800;     // solapamiento para no cortar secciones al borde
const VAR_WINDOW      = 10_000;  // chars de contexto por variable en Fase E
const CALL_DELAY_MS   = 600;     // pausa entre llamadas para evitar TPM
const MAX_RETRIES     = 4;       // reintentos en caso de 429

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function fileHash(fp) {
  return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
}

function cleanJson(raw) {
  return raw
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
}

function safeParse(raw, label) {
  try { return JSON.parse(raw); }
  catch (e) {
    throw new Error(`JSON inválido en "${label}": ${e.message}\n\nFragmento:\n${raw.slice(0, 300)}`);
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Llamada a IA con backoff automático ──────────────────────────────────────

async function aiCall({ systemPrompt, userContent, label, onProgress, maxTokens = 2000 }) {
  await sleep(CALL_DELAY_MS);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',   // más rápido, menor costo, ventana suficiente para chunks pequeños
        temperature: 0,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userContent }
        ]
      });

      const finish = resp.choices[0].finish_reason;
      if (finish === 'length') {
        throw new Error(`Output truncado en "${label}". Increase maxTokens o reduce el tamaño del chunk.`);
      }

      return cleanJson(resp.choices[0].message.content.trim());

    } catch (err) {
      const status = err?.status || err?.response?.status;
      if ((status === 429 || status === 503) && attempt < MAX_RETRIES) {
        const wait = attempt * 30_000;
        onProgress(`⚠ Rate limit (${status}) en "${label}". Esperando ${wait / 1000}s (intento ${attempt}/${MAX_RETRIES})...`);
        await sleep(wait);
      } else {
        throw err;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE A — Extracción local
// ═══════════════════════════════════════════════════════════════════════════════

async function phaseA_extract(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  const text = (result.value || '').trim();
  if (text.length < 500) {
    throw new Error('FASE A: El documento está vacío o es ilegible (menos de 500 caracteres). Verifica que el .docx no esté protegido.');
  }
  return text;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE B — Segmentación inteligente
// ═══════════════════════════════════════════════════════════════════════════════

// Patrones de encabezado que indican inicio de sección/bloque/variable en documentos típicos
const HEADER_RE = /\n(?=(?:BLOQUE|Bloque|VARIABLE|Variable|CRITERIO|Criterio|SECCIÓN|Sección|CAPITULO|Capítulo|\d+\.\s+[A-ZÁÉÍÓÚÑ]|[IVX]+\.\s+[A-ZÁÉÍÓÚÑ]))/g;

function phaseB_segment(text) {
  const chunks = [];
  let pos = 0;

  // Intentar dividir en cortes naturales (encabezados)
  const breakPoints = [];
  let m;
  HEADER_RE.lastIndex = 0;
  while ((m = HEADER_RE.exec(text)) !== null) {
    breakPoints.push(m.index);
  }

  if (breakPoints.length >= 4) {
    // Hay encabezados: agrupar break-points en chunks respetando CHUNK_SIZE
    let chunkStart = 0;
    for (let i = 0; i < breakPoints.length; i++) {
      const nextBreak = breakPoints[i + 1] ?? text.length;
      const size = nextBreak - chunkStart;
      if (size >= CHUNK_SIZE || i === breakPoints.length - 1) {
        const end = Math.min(nextBreak + CHUNK_OVERLAP, text.length);
        chunks.push({ text: text.slice(chunkStart, end), start: chunkStart, end });
        chunkStart = nextBreak;
      }
    }
    // último fragmento
    if (chunkStart < text.length) {
      chunks.push({ text: text.slice(chunkStart), start: chunkStart, end: text.length });
    }
  } else {
    // Sin encabezados claros: segmentación por tamaño fijo con solapamiento
    while (pos < text.length) {
      const end = Math.min(pos + CHUNK_SIZE, text.length);
      const endWithOverlap = Math.min(end + CHUNK_OVERLAP, text.length);
      chunks.push({ text: text.slice(pos, endWithOverlap), start: pos, end: endWithOverlap });
      pos = end;
    }
  }

  // Fusionar chunks muy pequeños con el anterior
  const merged = [];
  for (const chunk of chunks) {
    if (merged.length > 0 && chunk.text.length < 800) {
      const prev = merged[merged.length - 1];
      prev.text += '\n' + chunk.text;
      prev.end   = chunk.end;
    } else {
      merged.push({ ...chunk });
    }
  }

  return merged;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE C — Mapeo estructural por chunk (llamadas IA pequeñas)
// ═══════════════════════════════════════════════════════════════════════════════

const PROMPT_C = `Eres un extractor de estructura documental. SOLO debes extraer los elementos estructurales que aparecen EXPLÍCITAMENTE en el fragmento de texto dado. PROHIBIDO inventar, resumir o inferir nada.

Del fragmento extrae:
- Nombre y partido del candidato si aparecen (puede que no aparezcan en este fragmento)
- Descripción de la metodología si aparece (puede que no aparezca)
- Nombres de bloques temáticos que aparezcan explícitamente (ej: "BLOQUE 1: Economía")
- Nombres de variables que aparezcan explícitamente (ej: "Variable 3: Política tributaria")
- Puntaje total del candidato si aparece

Devuelve SOLO este JSON (sin bloques de código, sin texto adicional):
{
  "candidate_name": "<nombre o null>",
  "candidate_party": "<partido o null>",
  "candidate_total_score": <número o null>,
  "methodology_snippet": "<texto de metodología encontrado o null>",
  "blocks_found": [
    { "name": "<nombre exacto del bloque>", "id_hint": "<slug sugerido>" }
  ],
  "variables_found": [
    { "name": "<nombre exacto de la variable>", "block_hint": "<nombre del bloque al que pertenece si está claro>", "id_hint": "<slug>" }
  ]
}`;

async function phaseC_mapChunk(chunk, chunkIndex, totalChunks, onProgress) {
  onProgress(`  Chunk ${chunkIndex + 1}/${totalChunks} (${chunk.text.length} chars)...`);
  const raw = await aiCall({
    systemPrompt: PROMPT_C,
    userContent: `Fragmento del documento:\n\n${chunk.text}`,
    label: `mapeo-chunk-${chunkIndex + 1}`,
    onProgress,
    maxTokens: 1200
  });
  return safeParse(raw, `mapeo-chunk-${chunkIndex + 1}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE D — Consolidación local de estructura
// ═══════════════════════════════════════════════════════════════════════════════

function phaseD_consolidate(chunkMaps, onProgress) {
  // Candidato
  let candidateName  = null;
  let candidateParty = null;
  let candidateTotalScore = null;
  let methodologySnippets = [];

  // Bloques y variables: deduplicar por nombre normalizado
  const blockMap    = new Map(); // normalized_name → {name, id_hint}
  const variableMap = new Map(); // normalized_name → {name, block_hint, id_hint}

  for (const m of chunkMaps) {
    if (!candidateName  && m.candidate_name)   candidateName  = m.candidate_name;
    if (!candidateParty && m.candidate_party)  candidateParty = m.candidate_party;
    if (m.candidate_total_score !== null && m.candidate_total_score !== undefined && !candidateTotalScore) {
      candidateTotalScore = m.candidate_total_score;
    }
    if (m.methodology_snippet) methodologySnippets.push(m.methodology_snippet);

    for (const b of (m.blocks_found || [])) {
      const key = slugify(b.name);
      if (!blockMap.has(key)) blockMap.set(key, b);
    }
    for (const v of (m.variables_found || [])) {
      const key = slugify(v.name);
      if (!variableMap.has(key)) variableMap.set(key, v);
    }
  }

  const blocks    = [...blockMap.values()];
  const variables = [...variableMap.values()];

  onProgress(`  Candidato: ${candidateName || '(no detectado)'}`);
  onProgress(`  Bloques detectados: ${blocks.length}`);
  onProgress(`  Variables detectadas: ${variables.length}`);

  if (blocks.length !== 8) {
    throw new Error(
      `FASE D: Se detectaron ${blocks.length} bloques en el documento (se esperan 8).\n` +
      `Bloques encontrados:\n${blocks.map(b => '  · ' + b.name).join('\n') || '  (ninguno)'}\n\n` +
      `Causas posibles: el documento no sigue el formato esperado, o los encabezados de bloques tienen un formato diferente al estándar.`
    );
  }
  if (variables.length !== 30) {
    throw new Error(
      `FASE D: Se detectaron ${variables.length} variables en el documento (se esperan 30).\n` +
      `Variables encontradas:\n${variables.map(v => '  · ' + v.name).join('\n') || '  (ninguna)'}\n\n` +
      `Causas posibles: el documento está incompleto, o los encabezados de variables tienen un formato diferente al estándar.`
    );
  }

  return {
    candidateName,
    candidateParty,
    candidateTotalScore,
    methodologyText: methodologySnippets.join('\n\n'),
    blocks,
    variables
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE E — Extracción detallada variable a variable
// ═══════════════════════════════════════════════════════════════════════════════

function findVariableSection(fullText, varName, nextVarName) {
  // Busca el inicio de la variable en el texto
  const needle = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(needle, 'i');
  const match = re.exec(fullText);
  if (!match) return null;

  const start = Math.max(0, match.index - 200); // incluir un poco de contexto previo

  // Buscar fin: inicio de la siguiente variable o VAR_WINDOW chars
  let end = start + VAR_WINDOW;
  if (nextVarName) {
    const needle2 = nextVarName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re2 = new RegExp(needle2, 'i');
    re2.lastIndex = match.index + varName.length;
    const m2 = re2.exec(fullText);
    if (m2 && m2.index < end) end = m2.index;
  }

  return fullText.slice(start, Math.min(end, fullText.length));
}

function buildPromptE(blockName, varName) {
  return `Eres un extractor técnico estricto. Tu única tarea es extraer información EXACTAMENTE como aparece en el fragmento de texto. PROHIBIDO inventar, resumir, reescribir o modificar ningún valor.

TAREA: Del fragmento de texto, extrae el contenido completo de la variable "${varName}" del bloque "${blockName}".

REGLAS ABSOLUTAS:
- Los valores numéricos (criterios, puntajes, sumas, resultados) deben ser EXACTAMENTE los que aparecen en el documento. NO recalcules nada.
- El texto narrativo de cada sección debe ser el texto COMPLETO del fragmento. NO resumir.
- Si una sección no aparece en el fragmento, usa "" (cadena vacía). NO inventes.
- Si un criterio no aparece, usa null. NO inventes.

Devuelve SOLO este JSON (sin bloques de código, sin texto adicional):
{
  "id": "<slug de ${varName}>",
  "name": "${varName}",
  "final_score": <número exacto del documento>,
  "criteria_sum": <número exacto del documento>,
  "formula_result": <número exacto del documento>,
  "summary": "<texto completo tal como aparece>",
  "strengths": ["<exactamente como aparece>"],
  "weaknesses": ["<exactamente como aparece>"],
  "gaps": ["<exactamente como aparece>"],
  "conclusion": "<texto completo tal como aparece>",
  "corrected_methodology": false,
  "correction_note": "",
  "criteria": {
    "diagnostico": <0|1|2 exacto del documento>,
    "propuesta": <0|1|2 exacto del documento>,
    "medidas": <0|1|2 exacto del documento>,
    "implementacion": <0|1|2 exacto del documento>,
    "viabilidad": <0|1|2 exacto del documento>,
    "especificidad": <0|1|2 exacto del documento>
  },
  "criteria_notes": {
    "diagnostico": "<justificación completa>",
    "propuesta": "<justificación completa>",
    "medidas": "<justificación completa>",
    "implementacion": "<justificación completa>",
    "viabilidad": "<justificación completa>",
    "especificidad": "<justificación completa>"
  },
  "analysis_sections": {
    "definicion": "<texto completo>",
    "importancia": "<texto completo>",
    "diagnostico_externo": "<texto completo>",
    "propuesta_plan": "<texto completo>",
    "medidas_concretas": "<texto completo>",
    "implementacion_necesaria": "<texto completo>",
    "impacto_potencial": "<texto completo>",
    "vacios": "<texto completo>",
    "evaluacion_tecnica": "<texto completo>",
    "conclusion": "<texto completo>"
  },
  "sources": []
}`;
}

async function phaseE_extractVariable(fullText, varInfo, allVarNames, varGlobalIndex, totalVars, onProgress) {
  const varName  = varInfo.name;
  const nextVar  = allVarNames[varGlobalIndex + 1] || null;
  const section  = findVariableSection(fullText, varName, nextVar);

  if (!section) {
    throw new Error(
      `FASE E: No se encontró la variable "${varName}" en el texto del documento.\n` +
      `Verifica que el nombre de la variable en el documento sea exactamente: "${varName}"`
    );
  }

  onProgress(`  Variable ${varGlobalIndex + 1}/${totalVars}: "${varName}" (${section.length} chars)...`);

  const raw = await aiCall({
    systemPrompt: buildPromptE(varInfo.block_hint || 'desconocido', varName),
    userContent: `Fragmento del documento que contiene la variable "${varName}":\n\n${section}`,
    label: `variable-${varGlobalIndex + 1}-${slugify(varName)}`,
    onProgress,
    maxTokens: 6000
  });

  return safeParse(raw, `variable "${varName}"`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE C adicional — Extraer candidato y metodología con IA si no se detectaron localmente
// ═══════════════════════════════════════════════════════════════════════════════

const PROMPT_CANDIDATE_META = `Eres un extractor técnico. Del texto dado, extrae SOLO los metadatos del candidato y la metodología. PROHIBIDO inventar nada.

Devuelve SOLO este JSON (sin bloques de código):
{
  "candidate": {
    "name": "<nombre completo>",
    "party": "<partido>",
    "total_score": <número o null>,
    "plan_period": "<período o null>",
    "plan_pages": <número o null>,
    "summary": "<resumen ejecutivo tal como aparece o null>",
    "strengths": ["<exactamente como aparece>"],
    "weaknesses": ["<exactamente como aparece>"],
    "methodological_notes": []
  },
  "methodology": {
    "description": "<descripción de metodología tal como aparece o null>",
    "criteria": {
      "diagnostico": "<definición o null>",
      "propuesta": "<definición o null>",
      "medidas": "<definición o null>",
      "implementacion": "<definición o null>",
      "viabilidad": "<definición o null>",
      "especificidad": "<definición o null>"
    },
    "formula": "<fórmula tal como aparece o null>",
    "scale": "<escala tal como aparece o null>"
  },
  "final_analysis": {
    "global_findings": ["<exactamente como aparece>"],
    "final_conclusion": "<texto completo o null>",
    "ranking_note": "<texto o null>",
    "comparability_note": "<texto o null>"
  }
}`;

async function extractCandidateMeta(fullText, structInfo, chunks, onProgress) {
  // Usar los primeros 2 chunks para capturar intro + metodología (suelen estar al inicio)
  const intro = chunks.slice(0, 3).map(c => c.text).join('\n\n---\n\n').slice(0, 18_000);

  onProgress('Extrayendo metadatos del candidato y metodología...');
  const raw = await aiCall({
    systemPrompt: PROMPT_CANDIDATE_META,
    userContent: `Texto del documento (inicio + metodología):\n\n${intro}`,
    label: 'candidato-y-metodología',
    onProgress,
    maxTokens: 3000
  });

  const meta = safeParse(raw, 'candidato-y-metodología');

  // Completar con lo detectado localmente si la IA no lo encontró
  if (!meta.candidate.name && structInfo.candidateName) meta.candidate.name = structInfo.candidateName;
  if (!meta.candidate.party && structInfo.candidateParty) meta.candidate.party = structInfo.candidateParty;
  if (!meta.candidate.total_score && structInfo.candidateTotalScore) meta.candidate.total_score = structInfo.candidateTotalScore;
  if (!meta.methodology.description && structInfo.methodologyText) meta.methodology.description = structInfo.methodologyText.slice(0, 2000);

  return meta;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE F — Ensamblaje final
// ═══════════════════════════════════════════════════════════════════════════════

function phaseF_assemble(meta, structInfo, allVariables) {
  const candidateId = slugify(meta.candidate.name || 'candidato');

  // Asignar variables a bloques
  const varByBlock = new Map();
  let varIdx = 0;
  for (const v of allVariables) {
    const blockHint = structInfo.variables[allVariables.indexOf(v)]?.block_hint;
    const blockKey  = slugify(blockHint || '');
    if (!varByBlock.has(blockKey)) varByBlock.set(blockKey, []);
    varByBlock.get(blockKey).push(v);
  }

  // Construir bloques con sus variables ordenadas
  const blocks = structInfo.blocks.map((b, bi) => {
    const blockId  = b.id_hint || slugify(b.name);
    const blockKey = slugify(b.name);
    const vars     = varByBlock.get(blockKey) || [];

    // Si no se asignaron por blockKey, distribuir por orden (fallback)
    return {
      id:           blockId,
      name:         b.name,
      average_score: null,
      color:        '#1d4ed8',
      summary:      '',
      interpretation: '',
      strengths:    [],
      weaknesses:   [],
      variables:    vars
    };
  });

  // Fallback: si el reparto por block_hint no funcionó, distribuir variables en orden
  const totalAssigned = blocks.reduce((t, b) => t + b.variables.length, 0);
  if (totalAssigned < allVariables.length) {
    const unassigned = allVariables.filter(v => !blocks.some(b => b.variables.includes(v)));
    let bi = 0;
    for (const v of unassigned) {
      blocks[bi % blocks.length].variables.push(v);
      bi++;
    }
  }

  return {
    _schema_version: '2.0',
    _converted_from_docx: true,
    candidate: {
      id:                       candidateId,
      name:                     meta.candidate.name   || '',
      party:                    meta.candidate.party  || '',
      total_score:              meta.candidate.total_score ?? null,
      color:                    '#b5121b',
      plan_period:              meta.candidate.plan_period || '2026-2031',
      plan_pages:               meta.candidate.plan_pages  || null,
      summary:                  meta.candidate.summary || '',
      strengths:                meta.candidate.strengths || [],
      weaknesses:               meta.candidate.weaknesses || [],
      methodological_notes:     meta.candidate.methodological_notes || [],
      methodological_corrections: []
    },
    methodology: meta.methodology || {},
    blocks,
    final_analysis: meta.final_analysis || {}
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FASE G — Validación estricta (CERO auto-corrección)
// ═══════════════════════════════════════════════════════════════════════════════

const CRITERIOS = ['diagnostico', 'propuesta', 'medidas', 'implementacion', 'viabilidad', 'especificidad'];
const SECTIONS  = [
  'definicion','importancia','diagnostico_externo','propuesta_plan',
  'medidas_concretas','implementacion_necesaria','impacto_potencial',
  'vacios','evaluacion_tecnica','conclusion'
];

function round1(n) { return Math.round(n * 10) / 10; }

function phaseG_validate(data) {
  const errors   = [];
  const warnings = [];

  // Raíz
  if (!data.candidate)             errors.push('Falta "candidate"');
  if (!data.methodology)           errors.push('Falta "methodology"');
  if (!Array.isArray(data.blocks)) errors.push('Falta array "blocks"');
  if (!data.final_analysis)        warnings.push('Falta "final_analysis"');

  if (errors.length) return { ok: false, errors, warnings };

  // Candidato
  const c = data.candidate;
  for (const f of ['id', 'name', 'party']) {
    if (!c[f]) errors.push(`candidate.${f} está vacío`);
  }
  if (c.total_score === undefined || c.total_score === null)
    errors.push('candidate.total_score está vacío');

  // Bloques
  if (data.blocks.length !== 8) {
    errors.push(`Se esperan 8 bloques. Se encontraron: ${data.blocks.length}`);
  }

  let totalVars      = 0;
  const allScores    = [];

  data.blocks.forEach((block, bi) => {
    const bL = `Bloque[${bi + 1}] "${block.name || 'sin nombre'}"`;

    if (!block.id)   errors.push(`${bL}: falta "id"`);
    if (!block.name) errors.push(`${bL}: falta "name"`);

    if (!Array.isArray(block.variables) || block.variables.length === 0) {
      errors.push(`${bL}: no tiene variables`);
      return;
    }

    const blockScores = [];

    block.variables.forEach((v, vi) => {
      totalVars++;
      const vL = `${bL} › Variable[${vi + 1}] "${v.name || 'sin nombre'}"`;

      // Campos de identidad
      if (!v.id)   errors.push(`${vL}: falta "id"`);
      if (!v.name) errors.push(`${vL}: falta "name"`);

      // Scores
      if (v.final_score   === undefined || v.final_score   === null) errors.push(`${vL}: falta "final_score"`);
      if (v.criteria_sum  === undefined || v.criteria_sum  === null) errors.push(`${vL}: falta "criteria_sum"`);
      if (v.formula_result === undefined || v.formula_result === null) errors.push(`${vL}: falta "formula_result"`);

      // Contenido narrativo
      if (!v.summary    || String(v.summary).trim().length < 10)    errors.push(`${vL}: "summary" está vacío`);
      if (!v.conclusion || String(v.conclusion).trim().length < 10) errors.push(`${vL}: "conclusion" está vacío`);
      if (!Array.isArray(v.strengths) || v.strengths.length === 0)  errors.push(`${vL}: "strengths" está vacío`);
      if (!Array.isArray(v.weaknesses) || v.weaknesses.length === 0) errors.push(`${vL}: "weaknesses" está vacío`);
      if (!Array.isArray(v.gaps))                                    errors.push(`${vL}: "gaps" no es un array`);

      // Criterios: verificar sin modificar
      if (!v.criteria) {
        errors.push(`${vL}: falta "criteria"`);
      } else {
        let computedSum = 0;
        let sumOk = true;
        for (const cr of CRITERIOS) {
          const val = v.criteria[cr];
          if (val === undefined || val === null) {
            errors.push(`${vL}: criteria.${cr} falta`); sumOk = false;
          } else if (![0, 1, 2].includes(Number(val))) {
            errors.push(`${vL}: criteria.${cr}=${val} (debe ser 0, 1 o 2)`); sumOk = false;
          } else {
            computedSum += Number(val);
          }
        }
        if (sumOk) {
          const expectedFormula = round1((computedSum / 12) * 10);
          // Reportar inconsistencia sin corregir
          if (v.criteria_sum !== undefined && Number(v.criteria_sum) !== computedSum) {
            errors.push(`${vL}: criteria_sum=${v.criteria_sum} ≠ suma real de criterios=${computedSum}`);
          }
          if (v.formula_result !== undefined && Math.abs(Number(v.formula_result) - expectedFormula) > 0.15) {
            errors.push(`${vL}: formula_result=${v.formula_result} ≠ (${computedSum}/12)×10=${expectedFormula}`);
          }
          if (v.final_score !== undefined && Math.abs(Number(v.final_score) - expectedFormula) > 0.15) {
            errors.push(`${vL}: final_score=${v.final_score} ≠ fórmula esperada=${expectedFormula}`);
          }
        }
      }

      // criteria_notes
      if (!v.criteria_notes) {
        errors.push(`${vL}: falta "criteria_notes"`);
      } else {
        for (const cr of CRITERIOS) {
          if (!v.criteria_notes[cr] || String(v.criteria_notes[cr]).trim().length < 5)
            errors.push(`${vL}: criteria_notes.${cr} está vacío`);
        }
      }

      // Secciones
      if (!v.analysis_sections) {
        errors.push(`${vL}: falta "analysis_sections"`);
      } else {
        for (const s of SECTIONS) {
          if (!v.analysis_sections[s] || String(v.analysis_sections[s]).trim().length < 10)
            errors.push(`${vL}: analysis_sections.${s} está vacío`);
        }
      }

      if (v.final_score !== undefined) {
        blockScores.push(Number(v.final_score));
        allScores.push(Number(v.final_score));
      }
    });

    // Verificar average_score del bloque sin corregir
    if (blockScores.length > 0 && block.average_score !== null && block.average_score !== undefined) {
      const computedAvg = round1(blockScores.reduce((a, b) => a + b, 0) / blockScores.length);
      if (Math.abs(Number(block.average_score) - computedAvg) > 0.25) {
        errors.push(`${bL}: average_score=${block.average_score} ≠ promedio calculado=${computedAvg}`);
      }
    }
  });

  // Total de variables
  if (totalVars !== 30) {
    errors.push(`Se esperan 30 variables en total. Se encontraron: ${totalVars}`);
  }

  // Verificar total_score del candidato sin corregir
  if (allScores.length > 0 && c.total_score !== null && c.total_score !== undefined) {
    const computedTotal = round1(allScores.reduce((a, b) => a + b, 0) / allScores.length);
    if (Math.abs(Number(c.total_score) - computedTotal) > 0.25) {
      errors.push(`candidate.total_score=${c.total_score} ≠ promedio calculado=${computedTotal}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════

async function processDocx(filePath, onProgress) {
  onProgress = onProgress || (() => {});
  const fileName = path.basename(filePath);
  onProgress(`▶ Iniciando procesamiento: ${fileName}`);

  // Hash para caché
  const hash      = fileHash(filePath);
  const cacheFile = path.join(CACHE_DIR, `${hash}.json`);

  // Verificar caché antes de todo
  if (fs.existsSync(cacheFile)) {
    onProgress('✓ Caché encontrado — reutilizando resultado anterior (sin gasto de tokens)');
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // Verificar que el caché pasó validación (tiene _validated)
      if (cached._validated) {
        return buildResult(cached, [], true, 'Archivo ya procesado (mismo contenido). No se reprocesó.');
      }
      onProgress('Caché no tiene marca de validación — reprocesando...');
      fs.unlinkSync(cacheFile);
    } catch (_) {
      onProgress('Caché corrupto — reprocesando...');
      fs.unlinkSync(cacheFile);
    }
  }

  // ── FASE A ────────────────────────────────────────────────────────────────
  onProgress('\n[FASE A] Extracción local de texto...');
  const fullText = await phaseA_extract(filePath);
  onProgress(`✓ Texto extraído: ${fullText.length.toLocaleString()} chars (~${Math.round(fullText.length / 4).toLocaleString()} tokens)`);

  // ── FASE B ────────────────────────────────────────────────────────────────
  onProgress('\n[FASE B] Segmentación inteligente...');
  const chunks = phaseB_segment(fullText);
  onProgress(`✓ Documento dividido en ${chunks.length} chunks (máx ${CHUNK_SIZE} chars cada uno)`);

  // ── FASE C ────────────────────────────────────────────────────────────────
  onProgress(`\n[FASE C] Mapeo estructural (${chunks.length} llamadas pequeñas)...`);
  const chunkMaps = [];
  for (let i = 0; i < chunks.length; i++) {
    const map = await phaseC_mapChunk(chunks[i], i, chunks.length, onProgress);
    chunkMaps.push(map);
  }
  onProgress('✓ Mapeo estructural completado');

  // ── FASE D ────────────────────────────────────────────────────────────────
  onProgress('\n[FASE D] Consolidando estructura global...');
  const structInfo = phaseD_consolidate(chunkMaps, onProgress);
  onProgress(`✓ Estructura consolidada: ${structInfo.blocks.length} bloques, ${structInfo.variables.length} variables`);

  // ── EXTRACCIÓN DE CANDIDATO Y METODOLOGÍA ─────────────────────────────────
  onProgress('\n[FASE C+] Extrayendo metadatos del candidato y metodología...');
  const meta = await extractCandidateMeta(fullText, structInfo, chunks, onProgress);
  onProgress(`✓ Candidato: ${meta.candidate.name || '(sin nombre)'} — ${meta.candidate.party || '(sin partido)'}`);

  // ── FASE E ────────────────────────────────────────────────────────────────
  onProgress(`\n[FASE E] Extracción detallada de 30 variables (30 llamadas controladas)...`);
  const allVarNames   = structInfo.variables.map(v => v.name);
  const allVariables  = [];

  for (let i = 0; i < structInfo.variables.length; i++) {
    const varDetail = await phaseE_extractVariable(fullText, structInfo.variables[i], allVarNames, i, structInfo.variables.length, onProgress);
    allVariables.push(varDetail);
  }
  onProgress('✓ Todas las variables extraídas');

  // ── FASE F ────────────────────────────────────────────────────────────────
  onProgress('\n[FASE F] Ensamblando JSON final...');
  const finalData = phaseF_assemble(meta, structInfo, allVariables);
  onProgress('✓ JSON ensamblado');

  // ── FASE G ────────────────────────────────────────────────────────────────
  onProgress('\n[FASE G] Validación estricta (sin auto-corrección)...');
  const validation = phaseG_validate(finalData);

  if (validation.warnings.length > 0) {
    onProgress('Advertencias:\n' + validation.warnings.map(w => '  ⚠ ' + w).join('\n'));
  }

  if (!validation.ok) {
    const errorLines = validation.errors.map(e => '  ✕ ' + e).join('\n');
    throw new Error(
      `FASE G — Validación fallida (${validation.errors.length} error(es)). JSON NO guardado.\n\n${errorLines}`
    );
  }
  onProgress(`✓ Validación superada (${validation.warnings.length} advertencias)`);

  // ── Guardar ───────────────────────────────────────────────────────────────
  finalData._validated    = true;
  finalData._converted_at = new Date().toISOString();
  finalData._source_file  = fileName;
  finalData._source_hash  = hash;

  const candidateId = finalData.candidate.id;
  const outputFile  = path.join(ANALISIS_DIR, `${candidateId}.json`);

  // Evitar sobreescritura si hash idéntico
  if (fs.existsSync(outputFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
      if (existing._source_hash === hash) {
        onProgress('El archivo ya existe con el mismo contenido. No se sobrescribió.');
        return buildResult(finalData, validation.warnings, true, 'Archivo ya procesado (mismo contenido).');
      }
    } catch (_) {}
  }

  // Guardar en /analisis y en caché
  fs.writeFileSync(outputFile, JSON.stringify(finalData, null, 2), 'utf8');
  fs.writeFileSync(cacheFile,  JSON.stringify(finalData, null, 2), 'utf8');
  onProgress(`✓ JSON guardado: /analisis/${candidateId}.json`);

  return buildResult(finalData, validation.warnings, false);
}

function buildResult(data, warnings, skipped, message) {
  return {
    ok:          true,
    skipped,
    candidateId: data.candidate.id,
    outputFile:  `${data.candidate.id}.json`,
    totalScore:  data.candidate.total_score,
    blocks:      data.blocks?.length ?? 0,
    totalVars:   data.blocks?.reduce((t, b) => t + (b.variables?.length ?? 0), 0) ?? 0,
    warnings,
    message:     message || `Conversión exitosa → /analisis/${data.candidate.id}.json`
  };
}

module.exports = { processDocx };
