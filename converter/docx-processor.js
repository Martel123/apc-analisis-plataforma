'use strict';

/**
 * DOCX → JSON Processor v4 — Una variable = una unidad mínima
 *
 * GARANTÍAS:
 *  1. Ninguna llamada a IA recibe el documento completo
 *  2. Phase C output: SOLO nombres (máx 300 tokens → nunca trunca)
 *  3. Phase E: una variable por llamada, salida dividida en 2 llamadas atómicas
 *     para que nunca exceda límites de output
 *  4. Retry con backoff en 429. Truncamiento detectado → reintento con menos texto
 *  5. CERO modificación de puntajes ni promedios
 *  6. CERO invención de contenido
 *  7. Si validación falla → JSON NO se guarda
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

// ── Parámetros ────────────────────────────────────────────────────────────────
const CHUNK_SIZE     = 5_000;   // chars por chunk en Phase C ≈ 1 250 tokens input
const VAR_WINDOW_MAX = 5_500;   // chars máximos enviados por variable en Phase E
const CALL_DELAY_MS  = 700;     // pausa entre llamadas (TPM)
const MAX_RETRIES    = 5;       // reintentos en 429

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function fileHash(fp) {
  return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
}

function stripCodeFence(s) {
  return s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
}

function tryParse(raw, label) {
  const clean = stripCodeFence(raw);
  try { return { ok: true, data: JSON.parse(clean) }; }
  catch (e) { return { ok: false, error: e.message, fragment: clean.slice(-200) }; }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Llamada a IA con backoff ─────────────────────────────────────────────────

async function aiCall({ system, user, label, maxOut, onProgress }) {
  await sleep(CALL_DELAY_MS);
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await openai.chat.completions.create({
        model:       'gpt-4o-mini',
        temperature: 0,
        max_tokens:  maxOut,
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user   }
        ]
      });
      const finish = resp.choices[0].finish_reason;
      const text   = resp.choices[0].message.content.trim();
      return { raw: text, truncated: finish === 'length' };

    } catch (err) {
      const code = err?.status ?? err?.response?.status;
      if ((code === 429 || code === 503) && attempt < MAX_RETRIES) {
        const wait = attempt * 30_000;
        onProgress(`⚠ Rate limit (${code}) en "${label}". Esperando ${wait / 1000}s (${attempt}/${MAX_RETRIES})...`);
        await sleep(wait);
      } else {
        throw new Error(`Error de API en "${label}" [${code}]: ${err.message}`);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 1 — Extracción local completa (sin IA)
// ══════════════════════════════════════════════════════════════════════════════

async function fase1_extract(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  const text   = (result.value || '').trim();
  if (text.length < 300) throw new Error('FASE 1: Documento vacío o ilegible (< 300 chars extraídos).');
  return text;
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 2 — Detección global por chunks PEQUEÑOS (output: solo nombres)
// ══════════════════════════════════════════════════════════════════════════════

// El output aquí es intencionalmente mínimo: solo strings con nombres.
// maxOut: 400 tokens → NUNCA trunca.
const SYS_DETECT = `Eres un detector de estructura documental. Extrae SOLO los nombres explícitos que aparecen en el fragmento. PROHIBIDO inventar o inferir.

Devuelve SOLO este JSON (sin bloques de código, sin texto adicional):
{"candidate_name":null,"candidate_party":null,"blocks":[],"variables":[{"name":"<nombre exacto>","block":"<nombre del bloque al que pertenece>"}]}

- "blocks": lista de strings con los nombres exactos de bloques encontrados en el fragmento.
- "variables": lista de objetos con el nombre exacto de cada variable encontrada y el bloque al que pertenece (si está claro).
- "candidate_name" y "candidate_party": null si no aparecen en este fragmento.
- Si no encuentras nada, devuelve los arrays vacíos.`;

function segmentText(text, chunkSize) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, Math.min(i + chunkSize, text.length)));
  }
  return chunks;
}

async function fase2_detectStructure(fullText, onProgress) {
  const chunks = segmentText(fullText, CHUNK_SIZE);
  onProgress(`FASE 2: ${chunks.length} chunks de ~${CHUNK_SIZE} chars — detectando estructura...`);

  let candidateName  = null;
  let candidateParty = null;
  const blockSet    = new Map();  // slug → name
  const variableMap = new Map();  // slug → {name, block}

  for (let i = 0; i < chunks.length; i++) {
    onProgress(`  Chunk ${i + 1}/${chunks.length}...`);
    const { raw, truncated } = await aiCall({
      system: SYS_DETECT,
      user:   `Fragmento:\n\n${chunks[i]}`,
      label:  `detect-chunk-${i + 1}`,
      maxOut: 400,
      onProgress
    });

    if (truncated) {
      // Output de 400 tokens truncado significa un bug en el prompt — saltamos el chunk
      onProgress(`  ⚠ Chunk ${i + 1}: output truncado (ignorado)`);
      continue;
    }

    const parsed = tryParse(raw, `detect-chunk-${i + 1}`);
    if (!parsed.ok) { onProgress(`  ⚠ Chunk ${i + 1}: JSON inválido (ignorado)`); continue; }

    const m = parsed.data;
    if (!candidateName  && m.candidate_name)  candidateName  = m.candidate_name;
    if (!candidateParty && m.candidate_party) candidateParty = m.candidate_party;

    for (const b of (m.blocks || [])) {
      const k = slugify(b);
      if (!blockSet.has(k)) blockSet.set(k, b);
    }
    for (const v of (m.variables || [])) {
      const k = slugify(v.name);
      if (!variableMap.has(k)) variableMap.set(k, v);
    }
  }

  const blocks    = [...blockSet.values()];
  const variables = [...variableMap.values()];

  onProgress(`  Candidato: ${candidateName || '(no detectado)'}`);
  onProgress(`  Bloques detectados: ${blocks.length}`);
  onProgress(`  Variables detectadas: ${variables.length}`);

  if (blocks.length !== 8) {
    throw new Error(
      `FASE 2 ERROR: Se detectaron ${blocks.length} bloques (se esperan 8).\n` +
      `Bloques encontrados:\n${blocks.length ? blocks.map(b => '  · ' + b).join('\n') : '  (ninguno)'}\n\n` +
      `Verifica que los encabezados de bloques sean claros y explícitos en el documento.`
    );
  }
  if (variables.length !== 30) {
    throw new Error(
      `FASE 2 ERROR: Se detectaron ${variables.length} variables (se esperan 30).\n` +
      `Variables encontradas:\n${variables.length ? variables.map(v => '  · ' + v.name).join('\n') : '  (ninguna)'}\n\n` +
      `Verifica que los encabezados de variables sean claros y explícitos en el documento.`
    );
  }

  return { candidateName, candidateParty, blocks, variables };
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 3 — Indexación de texto por variable (sin IA)
// ══════════════════════════════════════════════════════════════════════════════

function fase3_indexVariables(fullText, variables) {
  const indexed = [];
  const escapedNames = variables.map(v => ({
    ...v,
    re: new RegExp(v.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }));

  for (let i = 0; i < escapedNames.length; i++) {
    const { re, name, block } = escapedNames[i];
    const match = re.exec(fullText);
    if (!match) {
      indexed.push({ name, block, text: '', found: false });
      continue;
    }

    const start = Math.max(0, match.index - 100);

    // El fin es el inicio de la siguiente variable detectada (o máx VAR_WINDOW_MAX chars)
    let end = start + VAR_WINDOW_MAX;
    for (let j = i + 1; j < escapedNames.length; j++) {
      const m2 = escapedNames[j].re.exec(fullText);
      if (m2 && m2.index > match.index && m2.index < end) {
        end = m2.index;
        break;
      }
    }

    const text = fullText.slice(start, Math.min(end, fullText.length));
    indexed.push({ name, block, text, found: true });
  }

  const notFound = indexed.filter(v => !v.found);
  if (notFound.length > 0) {
    throw new Error(
      `FASE 3 ERROR: No se encontraron en el texto las siguientes variables:\n` +
      notFound.map(v => '  · ' + v.name).join('\n') + '\n\n' +
      `Verifica que los nombres detectados en Fase 2 coincidan con los del documento.`
    );
  }

  return indexed;
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 4 — Extracción detallada por variable (2 llamadas atómicas)
// ══════════════════════════════════════════════════════════════════════════════

// Llamada A: datos estructurados (scores, criteria, summary, etc.)
// Output máximo estimado: ~700 tokens → maxOut: 1200 (holgura amplia)
const SYS_VAR_SCORES = (blockName, varName) => `Eres un extractor técnico estricto. Extrae EXACTAMENTE como aparece en el fragmento. PROHIBIDO inventar o modificar valores.

Extrae del fragmento los datos estructurados de la variable "${varName}" del bloque "${blockName}".

Devuelve SOLO este JSON (sin bloques de código):
{
  "id":"<slug>","name":"${varName}",
  "final_score":<número exacto o null>,
  "criteria_sum":<número exacto o null>,
  "formula_result":<número exacto o null>,
  "summary":"<texto completo>",
  "strengths":["<exacto>"],
  "weaknesses":["<exacto>"],
  "gaps":["<exacto>"],
  "conclusion":"<texto completo>",
  "corrected_methodology":false,"correction_note":"",
  "criteria":{"diagnostico":<0|1|2|null>,"propuesta":<0|1|2|null>,"medidas":<0|1|2|null>,"implementacion":<0|1|2|null>,"viabilidad":<0|1|2|null>,"especificidad":<0|1|2|null>},
  "criteria_notes":{"diagnostico":"<justificación>","propuesta":"<justificación>","medidas":"<justificación>","implementacion":"<justificación>","viabilidad":"<justificación>","especificidad":"<justificación>"},
  "sources":[]
}`;

// Llamada B: secciones narrativas (10 secciones)
// Cada sección puede ser larga, por eso va en llamada separada
// Output máximo: 10 secciones × ~300 tokens = ~3000 tokens → maxOut: 4000 (holgura)
const SYS_VAR_SECTIONS = (varName) => `Eres un extractor técnico estricto. Copia el texto EXACTAMENTE como aparece en el fragmento. PROHIBIDO resumir, reescribir o inventar.

Extrae del fragmento las 10 secciones narrativas de la variable "${varName}".

Si una sección no aparece en el fragmento, usa "" (cadena vacía). NO inventes nada.

Devuelve SOLO este JSON (sin bloques de código):
{
  "definicion":"<texto completo>",
  "importancia":"<texto completo>",
  "diagnostico_externo":"<texto completo>",
  "propuesta_plan":"<texto completo>",
  "medidas_concretas":"<texto completo>",
  "implementacion_necesaria":"<texto completo>",
  "impacto_potencial":"<texto completo>",
  "vacios":"<texto completo>",
  "evaluacion_tecnica":"<texto completo>",
  "conclusion":"<texto completo>"
}`;

async function fase4_extractVariable(varIndexed, blockName, varIndex, total, onProgress) {
  const { name, text } = varIndexed;
  onProgress(`  Variable ${varIndex + 1}/${total}: "${name}" (${text.length} chars)...`);

  // ── Llamada A: datos estructurados ────────────────────────────────────────
  const respA = await aiCall({
    system: SYS_VAR_SCORES(blockName, name),
    user:   `Fragmento de la variable "${name}":\n\n${text}`,
    label:  `var-scores-${varIndex + 1}`,
    maxOut: 1200,
    onProgress
  });

  if (respA.truncated) {
    throw new Error(
      `FASE 4: Truncamiento en datos estructurados de "${name}". ` +
      `Fragmento recibido (final):\n${respA.raw.slice(-300)}`
    );
  }

  const parsedA = tryParse(respA.raw, `var-scores-${name}`);
  if (!parsedA.ok) {
    throw new Error(`FASE 4: JSON inválido en datos de "${name}": ${parsedA.error}`);
  }

  // ── Llamada B: secciones narrativas ───────────────────────────────────────
  const respB = await aiCall({
    system: SYS_VAR_SECTIONS(name),
    user:   `Fragmento de la variable "${name}":\n\n${text}`,
    label:  `var-sections-${varIndex + 1}`,
    maxOut: 4000,
    onProgress
  });

  // Si la llamada B está truncada → reintentar con la mitad del texto
  let parsedB;
  if (respB.truncated) {
    onProgress(`  ⚠ "${name}": secciones truncadas. Reintentando con menos texto...`);
    const halfText = text.slice(0, Math.floor(text.length / 2));
    const respB2 = await aiCall({
      system: SYS_VAR_SECTIONS(name),
      user:   `Fragmento de la variable "${name}" (parte 1/2):\n\n${halfText}`,
      label:  `var-sections-${varIndex + 1}-retry`,
      maxOut: 4000,
      onProgress
    });
    if (respB2.truncated) {
      throw new Error(`FASE 4: Secciones narrativas de "${name}" siguen truncadas tras reintento. El documento puede tener un formato inesperado.`);
    }
    parsedB = tryParse(respB2.raw, `var-sections-retry-${name}`);
  } else {
    parsedB = tryParse(respB.raw, `var-sections-${name}`);
  }

  if (!parsedB.ok) {
    throw new Error(`FASE 4: JSON inválido en secciones de "${name}": ${parsedB.error}`);
  }

  // ── Fusionar A + B ─────────────────────────────────────────────────────────
  const varJson = { ...parsedA.data, analysis_sections: parsedB.data };
  varJson.id = varJson.id || slugify(name);
  return varJson;
}

// ══════════════════════════════════════════════════════════════════════════════
// EXTRACCIÓN DE CANDIDATO Y METODOLOGÍA (2 llamadas, primer 10% del doc)
// ══════════════════════════════════════════════════════════════════════════════

const SYS_META = `Eres un extractor técnico. Extrae EXACTAMENTE lo que aparece en el texto. PROHIBIDO inventar.

Devuelve SOLO este JSON (sin bloques de código):
{
  "candidate":{"name":"<nombre>","party":"<partido>","total_score":<número|null>,"plan_period":"<período|null>","plan_pages":<número|null>,"summary":"<resumen|null>","strengths":[],"weaknesses":[],"methodological_notes":[]},
  "methodology":{"description":"<descripción|null>","criteria":{"diagnostico":"<def|null>","propuesta":"<def|null>","medidas":"<def|null>","implementacion":"<def|null>","viabilidad":"<def|null>","especificidad":"<def|null>"},"formula":"<fórmula|null>","scale":"<escala|null>"},
  "final_analysis":{"global_findings":[],"final_conclusion":"<texto|null>","ranking_note":"<texto|null>","comparability_note":"<texto|null>"}
}`;

async function extractMeta(fullText, structInfo, onProgress) {
  onProgress('Extrayendo metadatos del candidato y metodología...');
  // Usar el primer 12% del texto (suele contener introducción + metodología)
  const intro = fullText.slice(0, Math.min(Math.floor(fullText.length * 0.12), 5000));

  const resp = await aiCall({
    system: SYS_META,
    user:   `Texto del documento (inicio + metodología):\n\n${intro}`,
    label:  'metadatos-candidato',
    maxOut: 1500,
    onProgress
  });

  if (resp.truncated) {
    throw new Error('Metadatos del candidato truncados. Verifica el inicio del documento.');
  }

  const parsed = tryParse(resp.raw, 'metadatos-candidato');
  if (!parsed.ok) {
    throw new Error(`Metadatos del candidato con JSON inválido: ${parsed.error}`);
  }

  const meta = parsed.data;
  // Complementar con lo detectado en Fase 2
  if (!meta.candidate.name  && structInfo.candidateName)  meta.candidate.name  = structInfo.candidateName;
  if (!meta.candidate.party && structInfo.candidateParty) meta.candidate.party = structInfo.candidateParty;

  return meta;
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 5 — Ensamblaje final (sin IA)
// ══════════════════════════════════════════════════════════════════════════════

function fase5_assemble(meta, structInfo, allVars) {
  const candidateId = slugify(meta.candidate.name || 'candidato');

  // Asignar variables a bloques usando block_hint
  const blockSlugMap = new Map(structInfo.blocks.map(b => [slugify(b), b]));
  const varByBlock   = new Map(structInfo.blocks.map(b => [slugify(b), []]));

  const unassigned = [];
  for (const v of allVars) {
    const indexedInfo = structInfo.variables.find(x => slugify(x.name) === slugify(v.name));
    const bSlug = slugify(indexedInfo?.block || '');
    if (varByBlock.has(bSlug)) {
      varByBlock.get(bSlug).push(v);
    } else {
      unassigned.push(v);
    }
  }

  // Distribuir variables no asignadas en orden
  if (unassigned.length > 0) {
    for (const [bSlug, arr] of varByBlock.entries()) {
      while (unassigned.length > 0 && arr.length < 4) {
        arr.push(unassigned.shift());
      }
    }
    // Si quedan, repartir equitativamente
    for (const v of unassigned) {
      const smallest = [...varByBlock.entries()].sort((a, b) => a[1].length - b[1].length)[0];
      smallest[1].push(v);
    }
  }

  const blocks = structInfo.blocks.map(bName => ({
    id:           slugify(bName),
    name:         bName,
    average_score: null,
    color:        '#1d4ed8',
    summary:      '',
    interpretation: '',
    strengths:    [],
    weaknesses:   [],
    variables:    varByBlock.get(slugify(bName)) || []
  }));

  return {
    _schema_version: '2.0',
    _converted_from_docx: true,
    candidate: {
      id:                     candidateId,
      name:                   meta.candidate.name   || '',
      party:                  meta.candidate.party  || '',
      total_score:            meta.candidate.total_score   ?? null,
      color:                  '#b5121b',
      plan_period:            meta.candidate.plan_period   || '2026-2031',
      plan_pages:             meta.candidate.plan_pages    || null,
      summary:                meta.candidate.summary       || '',
      strengths:              meta.candidate.strengths     || [],
      weaknesses:             meta.candidate.weaknesses    || [],
      methodological_notes:   meta.candidate.methodological_notes || [],
      methodological_corrections: []
    },
    methodology:    meta.methodology    || {},
    blocks,
    final_analysis: meta.final_analysis || {}
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 6 — Validación estricta (CERO auto-corrección)
// ══════════════════════════════════════════════════════════════════════════════

const CRITERIOS = ['diagnostico','propuesta','medidas','implementacion','viabilidad','especificidad'];
const SECTIONS  = ['definicion','importancia','diagnostico_externo','propuesta_plan','medidas_concretas','implementacion_necesaria','impacto_potencial','vacios','evaluacion_tecnica','conclusion'];

function round1(n) { return Math.round(n * 10) / 10; }

function fase6_validate(data) {
  const errors = [], warnings = [];

  if (!data.candidate)             errors.push('Falta "candidate"');
  if (!data.methodology)           errors.push('Falta "methodology"');
  if (!Array.isArray(data.blocks)) errors.push('Falta array "blocks"');
  if (!data.final_analysis)        warnings.push('Falta "final_analysis"');

  if (errors.length) return { ok: false, errors, warnings };

  const c = data.candidate;
  for (const f of ['id','name','party']) {
    if (!c[f]) errors.push(`candidate.${f} vacío`);
  }
  if (c.total_score === undefined || c.total_score === null)
    errors.push('candidate.total_score vacío');

  if (data.blocks.length !== 8)
    errors.push(`Se esperan 8 bloques, hay ${data.blocks.length}`);

  let totalVars = 0;
  const allScores = [];

  data.blocks.forEach((block, bi) => {
    const bL = `Bloque[${bi + 1}] "${block.name || ''}"`;
    if (!block.id)   errors.push(`${bL}: falta id`);
    if (!block.name) errors.push(`${bL}: falta name`);
    if (!Array.isArray(block.variables) || block.variables.length === 0) {
      errors.push(`${bL}: sin variables`); return;
    }

    const bScores = [];
    block.variables.forEach((v, vi) => {
      totalVars++;
      const vL = `${bL} › Var[${vi + 1}] "${v.name || ''}"`;

      if (!v.id)   errors.push(`${vL}: falta id`);
      if (!v.name) errors.push(`${vL}: falta name`);
      if (v.final_score   == null) errors.push(`${vL}: falta final_score`);
      if (v.criteria_sum  == null) errors.push(`${vL}: falta criteria_sum`);
      if (v.formula_result == null) errors.push(`${vL}: falta formula_result`);
      if (!v.summary   || String(v.summary).trim().length < 5)   errors.push(`${vL}: summary vacío`);
      if (!v.conclusion || String(v.conclusion).trim().length < 5) errors.push(`${vL}: conclusion vacío`);
      if (!Array.isArray(v.strengths) || !v.strengths.length)  errors.push(`${vL}: strengths vacío`);
      if (!Array.isArray(v.weaknesses) || !v.weaknesses.length) errors.push(`${vL}: weaknesses vacío`);
      if (!Array.isArray(v.gaps))                               errors.push(`${vL}: gaps no es array`);

      if (!v.criteria) {
        errors.push(`${vL}: falta criteria`);
      } else {
        let csum = 0; let sumOk = true;
        for (const cr of CRITERIOS) {
          const val = v.criteria[cr];
          if (val == null) { errors.push(`${vL}: criteria.${cr} falta`); sumOk = false; }
          else if (![0,1,2].includes(Number(val))) { errors.push(`${vL}: criteria.${cr}=${val} (debe ser 0,1,2)`); sumOk = false; }
          else csum += Number(val);
        }
        if (sumOk) {
          const exp = round1((csum / 12) * 10);
          if (v.criteria_sum != null && Number(v.criteria_sum) !== csum)
            errors.push(`${vL}: criteria_sum=${v.criteria_sum} ≠ suma real=${csum}`);
          if (v.formula_result != null && Math.abs(Number(v.formula_result) - exp) > 0.15)
            errors.push(`${vL}: formula_result=${v.formula_result} ≠ esperado=${exp}`);
          if (v.final_score != null && Math.abs(Number(v.final_score) - exp) > 0.15)
            errors.push(`${vL}: final_score=${v.final_score} ≠ esperado=${exp}`);
        }
      }

      if (!v.criteria_notes) {
        errors.push(`${vL}: falta criteria_notes`);
      } else {
        for (const cr of CRITERIOS) {
          if (!v.criteria_notes[cr] || String(v.criteria_notes[cr]).trim().length < 5)
            errors.push(`${vL}: criteria_notes.${cr} vacío`);
        }
      }

      if (!v.analysis_sections) {
        errors.push(`${vL}: falta analysis_sections`);
      } else {
        for (const s of SECTIONS) {
          if (!v.analysis_sections[s] || String(v.analysis_sections[s]).trim().length < 5)
            errors.push(`${vL}: analysis_sections.${s} vacío`);
        }
      }

      if (v.final_score != null) { bScores.push(Number(v.final_score)); allScores.push(Number(v.final_score)); }
    });

    if (bScores.length && block.average_score != null) {
      const avg = round1(bScores.reduce((a,b) => a+b,0) / bScores.length);
      if (Math.abs(Number(block.average_score) - avg) > 0.25)
        errors.push(`${bL}: average_score=${block.average_score} ≠ calculado=${avg}`);
    }
  });

  if (totalVars !== 30) errors.push(`Se esperan 30 variables, hay ${totalVars}`);

  if (allScores.length && c.total_score != null) {
    const tot = round1(allScores.reduce((a,b) => a+b,0) / allScores.length);
    if (Math.abs(Number(c.total_score) - tot) > 0.25)
      errors.push(`candidate.total_score=${c.total_score} ≠ calculado=${tot}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ══════════════════════════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════════

async function processDocx(filePath, onProgress) {
  onProgress = onProgress || (() => {});
  const fileName = path.basename(filePath);
  onProgress(`▶ Procesando: ${fileName}`);

  // Caché
  const hash      = fileHash(filePath);
  const cacheFile = path.join(CACHE_DIR, `${hash}.json`);

  if (fs.existsSync(cacheFile)) {
    onProgress('✓ Caché encontrado (sin gasto de tokens)');
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached._validated) {
        return buildResult(cached, [], true, 'Ya procesado — reutilizando resultado anterior.');
      }
      onProgress('Caché sin validación — reprocesando...');
      fs.unlinkSync(cacheFile);
    } catch (_) { fs.unlinkSync(cacheFile); }
  }

  // ── FASE 1 ────────────────────────────────────────────────────────────────
  onProgress('\n[FASE 1] Extracción local del documento...');
  const fullText = await fase1_extract(filePath);
  onProgress(`✓ ${fullText.length.toLocaleString()} chars (~${Math.round(fullText.length/4).toLocaleString()} tokens)`);

  // ── FASE 2 ────────────────────────────────────────────────────────────────
  onProgress('\n[FASE 2] Detección de estructura (chunks de 5 000 chars, output mínimo)...');
  const structInfo = await fase2_detectStructure(fullText, onProgress);
  onProgress(`✓ 8 bloques · 30 variables detectadas`);

  // ── EXTRACCIÓN DE METADATOS ───────────────────────────────────────────────
  onProgress('\n[META] Extrayendo candidato y metodología...');
  const meta = await extractMeta(fullText, structInfo, onProgress);
  onProgress(`✓ Candidato: ${meta.candidate.name || '(sin nombre)'} — ${meta.candidate.party || '(sin partido)'}`);

  // ── FASE 3 ────────────────────────────────────────────────────────────────
  onProgress('\n[FASE 3] Indexando texto por variable (sin IA)...');
  const indexedVars = fase3_indexVariables(fullText, structInfo.variables);
  onProgress(`✓ ${indexedVars.length} variables indexadas`);

  // ── FASE 4 ────────────────────────────────────────────────────────────────
  const totalCalls = structInfo.variables.length * 2;
  onProgress(`\n[FASE 4] Extracción detallada — 30 variables × 2 llamadas atómicas = ${totalCalls} llamadas controladas...`);

  const allVars = [];
  for (let i = 0; i < indexedVars.length; i++) {
    const varInfo = indexedVars[i];
    const blockName = varInfo.block || structInfo.blocks[Math.floor(i / (30 / 8))] || 'desconocido';
    const extracted = await fase4_extractVariable(varInfo, blockName, i, indexedVars.length, onProgress);
    allVars.push(extracted);
  }
  onProgress('✓ Todas las variables extraídas');

  // ── FASE 5 ────────────────────────────────────────────────────────────────
  onProgress('\n[FASE 5] Ensamblando JSON final...');
  const finalData = fase5_assemble(meta, structInfo, allVars);
  onProgress('✓ JSON ensamblado');

  // ── FASE 6 ────────────────────────────────────────────────────────────────
  onProgress('\n[FASE 6] Validación estricta (sin auto-corrección)...');
  const v = fase6_validate(finalData);
  if (v.warnings.length) onProgress('Advertencias:\n' + v.warnings.map(w => '  ⚠ ' + w).join('\n'));

  if (!v.ok) {
    throw new Error(
      `FASE 6 — Validación fallida (${v.errors.length} error(es)). JSON NO guardado.\n\n` +
      v.errors.map(e => '  ✕ ' + e).join('\n')
    );
  }
  onProgress(`✓ Validación superada`);

  // ── Guardar ───────────────────────────────────────────────────────────────
  finalData._validated    = true;
  finalData._converted_at = new Date().toISOString();
  finalData._source_file  = fileName;
  finalData._source_hash  = hash;

  const cId = finalData.candidate.id;
  const out  = path.join(ANALISIS_DIR, `${cId}.json`);

  if (fs.existsSync(out)) {
    try {
      const ex = JSON.parse(fs.readFileSync(out, 'utf8'));
      if (ex._source_hash === hash) {
        onProgress('Ya existe con el mismo contenido. No se sobrescribió.');
        return buildResult(finalData, v.warnings, true, 'Contenido idéntico — no reprocesado.');
      }
    } catch (_) {}
  }

  fs.writeFileSync(out,       JSON.stringify(finalData, null, 2), 'utf8');
  fs.writeFileSync(cacheFile, JSON.stringify(finalData, null, 2), 'utf8');
  onProgress(`✓ Guardado: /analisis/${cId}.json`);

  return buildResult(finalData, v.warnings, false);
}

function buildResult(data, warnings, skipped, message) {
  return {
    ok: true, skipped,
    candidateId: data.candidate.id,
    outputFile:  `${data.candidate.id}.json`,
    totalScore:  data.candidate.total_score,
    blocks:      data.blocks?.length ?? 0,
    totalVars:   data.blocks?.reduce((t,b) => t + (b.variables?.length ?? 0), 0) ?? 0,
    warnings,
    message: message || `Conversión exitosa → /analisis/${data.candidate.id}.json`
  };
}

module.exports = { processDocx };
