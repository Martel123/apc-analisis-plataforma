'use strict';

/**
 * DOCX → JSON Processor
 * Extrae texto completo del DOCX con mammoth,
 * divide en chunks para no exceder ventana de contexto,
 * llama a OpenAI para estructurar el JSON,
 * valida estrictamente y guarda en /analisis.
 */

const mammoth = require('mammoth');
const OpenAI  = require('openai');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const ANALISIS_DIR = path.join(__dirname, '..', 'analisis');
const CACHE_DIR    = path.join(__dirname, 'cache');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function fileHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function getCacheKey(hash) {
  return path.join(CACHE_DIR, `${hash}.json`);
}

function roundScore(n) {
  return Math.round(n * 10) / 10;
}

// ─── Extracción de texto ───────────────────────────────────────────────────────

async function extractText(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  const text = result.value;
  if (!text || text.trim().length < 200) {
    throw new Error('El documento está vacío o es demasiado corto para procesarlo.');
  }
  return text;
}

// ─── Prompt del sistema ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres un asistente especializado en estructurar análisis técnicos de planes de gobierno peruanos en formato JSON.

TAREA: Dado el texto completo de un documento de análisis técnico, debes extraer y estructurar TODA la información en el JSON que se describe abajo.

REGLAS ABSOLUTAS:
1. El JSON debe tener exactamente 8 bloques temáticos con sus variables.
2. El total de variables debe ser exactamente 30.
3. Cada variable debe tener los 6 criterios: diagnostico, propuesta, medidas, implementacion, viabilidad, especificidad. Cada uno vale 0, 1 o 2.
4. criteria_sum = suma de los 6 criterios (máx. 12).
5. formula_result = (criteria_sum / 12) * 10, redondeado a 1 decimal.
6. final_score = formula_result.
7. El promedio de cada bloque = promedio de final_score de sus variables, redondeado a 1 decimal.
8. total_score en candidate = promedio de todos los final_score, redondeado a 1 decimal.
9. Cada variable debe tener sections con todos estos campos (texto real, no vacío):
   - definicion, importancia, diagnostico_externo, propuesta_plan,
     medidas_concretas, implementacion_necesaria, impacto_potencial,
     vacios, evaluacion_tecnica, conclusion
10. Cada variable debe tener sources (array, puede ser vacío []).
11. NO inventes datos que no existan en el documento.
12. Extrae toda la narrativa real del documento para cada sección.

ESTRUCTURA JSON EXACTA A RETORNAR:
{
  "_schema_version": "2.0",
  "_converted_from_docx": true,
  "candidate": {
    "id": "<slug del nombre, sin espacios, en minúsculas>",
    "name": "<Nombre completo del candidato>",
    "party": "<Partido político>",
    "total_score": <número>,
    "color": "#b5121b",
    "plan_period": "2026-2031",
    "plan_pages": <número o null>,
    "summary": "<Resumen ejecutivo del plan>",
    "strengths": ["..."],
    "weaknesses": ["..."],
    "methodological_notes": ["..."],
    "methodological_corrections": []
  },
  "blocks": [
    {
      "id": "<id del bloque>",
      "name": "<nombre del bloque>",
      "average_score": <número>,
      "color": "#1d4ed8",
      "summary": "<resumen del bloque>",
      "interpretation": "<interpretación técnica>",
      "strengths": ["..."],
      "weaknesses": ["..."],
      "variables": [
        {
          "id": "<id_variable>",
          "name": "<nombre de la variable>",
          "final_score": <número>,
          "criteria_sum": <número entero 0-12>,
          "formula_result": <número>,
          "summary": "<resumen de la variable>",
          "strengths": ["..."],
          "weaknesses": ["..."],
          "gaps": ["..."],
          "conclusion": "<conclusión>",
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
            "diagnostico": "<justificación>",
            "propuesta": "<justificación>",
            "medidas": "<justificación>",
            "implementacion": "<justificación>",
            "viabilidad": "<justificación>",
            "especificidad": "<justificación>"
          },
          "analysis_sections": {
            "definicion": "<texto>",
            "importancia": "<texto>",
            "diagnostico_externo": "<texto>",
            "propuesta_plan": "<texto>",
            "medidas_concretas": "<texto>",
            "implementacion_necesaria": "<texto>",
            "impacto_potencial": "<texto>",
            "vacios": "<texto>",
            "evaluacion_tecnica": "<texto>",
            "conclusion": "<texto>"
          },
          "sources": []
        }
      ]
    }
  ],
  "final_analysis": {
    "global_findings": ["..."],
    "final_conclusion": "<conclusión global>",
    "ranking_note": "<nota de ranking>",
    "comparability_note": "<nota de comparabilidad>"
  }
}

Devuelve SOLO el JSON. Sin texto antes ni después. Sin bloques de código markdown.`;

// ─── Llamada a OpenAI (con chunking si el texto es muy largo) ─────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// GPT-4o tiene 128k tokens; ~4 chars/token → 500k chars de texto seguro
const MAX_TEXT_CHARS = 480_000;

async function callOpenAI(text, onProgress) {
  const truncated = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;

  if (text.length > MAX_TEXT_CHARS) {
    onProgress?.(`Documento muy largo (${text.length} chars). Usando primeros ${MAX_TEXT_CHARS} chars.`);
  }

  onProgress?.('Enviando documento a IA para estructuración...');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.1,
    max_tokens: 16000,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: `Texto completo del documento:\n\n${truncated}` }
    ]
  });

  const raw = response.choices[0].message.content.trim();

  // Limpiar posibles bloques de código markdown
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  return cleaned;
}

// ─── Validación estricta ────────────────────────────────────────────────────────

function validate(data) {
  const errors   = [];
  const warnings = [];

  // Estructura raíz
  if (!data.candidate)             errors.push('Falta "candidate"');
  if (!Array.isArray(data.blocks)) errors.push('Falta array "blocks"');
  if (!data.final_analysis)        warnings.push('Falta "final_analysis"');

  if (errors.length) return { ok: false, errors, warnings };

  // Candidato
  const c = data.candidate;
  for (const f of ['id', 'name', 'party', 'total_score']) {
    if (c[f] === undefined || c[f] === null || c[f] === '')
      errors.push(`candidate.${f} es obligatorio`);
  }

  // Bloques: deben ser exactamente 8
  if (data.blocks.length !== 8) {
    errors.push(`Se esperan 8 bloques, se encontraron ${data.blocks.length}`);
  }

  let totalVars = 0;
  const allScores = [];
  const CRITERIOS = ['diagnostico', 'propuesta', 'medidas', 'implementacion', 'viabilidad', 'especificidad'];

  data.blocks.forEach((block, bi) => {
    if (!block.id)   errors.push(`blocks[${bi}] le falta "id"`);
    if (!block.name) errors.push(`blocks[${bi}] le falta "name"`);

    if (!Array.isArray(block.variables) || block.variables.length === 0) {
      errors.push(`blocks[${bi}] (${block.name || bi}) no tiene variables`);
      return;
    }

    const blockScores = [];

    block.variables.forEach((v, vi) => {
      totalVars++;
      const vkey = `blocks[${bi}].variables[${vi}] (${v.name || vi})`;

      if (!v.id)   errors.push(`${vkey} le falta "id"`);
      if (!v.name) errors.push(`${vkey} le falta "name"`);
      if (v.final_score === undefined) errors.push(`${vkey} le falta "final_score"`);

      // Criterios
      if (!v.criteria) {
        errors.push(`${vkey} le falta "criteria"`);
      } else {
        let sum = 0;
        for (const cr of CRITERIOS) {
          if (v.criteria[cr] === undefined) {
            errors.push(`${vkey}.criteria.${cr} falta`);
          } else if (![0, 1, 2].includes(Number(v.criteria[cr]))) {
            errors.push(`${vkey}.criteria.${cr} debe ser 0, 1 o 2`);
          } else {
            sum += Number(v.criteria[cr]);
          }
        }

        // Verificar fórmula
        const expected = roundScore((sum / 12) * 10);
        const actual   = roundScore(v.final_score);
        if (Math.abs(expected - actual) > 0.15) {
          warnings.push(`${vkey}: final_score=${actual} no coincide con fórmula=${expected} (sum=${sum})`);
          // Auto-corregir
          v.criteria_sum    = sum;
          v.formula_result  = expected;
          v.final_score     = expected;
        } else {
          v.criteria_sum   = sum;
          v.formula_result = expected;
          v.final_score    = expected;
        }
      }

      // Sections
      const SECTIONS = [
        'definicion','importancia','diagnostico_externo','propuesta_plan',
        'medidas_concretas','implementacion_necesaria','impacto_potencial',
        'vacios','evaluacion_tecnica','conclusion'
      ];
      if (!v.analysis_sections) {
        errors.push(`${vkey} le falta "analysis_sections"`);
      } else {
        for (const s of SECTIONS) {
          if (!v.analysis_sections[s] || v.analysis_sections[s].trim().length < 5) {
            warnings.push(`${vkey}.analysis_sections.${s} está vacío o muy corto`);
          }
        }
      }

      if (!v.conclusion || v.conclusion.trim().length < 5) {
        warnings.push(`${vkey} le falta "conclusion"`);
      }

      if (!Array.isArray(v.sources)) {
        v.sources = [];
      }

      blockScores.push(v.final_score);
      allScores.push(v.final_score);
    });

    // Recalcular promedio del bloque
    if (blockScores.length > 0) {
      const avg = roundScore(blockScores.reduce((a, b) => a + b, 0) / blockScores.length);
      if (block.average_score !== undefined && Math.abs(block.average_score - avg) > 0.2) {
        warnings.push(`blocks[${bi}] (${block.name}): average_score=${block.average_score} ajustado a ${avg}`);
      }
      block.average_score = avg;
    }
  });

  // Verificar total de variables
  if (totalVars !== 30) {
    errors.push(`Se esperan 30 variables en total, se encontraron ${totalVars}`);
  }

  // Recalcular total_score
  if (allScores.length > 0) {
    const totalExpected = roundScore(allScores.reduce((a, b) => a + b, 0) / allScores.length);
    if (Math.abs(c.total_score - totalExpected) > 0.2) {
      warnings.push(`candidate.total_score=${c.total_score} ajustado a ${totalExpected}`);
    }
    c.total_score = totalExpected;
  }

  return {
    ok:       errors.length === 0,
    errors,
    warnings
  };
}

// ─── Función principal ────────────────────────────────────────────────────────

async function processDocx(filePath, onProgress) {
  onProgress = onProgress || (() => {});

  const fileName = path.basename(filePath);
  onProgress(`Procesando: ${fileName}`);

  // 1. Hash para caché y deduplicación
  onProgress('Calculando huella del archivo...');
  const hash    = fileHash(filePath);
  const cacheKey = getCacheKey(hash);

  // 2. Extraer texto
  onProgress('Extrayendo texto del DOCX...');
  const text = await extractText(filePath);
  onProgress(`Texto extraído: ${text.length.toLocaleString()} caracteres`);

  // 3. Llamar a IA
  let rawJson;
  if (fs.existsSync(cacheKey)) {
    onProgress('Cache encontrado, reutilizando resultado anterior...');
    rawJson = fs.readFileSync(cacheKey, 'utf8');
  } else {
    rawJson = await callOpenAI(text, onProgress);
    fs.writeFileSync(cacheKey, rawJson, 'utf8');
    onProgress('Respuesta de IA guardada en caché');
  }

  // 4. Parsear JSON
  onProgress('Parseando JSON generado...');
  let data;
  try {
    data = JSON.parse(rawJson);
  } catch (e) {
    throw new Error(`JSON inválido generado por la IA: ${e.message}. Revisa el documento y vuelve a intentarlo.`);
  }

  // 5. Validar
  onProgress('Validando estructura...');
  const validation = validate(data);

  if (!validation.ok) {
    throw new Error(
      'El JSON generado no supera la validación:\n' +
      validation.errors.map(e => '  ✕ ' + e).join('\n')
    );
  }

  if (validation.warnings.length > 0) {
    onProgress('Advertencias (auto-corregidas):\n' + validation.warnings.map(w => '  ⚠ ' + w).join('\n'));
  }

  // 6. Determinar nombre de archivo de salida
  const candidateId = data.candidate.id || slugify(data.candidate.name || fileName.replace('.docx', ''));
  data.candidate.id = candidateId;
  data._converted_at = new Date().toISOString();
  data._source_file  = fileName;
  data._source_hash  = hash;

  const outputFile = path.join(ANALISIS_DIR, `${candidateId}.json`);

  // 7. Evitar sobreescritura si ya existe y el hash es el mismo
  if (fs.existsSync(outputFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
      if (existing._source_hash === hash) {
        onProgress(`⚠ El archivo ${candidateId}.json ya existe con el mismo contenido. Omitido.`);
        return {
          ok:         true,
          skipped:    true,
          outputFile,
          candidateId,
          warnings:   validation.warnings,
          message:    'Archivo ya procesado (mismo hash). No se sobrescribió.'
        };
      }
    } catch (_) {}
  }

  // 8. Guardar
  fs.writeFileSync(outputFile, JSON.stringify(data, null, 2), 'utf8');
  onProgress(`✓ JSON guardado: /analisis/${candidateId}.json`);

  return {
    ok:         true,
    skipped:    false,
    outputFile,
    candidateId,
    totalScore: data.candidate.total_score,
    blocks:     data.blocks.length,
    totalVars:  data.blocks.reduce((t, b) => t + b.variables.length, 0),
    warnings:   validation.warnings
  };
}

module.exports = { processDocx };
