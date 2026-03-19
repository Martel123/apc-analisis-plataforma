'use strict';

/**
 * DOCX → JSON Processor v2 — Producción
 *
 * GARANTÍAS:
 *  - Texto completo extraído sin truncar (mammoth)
 *  - Procesamiento por bloques: cada bloque se extrae en su propia llamada
 *    para evitar truncamiento de salida (GPT-4o: máx 16 384 tokens output)
 *  - CERO auto-corrección de puntajes ni promedios
 *  - CERO invención de contenido
 *  - Validación estricta antes de guardar
 *  - Caché por hash: documentos ya procesados no se reprocesarán
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function cleanJsonResponse(raw) {
  return raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function safeParseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`JSON inválido en "${label}": ${e.message}\n\nFragmento recibido:\n${raw.slice(0, 400)}`);
  }
}

// ─── Extracción de texto ───────────────────────────────────────────────────────

async function extractText(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  const text   = (result.value || '').trim();
  if (text.length < 500) {
    throw new Error('El documento está vacío o es demasiado corto (menos de 500 caracteres extraídos). Verifica que el .docx no esté protegido o vacío.');
  }
  return text;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const PROMPT_CANDIDATE_AND_STRUCTURE = `Eres un extractor técnico estricto. Tu única tarea es extraer información EXACTAMENTE como aparece en el documento. PROHIBIDO inventar, resumir, reescribir o modificar nada.

TAREA: Del texto del documento, extrae:
1. Los datos del candidato (nombre, partido, puntaje total, etc.)
2. La metodología
3. La estructura de los 8 bloques: su nombre, id, puntaje promedio, resumen, fortalezas, debilidades, y la lista de variables (solo nombre e id, sin contenido todavía)
4. El análisis final global

REGLAS:
- Extrae SOLO lo que está en el documento. No inventes nada.
- Los puntajes deben ser exactamente los que aparecen en el documento.
- El id de cada bloque y variable debe ser un slug en minúsculas del nombre (sin espacios, sin acentos).

Devuelve SOLO este JSON (sin bloques de código, sin texto adicional):
{
  "_schema_version": "2.0",
  "_converted_from_docx": true,
  "candidate": {
    "id": "<slug>",
    "name": "<nombre completo>",
    "party": "<partido>",
    "total_score": <número exacto del documento>,
    "color": "#b5121b",
    "plan_period": "<período si aparece, si no: null>",
    "plan_pages": <número si aparece, si no: null>,
    "summary": "<resumen ejecutivo tal como aparece en el documento>",
    "strengths": ["<fortaleza 1>", "..."],
    "weaknesses": ["<debilidad 1>", "..."],
    "methodological_notes": ["<nota 1>", "..."],
    "methodological_corrections": []
  },
  "methodology": {
    "description": "<descripción de la metodología tal como aparece en el documento>",
    "criteria": {
      "diagnostico": "<definición del criterio>",
      "propuesta": "<definición del criterio>",
      "medidas": "<definición del criterio>",
      "implementacion": "<definición del criterio>",
      "viabilidad": "<definición del criterio>",
      "especificidad": "<definición del criterio>"
    },
    "formula": "<fórmula tal como aparece en el documento>",
    "scale": "<escala de puntuación tal como aparece en el documento>"
  },
  "blocks": [
    {
      "id": "<slug>",
      "name": "<nombre exacto del bloque>",
      "average_score": <número exacto del documento>,
      "color": "#1d4ed8",
      "summary": "<resumen del bloque tal como aparece>",
      "interpretation": "<interpretación técnica tal como aparece>",
      "strengths": ["..."],
      "weaknesses": ["..."],
      "variables": [
        { "id": "<slug>", "name": "<nombre exacto>" }
      ]
    }
  ],
  "final_analysis": {
    "global_findings": ["<hallazgo 1>", "..."],
    "final_conclusion": "<conclusión global tal como aparece>",
    "ranking_note": "<nota de ranking si aparece>",
    "comparability_note": "<nota de comparabilidad si aparece>"
  }
}`;

function buildBlockDetailPrompt(blockName, variableNames) {
  const varList = variableNames.map((n, i) => `  ${i + 1}. ${n}`).join('\n');
  return `Eres un extractor técnico estricto. Tu única tarea es extraer información EXACTAMENTE como aparece en el documento. PROHIBIDO inventar, resumir, reescribir o modificar ningún valor.

TAREA: Del texto del documento, extrae el contenido completo del bloque "${blockName}" con sus variables:
${varList}

Para CADA variable extrae:
- Todos los criterios (diagnostico, propuesta, medidas, implementacion, viabilidad, especificidad) con su valor exacto (0, 1 o 2)
- criteria_sum: la suma de los 6 criterios TAL COMO APARECE en el documento (no calcules tú)
- formula_result: el resultado de la fórmula TAL COMO APARECE en el documento
- final_score: el puntaje final TAL COMO APARECE en el documento
- Las justificaciones de cada criterio (criteria_notes)
- Las 10 secciones narrativas TAL COMO APARECEN en el documento (sin abreviar ni resumir):
  definicion, importancia, diagnostico_externo, propuesta_plan, medidas_concretas,
  implementacion_necesaria, impacto_potencial, vacios, evaluacion_tecnica, conclusion
- summary, strengths, weaknesses, gaps, conclusion
- sources (si aparecen en el documento)

REGLAS ABSOLUTAS:
- Los valores numéricos deben ser EXACTAMENTE los del documento. NO recalcules nada.
- El texto de cada sección debe ser el texto COMPLETO del documento. NO resumir.
- Si una sección no aparece en el documento, usa "" (cadena vacía). NO inventes.
- Si un criterio no aparece, usa null. NO inventes.

Devuelve SOLO este JSON (sin bloques de código, sin texto adicional):
{
  "block_id": "<slug del bloque>",
  "variables": [
    {
      "id": "<slug>",
      "name": "<nombre exacto>",
      "final_score": <número exacto del documento>,
      "criteria_sum": <número exacto del documento>,
      "formula_result": <número exacto del documento>,
      "summary": "<texto completo>",
      "strengths": ["..."],
      "weaknesses": ["..."],
      "gaps": ["..."],
      "conclusion": "<texto completo>",
      "corrected_methodology": false,
      "correction_note": "",
      "criteria": {
        "diagnostico": <0|1|2>,
        "propuesta": <0|1|2>,
        "medidas": <0|1|2>,
        "implementacion": <0|1|2>,
        "viabilidad": <0|1|2>,
        "especificidad": <0|1|2>
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
    }
  ]
}`;
}

// ─── Llamadas a OpenAI ────────────────────────────────────────────────────────

async function callOpenAI(systemPrompt, userContent, label, onProgress) {
  onProgress(`Llamando IA: ${label}...`);
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0,
    max_tokens: 16384,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userContent }
    ]
  });

  const finish = response.choices[0].finish_reason;
  if (finish === 'length') {
    throw new Error(`La respuesta de la IA para "${label}" fue cortada por límite de tokens. El bloque puede ser demasiado extenso. Fragmento recibido:\n${response.choices[0].message.content.slice(-200)}`);
  }

  return cleanJsonResponse(response.choices[0].message.content.trim());
}

// ─── Validación estricta (SIN auto-corrección) ────────────────────────────────

const CRITERIOS_LIST = ['diagnostico', 'propuesta', 'medidas', 'implementacion', 'viabilidad', 'especificidad'];
const SECTIONS_LIST  = [
  'definicion','importancia','diagnostico_externo','propuesta_plan',
  'medidas_concretas','implementacion_necesaria','impacto_potencial',
  'vacios','evaluacion_tecnica','conclusion'
];

function round1(n) { return Math.round(n * 10) / 10; }

function validate(data) {
  const errors   = [];
  const warnings = [];

  // ── Estructura raíz ────────────────────────────────────────────────────────
  if (!data.candidate)             errors.push('Falta el objeto "candidate"');
  if (!data.methodology)           errors.push('Falta el objeto "methodology"');
  if (!Array.isArray(data.blocks)) errors.push('Falta el array "blocks"');
  if (!data.final_analysis)        warnings.push('Falta "final_analysis"');

  if (errors.length) return { ok: false, errors, warnings };

  // ── candidate ──────────────────────────────────────────────────────────────
  const c = data.candidate;
  for (const f of ['id', 'name', 'party', 'total_score']) {
    if (c[f] === undefined || c[f] === null || c[f] === '')
      errors.push(`candidate.${f} es obligatorio y está vacío`);
  }

  // ── blocks ─────────────────────────────────────────────────────────────────
  if (data.blocks.length !== 8) {
    errors.push(`Se esperan exactamente 8 bloques. Se encontraron: ${data.blocks.length}`);
  } else if (data.blocks.some(b => !b)) {
    errors.push('Uno o más bloques son nulos');
  }

  let totalVars       = 0;
  const allFinalScores = [];

  data.blocks.forEach((block, bi) => {
    const bLabel = `Bloque[${bi}] (${block.name || 'sin nombre'})`;

    if (!block.id)   errors.push(`${bLabel}: falta "id"`);
    if (!block.name) errors.push(`${bLabel}: falta "name"`);
    if (block.average_score === undefined || block.average_score === null)
      errors.push(`${bLabel}: falta "average_score"`);
    if (!block.summary || block.summary.trim().length < 5)
      errors.push(`${bLabel}: "summary" está vacío`);

    if (!Array.isArray(block.variables) || block.variables.length === 0) {
      errors.push(`${bLabel}: no tiene variables`);
      return;
    }

    const blockFinalScores = [];

    block.variables.forEach((v, vi) => {
      totalVars++;
      const vLabel = `${bLabel} › Variable[${vi}] (${v.name || 'sin nombre'})`;

      // ── Campos obligatorios ─────────────────────────────────────────────
      if (!v.id)   errors.push(`${vLabel}: falta "id"`);
      if (!v.name) errors.push(`${vLabel}: falta "name"`);

      if (v.final_score === undefined || v.final_score === null)
        errors.push(`${vLabel}: falta "final_score"`);
      if (v.criteria_sum === undefined || v.criteria_sum === null)
        errors.push(`${vLabel}: falta "criteria_sum"`);
      if (v.formula_result === undefined || v.formula_result === null)
        errors.push(`${vLabel}: falta "formula_result"`);

      if (!v.summary   || v.summary.trim().length < 5)   errors.push(`${vLabel}: "summary" está vacío`);
      if (!v.conclusion || v.conclusion.trim().length < 5) errors.push(`${vLabel}: "conclusion" está vacío`);

      if (!Array.isArray(v.strengths) || v.strengths.length === 0)
        errors.push(`${vLabel}: "strengths" está vacío`);
      if (!Array.isArray(v.weaknesses) || v.weaknesses.length === 0)
        errors.push(`${vLabel}: "weaknesses" está vacío`);
      if (!Array.isArray(v.gaps))
        errors.push(`${vLabel}: "gaps" no es un array`);

      // ── Criterios ────────────────────────────────────────────────────────
      if (!v.criteria) {
        errors.push(`${vLabel}: falta el objeto "criteria"`);
      } else {
        let computedSum = 0;
        let sumOk = true;
        for (const cr of CRITERIOS_LIST) {
          const val = v.criteria[cr];
          if (val === undefined || val === null) {
            errors.push(`${vLabel}: criteria.${cr} falta`);
            sumOk = false;
          } else if (![0, 1, 2].includes(Number(val))) {
            errors.push(`${vLabel}: criteria.${cr} debe ser 0, 1 o 2 (tiene: ${val})`);
            sumOk = false;
          } else {
            computedSum += Number(val);
          }
        }

        // Verificar coherencia sin corregir
        if (sumOk && v.criteria_sum !== undefined && v.criteria_sum !== null) {
          if (Number(v.criteria_sum) !== computedSum) {
            errors.push(`${vLabel}: criteria_sum=${v.criteria_sum} no coincide con la suma de criterios=${computedSum}. El documento tiene una inconsistencia.`);
          }

          const expectedFormula = round1((computedSum / 12) * 10);
          if (v.formula_result !== undefined && Math.abs(Number(v.formula_result) - expectedFormula) > 0.15) {
            errors.push(`${vLabel}: formula_result=${v.formula_result} no coincide con (${computedSum}/12)*10=${expectedFormula}. El documento tiene una inconsistencia.`);
          }
          if (v.final_score !== undefined && Math.abs(Number(v.final_score) - expectedFormula) > 0.15) {
            errors.push(`${vLabel}: final_score=${v.final_score} no coincide con la fórmula esperada=${expectedFormula}. El documento tiene una inconsistencia.`);
          }
        }
      }

      // ── Secciones narrativas ─────────────────────────────────────────────
      if (!v.analysis_sections) {
        errors.push(`${vLabel}: falta "analysis_sections"`);
      } else {
        for (const s of SECTIONS_LIST) {
          if (!v.analysis_sections[s] || v.analysis_sections[s].trim().length < 10) {
            errors.push(`${vLabel}: analysis_sections.${s} está vacío o incompleto`);
          }
        }
      }

      if (!v.criteria_notes) {
        errors.push(`${vLabel}: falta "criteria_notes"`);
      } else {
        for (const cr of CRITERIOS_LIST) {
          if (!v.criteria_notes[cr] || v.criteria_notes[cr].trim().length < 5) {
            errors.push(`${vLabel}: criteria_notes.${cr} está vacío`);
          }
        }
      }

      if (v.final_score !== undefined) {
        blockFinalScores.push(Number(v.final_score));
        allFinalScores.push(Number(v.final_score));
      }
    });

    // Verificar average_score del bloque sin corregir
    if (blockFinalScores.length > 0 && block.average_score !== undefined) {
      const computedAvg = round1(blockFinalScores.reduce((a, b) => a + b, 0) / blockFinalScores.length);
      if (Math.abs(Number(block.average_score) - computedAvg) > 0.2) {
        errors.push(`${bLabel}: average_score=${block.average_score} no coincide con el promedio calculado=${computedAvg}. El documento tiene una inconsistencia.`);
      }
    }
  });

  // ── Total de variables ─────────────────────────────────────────────────────
  if (totalVars !== 30) {
    errors.push(`Se esperan exactamente 30 variables en total. Se encontraron: ${totalVars}`);
  }

  // Verificar total_score del candidato sin corregir
  if (allFinalScores.length > 0 && c.total_score !== undefined) {
    const computedTotal = round1(allFinalScores.reduce((a, b) => a + b, 0) / allFinalScores.length);
    if (Math.abs(Number(c.total_score) - computedTotal) > 0.2) {
      errors.push(`candidate.total_score=${c.total_score} no coincide con el promedio calculado=${computedTotal}. El documento tiene una inconsistencia.`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ─── Pipeline principal ────────────────────────────────────────────────────────

async function processDocx(filePath, onProgress) {
  onProgress = onProgress || (() => {});
  const fileName = path.basename(filePath);
  onProgress(`Iniciando procesamiento: ${fileName}`);

  // ── 1. Hash (caché + deduplicación) ────────────────────────────────────────
  onProgress('Calculando huella del archivo...');
  const hash        = fileHash(filePath);
  const cacheFile   = path.join(CACHE_DIR, `${hash}.json`);

  // ── 2. Extraer texto completo sin truncar ───────────────────────────────────
  onProgress('Extrayendo texto completo del DOCX (sin truncar)...');
  const fullText = await extractText(filePath);
  onProgress(`Texto extraído: ${fullText.length.toLocaleString()} caracteres (~${Math.round(fullText.length / 4).toLocaleString()} tokens de entrada)`);

  // ── 3. Verificar caché ──────────────────────────────────────────────────────
  let finalData;

  if (fs.existsSync(cacheFile)) {
    onProgress('Caché encontrado — reutilizando resultado anterior (sin gasto de tokens)...');
    try {
      finalData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (_) {
      onProgress('Caché corrupto — reprocesando...');
      fs.unlinkSync(cacheFile);
    }
  }

  if (!finalData) {
    // ── 4. Fase 1: Estructura global + candidato ──────────────────────────────
    onProgress('Fase 1/2 — Extrayendo estructura global, candidato y metodología...');
    const structRaw = await callOpenAI(
      PROMPT_CANDIDATE_AND_STRUCTURE,
      `Documento completo:\n\n${fullText}`,
      'estructura global',
      onProgress
    );
    const structData = safeParseJson(structRaw, 'estructura global');

    if (!structData.blocks || !Array.isArray(structData.blocks)) {
      throw new Error('La IA no pudo extraer la estructura de bloques del documento. Verifica que el documento siga el formato esperado.');
    }

    const blocksFound = structData.blocks.length;
    onProgress(`Estructura extraída: ${blocksFound} bloques detectados`);
    if (blocksFound !== 8) {
      throw new Error(`Se detectaron ${blocksFound} bloques en el documento. Se esperan exactamente 8. Verifica que el documento esté completo y siga el formato correcto.`);
    }

    // ── 5. Fase 2: Contenido detallado por bloque (1 llamada por bloque) ──────
    onProgress(`Fase 2/2 — Extrayendo contenido detallado de los ${blocksFound} bloques (${blocksFound} llamadas)...`);

    for (let bi = 0; bi < structData.blocks.length; bi++) {
      const block    = structData.blocks[bi];
      const varNames = (block.variables || []).map(v => v.name || v.id || `Variable ${bi + 1}`);
      const varCount = varNames.length;

      onProgress(`  Bloque ${bi + 1}/${blocksFound}: "${block.name}" (${varCount} variables)...`);

      const blockPrompt = buildBlockDetailPrompt(block.name, varNames);
      const blockRaw    = await callOpenAI(
        blockPrompt,
        `Documento completo:\n\n${fullText}`,
        `bloque "${block.name}"`,
        onProgress
      );
      const blockData = safeParseJson(blockRaw, `bloque "${block.name}"`);

      if (!Array.isArray(blockData.variables) || blockData.variables.length === 0) {
        throw new Error(`La IA no extrajo variables para el bloque "${block.name}". El documento puede estar truncado o el formato es inesperado.`);
      }

      if (blockData.variables.length !== varCount) {
        onProgress(`  ⚠ "${block.name}": se esperaban ${varCount} variables, se extrajeron ${blockData.variables.length}`);
      }

      // Reemplazar la lista de variables de la estructura con las detalladas
      structData.blocks[bi].variables = blockData.variables;

      onProgress(`  ✓ Bloque ${bi + 1} completado: ${blockData.variables.length} variables`);
    }

    finalData = structData;

    // ── 6. Guardar en caché ───────────────────────────────────────────────────
    fs.writeFileSync(cacheFile, JSON.stringify(finalData, null, 2), 'utf8');
    onProgress('Resultado guardado en caché local');
  }

  // ── 7. Validación estricta ────────────────────────────────────────────────
  onProgress('Validando estructura completa (sin auto-corrección)...');
  const validation = validate(finalData);

  if (validation.warnings.length > 0) {
    onProgress('Advertencias:\n' + validation.warnings.map(w => '  ⚠ ' + w).join('\n'));
  }

  if (!validation.ok) {
    // Borrar caché si la validación falla (el resultado es defectuoso)
    try { if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile); } catch (_) {}

    const errorLines = validation.errors.map(e => '  ✕ ' + e).join('\n');
    throw new Error(
      `Validación fallida — NO se guardó el JSON.\n\n` +
      `Se encontraron ${validation.errors.length} error(es):\n${errorLines}\n\n` +
      `Causas posibles: estructura del documento incompleta, puntajes inconsistentes, o secciones faltantes.`
    );
  }

  // ── 8. Inyectar metadatos de conversión ───────────────────────────────────
  const candidateId = finalData.candidate.id || slugify(finalData.candidate.name || fileName.replace('.docx', ''));
  finalData.candidate.id  = candidateId;
  finalData._converted_at = new Date().toISOString();
  finalData._source_file  = fileName;
  finalData._source_hash  = hash;

  const outputFile = path.join(ANALISIS_DIR, `${candidateId}.json`);

  // ── 9. Evitar sobreescritura si el hash es igual ──────────────────────────
  if (fs.existsSync(outputFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
      if (existing._source_hash === hash) {
        onProgress(`El archivo ${candidateId}.json ya existe con el mismo contenido. No se sobrescribió.`);
        return {
          ok: true, skipped: true, outputFile, candidateId,
          warnings: validation.warnings,
          message: 'Archivo ya procesado (mismo contenido). No se reprocesó.'
        };
      }
    } catch (_) {}
  }

  // ── 10. Guardar ───────────────────────────────────────────────────────────
  fs.writeFileSync(outputFile, JSON.stringify(finalData, null, 2), 'utf8');
  onProgress(`✓ JSON guardado correctamente: /analisis/${candidateId}.json`);

  const totalVars = finalData.blocks.reduce((t, b) => t + (b.variables || []).length, 0);

  return {
    ok:          true,
    skipped:     false,
    outputFile,
    candidateId,
    totalScore:  finalData.candidate.total_score,
    blocks:      finalData.blocks.length,
    totalVars,
    warnings:    validation.warnings
  };
}

module.exports = { processDocx };
