'use strict';

/**
 * DOCX→JSON Converter — Hybrid Architecture v5
 *
 * PHASE 1: Local DOCX extraction (no AI)
 * PHASE 2: Local structure parsing — blocks, variables, hard data (no AI)
 * PHASE 3: Local hard-data extraction — criteria scores, formula, final_score (no AI)
 * PHASE 4: AI per variable — only narrative content (2 bounded calls)
 * PHASE 5: Merge — local data takes absolute priority over AI output
 * PHASE 6: Metadata — candidate + methodology from document header (local + optional AI)
 * PHASE 7: Assemble final JSON
 * PHASE 8: Strict validation — 8 blocks, 30 variables, no invented data
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const mammoth = require('mammoth');
const OpenAI  = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL  = 'gpt-4o-mini';
const CACHE_DIR = path.join(__dirname, 'cache');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ─── Constants ────────────────────────────────────────────────────────────────

const CRITERIA_KEYS = ['diagnostico','propuesta','medidas','implementacion','viabilidad','especificidad'];

// Document abbreviation → schema key
// NOTE: 'i' is included for documents that use "I:0" instead of "Im:0"
const CRITERIA_MAP = {
  'd': 'diagnostico', 'diagnostico': 'diagnostico', 'diagnóstico': 'diagnostico',
  'p': 'propuesta', 'propuesta': 'propuesta',
  'm': 'medidas', 'medidas': 'medidas',
  'i': 'implementacion', 'im': 'implementacion',
  'implementación': 'implementacion', 'implementacion': 'implementacion',
  'v': 'viabilidad', 'viabilidad': 'viabilidad',
  'e': 'especificidad', 'especificidad': 'especificidad'
};

const RATING = (s) =>
  s >= 9   ? 'excelente'
  : s >= 7.5 ? 'sólido'
  : s >= 6   ? 'moderado'
  : s >= 4   ? 'débil'
  : 'insuficiente';

// ─── Utilities ────────────────────────────────────────────────────────────────

function slug(str) {
  return (str || 'sin_nombre')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callAI(messages, maxTokens, attempt = 0) {
  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });
    const text   = res.choices[0].message.content || '{}';
    const finish = res.choices[0].finish_reason;
    if (finish === 'length') throw new Error('TRUNCATED');
    return JSON.parse(text);
  } catch (err) {
    if (err.status === 429 || (err.message && err.message.includes('rate'))) {
      if (attempt >= 5) throw new Error('Rate limit máximo alcanzado');
      const wait = 30000 * (attempt + 1);
      await sleep(wait);
      return callAI(messages, maxTokens, attempt + 1);
    }
    throw err;
  }
}

// ─── PHASE 1: Local DOCX extraction ──────────────────────────────────────────

async function extractText(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

// ─── PHASE 2: Local structure parsing ────────────────────────────────────────

/**
 * Normalize a block/variable display name for deduplication:
 *  - lowercase + remove accents
 *  - strip trailing score: "— 6.0/10", "– Puntaje: 6.7", "(6.0/10)", "6.0/10"
 *  - strip trailing parenthetical or annotation
 *  - collapse spaces
 */
function normalizeName(name) {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    // strip "— 6.0/10", "– 6.0", "(6.0/10)", "6.0/10", "/ 10"
    .replace(/\s*[—–\-]\s*[\d.,]+\s*\/?\s*\d*/g, '')
    .replace(/\s*\([\d.,]+\s*\/\s*\d+\)/g, '')
    .replace(/\s*[\d.,]+\s*\/\s*10\b/g, '')
    // strip "puntaje promedio: X", "score: X", etc.
    .replace(/\s*(puntaje|promedio|score|calificacion|nota)\s*.*$/i, '')
    // strip trailing separators
    .replace(/[\s:—–\-.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract variable number from raw header line (if present).
 * "Variable 12: ..." → 12
 * "var. 3 ..."       → 3
 * Returns null if not found.
 */
function extractVarNumber(line) {
  const m = /^(?:variable|var\.?)\s*(\d+)/i.exec(line.trim());
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Returns { blocks, parseLog }
 *   blocks   = array of blocks with variables (first-occurrence wins)
 *   parseLog = string[] of deduplication messages
 *
 * Block detection:  "BLOQUE N:" / "Bloque N:" and variants
 * Variable detection: "Variable N:" / "VARIABLE N:" and variants
 *
 * KEY RULE: normalize → deduplicate → first occurrence wins.
 * Any subsequent match of the same block/variable key is ignored
 * (handles recap tables, score summaries, end-of-document repetitions).
 */
function parseStructure(fullText) {
  const lines = fullText.split(/\r?\n/);

  // Must have a digit right after the keyword
  const RX_BLOCK = /^(?:bloque|blok|block)\s*\d/i;
  const RX_VAR   = /^(?:variable|var\.?)\s*\d/i;

  // Collect all candidate lines
  const segments = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (RX_BLOCK.test(l)) {
      segments.push({ type: 'block', line: l, idx: i });
    } else if (RX_VAR.test(l)) {
      segments.push({ type: 'variable', line: l, idx: i });
    }
  }

  // Deduplication sets
  const seenBlockKeys = new Set();  // normalized block name
  const seenVarKeys   = new Set();  // normalized var name OR "num:N"
  const parseLog = [];

  // Deduplicate segments — keep only first occurrence per key
  const dedupedSegments = [];
  for (const seg of segments) {
    if (seg.type === 'block') {
      // Extract name after "BLOQUE N: "
      const rawName = seg.line
        .replace(/^(?:bloque|blok|block)\s*\d+\s*[\s:\-–.]*/i, '')
        .trim();
      const key = normalizeName(rawName || seg.line);
      if (seenBlockKeys.has(key)) {
        parseLog.push(`Bloque duplicado ignorado: ${seg.line}`);
        continue;
      }
      seenBlockKeys.add(key);
      seg._cleanName = rawName || seg.line;
      dedupedSegments.push(seg);
    } else {
      // Extract name after "Variable N: "
      const rawName = seg.line
        .replace(/^(?:variable|var\.?)\s*\d+\s*[\s:\-–.]*/i, '')
        .trim();
      const varNum = extractVarNumber(seg.line);
      const nameKey = normalizeName(rawName || seg.line);

      // A variable is a duplicate if same number OR same normalized name
      const numKey = varNum !== null ? `num:${varNum}` : null;
      const isDup  = (numKey && seenVarKeys.has(numKey)) || seenVarKeys.has(nameKey);

      if (isDup) {
        parseLog.push(`Variable duplicada ignorada: ${seg.line}`);
        continue;
      }
      if (numKey)   seenVarKeys.add(numKey);
      seenVarKeys.add(nameKey);

      seg._cleanName = rawName || seg.line;
      dedupedSegments.push(seg);
    }
  }

  const totalBlocks = dedupedSegments.filter(s => s.type === 'block').length;
  const totalVars   = dedupedSegments.filter(s => s.type === 'variable').length;
  const dupBlocks   = segments.filter(s => s.type === 'block').length - totalBlocks;
  const dupVars     = segments.filter(s => s.type === 'variable').length - totalVars;

  if (dupBlocks > 0) parseLog.push(`Se eliminaron ${dupBlocks} bloque(s) duplicado(s)`);
  if (dupVars   > 0) parseLog.push(`Se eliminaron ${dupVars} variable(s) duplicada(s)`);

  parseLog.push(`Estructura final deduplicada: ${totalBlocks} bloque(s), ${totalVars} variable(s)`);

  // Build hierarchy from deduplicated segments
  const blocks = [];
  let currentBlock = null;
  let currentVar   = null;

  function closeVar(endIdx) {
    if (!currentVar || !currentBlock) return;
    const textLines = lines.slice(currentVar.startLine + 1, endIdx);
    currentVar.text = textLines.join('\n').trim();
    currentBlock.variables.push(currentVar);
    currentVar = null;
  }

  function closeBlock(endIdx) {
    closeVar(endIdx);
    if (currentBlock) blocks.push(currentBlock);
    currentBlock = null;
  }

  for (const seg of dedupedSegments) {
    if (seg.type === 'block') {
      closeBlock(seg.idx);
      currentBlock = {
        id:        slug(seg._cleanName),
        name:      seg._cleanName,
        rawName:   seg.line,
        variables: []
      };
    } else {
      if (!currentBlock) {
        currentBlock = { id: 'bloque_inicial', name: 'Bloque inicial', rawName: '', variables: [] };
      }
      closeVar(seg.idx);
      currentVar = {
        id:        slug(seg._cleanName),
        name:      seg._cleanName,
        rawName:   seg.line,
        startLine: seg.idx,
        varNum:    extractVarNumber(seg.line)
      };
    }
  }
  closeBlock(lines.length);

  // ── Post-process: drop empty blocks ──────────────────────────────────────
  // A real structural block always has ≥1 variable under it.
  // Recap/summary lines (e.g. "BLOQUE 3: SEGURIDAD — 2.7/10") that slipped
  // through dedup will never have variables → drop them and log.
  const nonEmpty = [];
  for (const b of blocks) {
    if (b.variables.length === 0) {
      parseLog.push(`Bloque vacío eliminado (resumen sin variables): ${b.rawName}`);
    } else {
      nonEmpty.push(b);
    }
  }

  if (nonEmpty.length < blocks.length) {
    parseLog.push(`Se eliminaron ${blocks.length - nonEmpty.length} bloque(s) vacío(s)`);
  }

  return { blocks: nonEmpty, parseLog };
}

// ─── PHASE 3: Local hard-data extraction ─────────────────────────────────────

/**
 * Attempts to extract from variable text without AI:
 *   criteria: {diagnostico, propuesta, medidas, implementacion, viabilidad, especificidad}
 *   criteria_sum, formula_result, final_score
 *
 * Two named parsers + two fallback strategies:
 *
 *  Parser B  — "10. Calificación final" tabular section (D = 1 / 2 per line)
 *  Parser A  — Compact single-line (D:1 P:2 M:1 I:0 V:1 E:0)
 *  Strategy 2 — Full name labels (Diagnóstico: 2)
 *  Strategy 3 — Line-by-line single letters including "/2" suffix
 *  Strategy 4 — Header-row table (D P M Im V E / 2 1 0 0 1 0)
 *
 * Returns: { criteria?, criteria_sum?, formula_result?, final_score?, _parseNote, _logs[] }
 */
function extractHardData(text) {
  const result = {};
  const crit   = {};
  const logs   = [];
  let   source = null;

  // ── Parser B: Tabular "Calificación final" section ────────────────────
  // Real format:
  //   10. Calificación final
  //   D = 1 / 2
  //   P = 2 / 2
  //   M = 1 / 2
  //   Im = 0 / 2
  //   V = 2 / 2
  //   E = 2 / 2
  //   SUMA: 8 / 12
  //   NOTA: 6.7 / 10
  const SECTION_RX = /(?:10\.\s*)?calificaci[oó]n\s+final|criterio\s+puntaje|criterio[\s\S]{0,40}puntaje/i;
  const secMatch = SECTION_RX.exec(text);

  if (secMatch) {
    const sectionText = text.slice(secMatch.index);
    logs.push(`Se encontró sección Calificación final en la variable`);

    // Each criterion: "D = 1 / 2", "Im = 0 / 2", "D: 1", "D 1"
    const tabRx = /^(D|P|M|Im?|V|E)\s*[:\-=]\s*([012])\s*(?:\/\s*2)?\s*$/gim;
    let tm;
    while ((tm = tabRx.exec(sectionText)) !== null) {
      const key = CRITERIA_MAP[tm[1].toLowerCase()];
      if (key && crit[key] === undefined) crit[key] = parseInt(tm[2], 10);
    }

    if (Object.keys(crit).length === 6) {
      source = 'parser-B-tabular';
      const c = crit;
      logs.push(`Parser B exitoso: D=${c.diagnostico} P=${c.propuesta} M=${c.medidas} Im=${c.implementacion} V=${c.viabilidad} E=${c.especificidad}`);
    } else {
      logs.push(`Parser B parcial: ${Object.keys(crit).length}/6 criterios encontrados — ${JSON.stringify(crit)}`);
    }
  }

  // ── Parser A: Compact single-line ────────────────────────────────────
  // Real formats:
  //   "📊 RÚBRICA: D:1 P:1 M:0 I:0 V:1 E:0 → Suma: 3/12"
  //   "D=2 P=2 M=1 Im=0 V=1 E=1"
  //   "D 2 P 2 M 1 I 0 V 1 E 1"
  //   "D = 1 / 2  P = 2 / 2  M = 1 / 2  Im = 0 / 2  V = 2 / 2  E = 2 / 2" (all on one line)
  // BETW includes digits so "/2" denominators are absorbed between pairs.
  if (Object.keys(crit).length < 6) {
    const SEP  = '[\\s:=]*';        // separator after key (colon, equals, space — optional)
    const BETW = '[\\s,\\/|0-9]+';  // between pairs: absorbs "/2" denominators too
    const V1   = '([012])';
    const compactRx = new RegExp(
      'D' + SEP + V1 + BETW +
      'P' + SEP + V1 + BETW +
      'M' + SEP + V1 + BETW +
      'I(?:m)?' + SEP + V1 + BETW +
      'V' + SEP + V1 + BETW +
      'E' + SEP + V1,
      'i'
    );
    const cm = compactRx.exec(text);
    if (cm) {
      ['diagnostico','propuesta','medidas','implementacion','viabilidad','especificidad'].forEach((k, i) => {
        if (crit[k] === undefined) crit[k] = parseInt(cm[i + 1], 10);
      });
      if (Object.keys(crit).length === 6) {
        source = 'parser-A-compact';
        const c = crit;
        logs.push(`Parser A exitoso: D=${c.diagnostico} P=${c.propuesta} M=${c.medidas} I=${c.implementacion} V=${c.viabilidad} E=${c.especificidad}`);
      }
    }
  }

  // ── Strategy 2: Full name labels ──────────────────────────────────────
  // Handles: "Diagnóstico: 2", "Implementación = 1", "Especificidad: 0"
  if (Object.keys(crit).length < 6) {
    const RX_WORD = /\b(diagnostico|diagnóstico|propuesta|medidas|implementaci[oó]n|viabilidad|especificidad)\s*[:\-=]\s*([012])\b/gi;
    let m;
    while ((m = RX_WORD.exec(text)) !== null) {
      const key = CRITERIA_MAP[m[1].toLowerCase()];
      if (key && crit[key] === undefined) { crit[key] = parseInt(m[2], 10); source = 'fullname'; }
    }
  }

  // ── Strategy 3: Line-by-line single letters (enhanced) ───────────────
  // Handles: "D: 2", "Im: 1", "I=0", "D = 1 / 2" — one per line
  // Also handles optional leading bullet/emoji: "• D: 2", "📊 E: 1"
  if (Object.keys(crit).length < 6) {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim().replace(/^[-•*▸►📊🔷🔹]\s*/, '');
      // Matches "D: 2", "Im: 1", "I=0", "D = 1 / 2"
      const lm = /^(D|P|M|Im?|V|E)\s*[:\-=]\s*([012])\s*(?:\/\s*2)?\s*$/i.exec(t);
      if (lm) {
        const key = CRITERIA_MAP[lm[1].toLowerCase()];
        if (key && crit[key] === undefined) { crit[key] = parseInt(lm[2], 10); source = 'linebyline'; }
      }
    }
  }

  // ── Strategy 4: Header-row table ─────────────────────────────────────
  // Handles: "D  P  M  Im  V  E" header followed by "2  1  0  0  1  0"
  if (Object.keys(crit).length < 6) {
    const hdrRx = /\bD\s+P\s+M\s+Im?\s+V\s+E\b/i;
    const hdrMatch = hdrRx.exec(text);
    if (hdrMatch) {
      const after = text.slice(hdrMatch.index + hdrMatch[0].length);
      const nums  = after.match(/\b([012])\s+([012])\s+([012])\s+([012])\s+([012])\s+([012])\b/);
      if (nums) {
        const keys = ['diagnostico','propuesta','medidas','implementacion','viabilidad','especificidad'];
        keys.forEach((k, i) => { if (crit[k] === undefined) crit[k] = parseInt(nums[i + 1], 10); });
        source = 'headertable';
      }
    }
  }

  // ── Assign criteria ───────────────────────────────────────────────────
  if (Object.keys(crit).length === 6) {
    result.criteria   = crit;
    result._parseNote = source || 'unknown';
  } else {
    result._parseNote = 'incompleto(' + Object.keys(crit).length + '/6)-' + (source || 'sin patrón');
  }

  // ── Criteria sum ──────────────────────────────────────────────────────
  // Handles: "SUMA: 8/12", "SUMA: 8 / 12", "Suma criterios: 8"
  const sumM = /(?:suma(?:\s+criterios)?|criteria[_\s]sum|total\s+criterios|subtotal)\s*[:\-=]\s*(\d+)\s*(?:\/\s*12)?/i.exec(text);
  if (sumM) {
    result.criteria_sum = parseInt(sumM[1], 10);
    logs.push('SUMA detectada: ' + sumM[1] + '/12');
  }

  // ── Formula result ────────────────────────────────────────────────────
  // Handles: "(8/12) × 10 = 6.7", "(8 / 12) × 10 = 6.7 / 10"
  const fmM = /\(\s*(\d+)\s*\/\s*12\s*\)\s*[×x\*]\s*10\s*[=:]\s*([\d.]+)/i.exec(text);
  if (fmM) {
    if (result.criteria_sum === undefined) result.criteria_sum = parseInt(fmM[1], 10);
    result.formula_result = parseFloat(fmM[2]);
  }

  // ── Final score ───────────────────────────────────────────────────────
  // Handles: "Puntaje final: 6.7", "NOTA: 6.7 / 10", "Calificación: 2.5 / 10"
  //          "Calificación final: 6.7", "nota final: 5.0", "nota: 5.0"
  const scM = /(?:puntaje\s+(?:final|variable|total)|final[_\s]score|calificaci[oó]n(?:\s+final)?|nota(?:\s+final)?)\s*[:\-=]\s*([\d.]+)\s*(?:\/\s*10)?/i.exec(text);
  if (scM) {
    result.final_score = parseFloat(scM[1]);
    logs.push('NOTA detectada: ' + scM[1] + '/10');
  }

  // Derive final_score from formula if missing
  if (result.formula_result !== undefined && result.final_score === undefined) {
    result.final_score = result.formula_result;
  }

  // Fallback log: score found but no criteria
  if (result.final_score !== undefined && !result.criteria) {
    logs.push('Se detectó nota final pero no se pudo reconstruir la rúbrica');
    logs.push('Intentar parser flexible de criterios sueltos (ver logs de variable)');
  }

  result._logs = logs;
  return result;
}

/**
 * Extract candidate-level data from the document header (first ~4000 chars).
 */
function extractCandidateLocal(headerText) {
  const result = {};
  let m;

  const RX_NAME   = /(?:candidato|candidate|nombre\s+del\s+candidato)\s*[:\-]\s*(.+)/i;
  const RX_PARTY  = /(?:partido|movimiento|agrupaci[oó]n|fuerza\s+\w+|alianza|frente|lista)\s*[:\-]\s*(.+)/i;
  const RX_TOTAL  = /(?:puntaje\s+(?:total|final|global)|total[_\s]score|calificaci[oó]n\s+(?:global|total))\s*[:\-=]\s*([\d.]+)/i;
  const RX_PAGES  = /(?:p[aá]ginas?)\s*[:\-]\s*(\d+)/i;
  const RX_PERIOD = /(?:per[ií]odo|periodo)\s*[:\-]\s*(20\d{2}[-–]20\d{2})/i;

  if ((m = RX_NAME.exec(headerText)))   result.name        = m[1].trim().replace(/^[:\-\s]+/, '');
  if ((m = RX_PARTY.exec(headerText)))  result.party       = m[1].trim().replace(/^[:\-\s]+/, '');
  if ((m = RX_TOTAL.exec(headerText)))  result.total_score = parseFloat(m[1]);
  if ((m = RX_PAGES.exec(headerText)))  result.plan_pages  = parseInt(m[1], 10);
  if ((m = RX_PERIOD.exec(headerText))) result.plan_period = m[1].trim();

  return result;
}

// ─── PHASE 4: AI per variable — narrative only ───────────────────────────────

/**
 * Two bounded AI calls per variable:
 *   Call A — short fields: summary, strengths, weaknesses, gaps, conclusion, criteria_notes
 *   Call B — analysis_sections (10 narrative sections)
 *
 * Hard data (scores) already extracted locally — AI cannot change them.
 */
async function enrichVariableWithAI(varName, blockName, varText, hardData, onProgress) {
  const MAX_CHARS = 7000;
  const inputText = varText.length > MAX_CHARS ? varText.slice(0, MAX_CHARS) : varText;

  const sysMsg = (task) => ({
    role: 'system',
    content: `Eres un analista técnico de planes de gobierno peruanos.
${task}
NO inventes datos. NO modifiques puntajes ya extraídos. Responde en español. Responde SOLO con JSON válido.`
  });

  // ── Call A: short narrative fields ──────────────────────────────────────
  const userMsgA = {
    role: 'user',
    content: `BLOQUE: ${blockName}
VARIABLE: ${varName}
${hardData.criteria ? `PUNTAJES YA EXTRAÍDOS (no cambiar): ${JSON.stringify(hardData.criteria)}` : ''}
${hardData.final_score !== undefined ? `PUNTAJE FINAL YA EXTRAÍDO: ${hardData.final_score}` : ''}

TEXTO DE LA VARIABLE:
${inputText}

Devuelve exactamente este JSON:
{
  "summary": "2-4 oraciones resumiendo la propuesta",
  "strengths": ["fortaleza 1", "fortaleza 2", "fortaleza 3"],
  "weaknesses": ["debilidad 1", "debilidad 2", "debilidad 3"],
  "gaps": ["vacío 1", "vacío 2"],
  "conclusion": "1-2 oraciones de evaluación técnica final",
  "criteria_notes": {
    "diagnostico": "justificación del puntaje D",
    "propuesta": "justificación del puntaje P",
    "medidas": "justificación del puntaje M",
    "implementacion": "justificación del puntaje Im",
    "viabilidad": "justificación del puntaje V",
    "especificidad": "justificación del puntaje E"
  }
}`
  };

  let callA = {};
  try {
    callA = await callAI([sysMsg('Extrae campos narrativos cortos.'), userMsgA], 1400) || {};
  } catch (err) {
    if (err.message === 'TRUNCATED') {
      const short = inputText.slice(0, Math.floor(inputText.length / 2));
      userMsgA.content = userMsgA.content.replace(inputText, short);
      callA = await callAI([sysMsg('Extrae campos narrativos cortos.'), userMsgA], 1400) || {};
    }
    // Non-truncation errors: leave callA as empty, log but don't fail
  }

  await sleep(700);
  if (onProgress) onProgress();

  // ── Call B: analysis sections ────────────────────────────────────────────
  const userMsgB = {
    role: 'user',
    content: `BLOQUE: ${blockName}
VARIABLE: ${varName}

TEXTO DE LA VARIABLE:
${inputText}

Devuelve exactamente este JSON con 10 secciones (2-4 oraciones cada una):
{
  "definicion": "qué evalúa esta variable",
  "importancia": "relevancia para el desarrollo del país",
  "diagnostico_externo": "diagnóstico del contexto peruano en esta área",
  "propuesta_plan": "qué propone exactamente el plan",
  "medidas_concretas": "medidas específicas incluidas",
  "implementacion_necesaria": "qué se necesita para implementar las propuestas",
  "impacto_potencial": "qué impacto tendría si se implementa correctamente",
  "vacios": "qué falta, qué es incompleto o poco convincente",
  "evaluacion_tecnica": "evaluación técnica objetiva de la propuesta",
  "conclusion": "conclusión sintética de esta variable"
}`
  };

  let callB = {};
  try {
    callB = await callAI([sysMsg('Genera 10 secciones de análisis narrativo.'), userMsgB], 3500) || {};
  } catch (err) {
    if (err.message === 'TRUNCATED') {
      const short = inputText.slice(0, Math.floor(inputText.length / 2));
      userMsgB.content = userMsgB.content.replace(inputText, short);
      callB = await callAI([sysMsg('Genera 10 secciones de análisis narrativo.'), userMsgB], 3500) || {};
    }
  }

  await sleep(700);
  if (onProgress) onProgress();

  return { callA, callB };
}

// ─── PHASE 5: Merge (local data takes absolute priority) ─────────────────────

function mergeVariable(localData, hardData, aiA, aiB, blockId) {
  const criteria = hardData.criteria || {};
  const allCrit  = CRITERIA_KEYS.every(k => criteria[k] !== undefined);

  const computedSum   = allCrit
    ? CRITERIA_KEYS.reduce((s, k) => s + criteria[k], 0)
    : undefined;
  const computedScore = computedSum !== undefined
    ? parseFloat(((computedSum / 12) * 10).toFixed(2))
    : undefined;

  const effectiveCritSum = hardData.criteria_sum ?? computedSum ?? null;
  const effectiveFormula = hardData.formula_result
    ?? (effectiveCritSum !== null ? parseFloat(((effectiveCritSum / 12) * 10).toFixed(2)) : null);
  const effectiveScore   = hardData.final_score ?? effectiveFormula;

  const criNotes = {};
  CRITERIA_KEYS.forEach(k => {
    criNotes[k] = aiA?.criteria_notes?.[k] || '';
  });

  return {
    id:           localData.id,
    name:         localData.name,
    block_id:     blockId,

    final_score:  effectiveScore  ?? null,
    rating_label: effectiveScore != null ? RATING(effectiveScore) : null,

    summary:    aiA?.summary    || '',
    strengths:  Array.isArray(aiA?.strengths)  ? aiA.strengths  : [],
    weaknesses: Array.isArray(aiA?.weaknesses) ? aiA.weaknesses : [],
    gaps:       Array.isArray(aiA?.gaps)        ? aiA.gaps       : [],
    conclusion: aiA?.conclusion || '',

    criteria:       allCrit ? criteria : {},
    criteria_sum:   effectiveCritSum,
    formula_result: effectiveFormula,

    score_table: {
      diagnostico:    criteria.diagnostico    ?? null,
      propuesta:      criteria.propuesta       ?? null,
      medidas:        criteria.medidas         ?? null,
      implementacion: criteria.implementacion  ?? null,
      viabilidad:     criteria.viabilidad      ?? null,
      especificidad:  criteria.especificidad   ?? null,
      sum:            effectiveCritSum,
      final:          effectiveScore ?? null
    },

    corrected_methodology: false,
    correction_note:       null,
    criteria_notes:        criNotes,

    analysis_sections: {
      definicion:               aiB?.definicion               || '',
      importancia:              aiB?.importancia              || '',
      diagnostico_externo:      aiB?.diagnostico_externo      || '',
      propuesta_plan:           aiB?.propuesta_plan           || '',
      medidas_concretas:        aiB?.medidas_concretas        || '',
      implementacion_necesaria: aiB?.implementacion_necesaria || '',
      impacto_potencial:        aiB?.impacto_potencial        || '',
      vacios:                   aiB?.vacios                   || '',
      evaluacion_tecnica:       aiB?.evaluacion_tecnica       || '',
      conclusion:               aiB?.conclusion               || ''
    },

    sources: []
  };
}

// ─── PHASE 6: Candidate + methodology metadata ────────────────────────────────

async function extractCandidateData(fullText) {
  const header = fullText.slice(0, 4000);
  const local  = extractCandidateLocal(header);

  if (local.name && local.party) return local;

  // AI fallback — only if local parsing didn't get essentials
  const messages = [
    {
      role: 'system',
      content: 'Eres un extractor de metadatos de planes de gobierno. Responde SOLO con JSON válido en español.'
    },
    {
      role: 'user',
      content: `Texto del encabezado del plan de gobierno:
${header}

Extrae y devuelve SOLO este JSON (todos los campos en español):
{
  "name": "nombre completo del candidato",
  "party": "nombre del partido o movimiento político",
  "plan_period": "período (ej: 2026-2031)",
  "plan_pages": null,
  "summary": "resumen del plan en 2-3 oraciones"
}`
    }
  ];

  let ai = {};
  try {
    ai = await callAI(messages, 500) || {};
    await sleep(700);
  } catch (_) {}

  return {
    name:        local.name        || ai.name        || 'Candidato sin identificar',
    party:       local.party       || ai.party       || 'Partido sin identificar',
    plan_period: local.plan_period || ai.plan_period || '2026-2031',
    plan_pages:  local.plan_pages  || ai.plan_pages  || null,
    total_score: local.total_score || null,
    summary:     ai.summary        || '',
    color:       null
  };
}

async function extractMethodology(fullText) {
  const searchText = fullText.slice(0, Math.min(fullText.length, 6000));

  const messages = [
    {
      role: 'system',
      content: 'Extractor de metodología de evaluación. Responde SOLO con JSON válido.'
    },
    {
      role: 'user',
      content: `Texto inicial del plan de gobierno:
${searchText}

Extrae información sobre la metodología de evaluación y devuelve:
{
  "evaluation_method": "descripción del método o null",
  "scoring_scale": "descripción de la escala o null",
  "criteria_description": {
    "diagnostico": "qué evalúa el criterio D",
    "propuesta": "qué evalúa el criterio P",
    "medidas": "qué evalúa el criterio M",
    "implementacion": "qué evalúa el criterio Im",
    "viabilidad": "qué evalúa el criterio V",
    "especificidad": "qué evalúa el criterio E"
  },
  "formula": "descripción de la fórmula",
  "analysts": [],
  "review_date": null
}`
    }
  ];

  try {
    const ai = await callAI(messages, 700) || {};
    await sleep(700);
    return ai;
  } catch (_) {
    return {};
  }
}

// ─── Block-level aggregation ─────────────────────────────────────────────────

function aggregateBlock(blockDef, variables) {
  const scores = variables.map(v => v.final_score).filter(s => typeof s === 'number');
  const avg = scores.length > 0
    ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2))
    : null;

  return {
    id:            blockDef.id,
    name:          blockDef.name,
    average_score: avg,
    color:         null,
    summary:       '',
    strengths:     [],
    weaknesses:    [],
    interpretation: '',
    variables
  };
}

// ─── PHASE 8: Strict validation ───────────────────────────────────────────────

function validateJSON(json) {
  const errors = [];

  if (!json.candidate)            errors.push('Falta candidate');
  if (!json.candidate?.name)      errors.push('Falta candidate.name');
  if (!json.candidate?.party)     errors.push('Falta candidate.party');
  if (!json.methodology)          errors.push('Falta methodology');
  if (!Array.isArray(json.blocks)) { errors.push('Falta blocks'); return errors; }

  if (json.blocks.length !== 8)
    errors.push(`Se esperan 8 bloques, se encontraron ${json.blocks.length}`);

  const blockIds = new Set();
  let totalVars = 0;

  for (const block of json.blocks) {
    if (blockIds.has(block.id)) errors.push(`Bloque duplicado: ${block.id}`);
    blockIds.add(block.id);

    if (!block.name) errors.push(`Bloque sin nombre: ${block.id}`);
    if (!Array.isArray(block.variables) || block.variables.length === 0)
      errors.push(`Bloque vacío: ${block.name}`);

    const varIds = new Set();
    for (const v of (block.variables || [])) {
      totalVars++;
      if (varIds.has(v.id)) errors.push(`Variable duplicada: ${v.id} en bloque "${block.name}"`);
      varIds.add(v.id);

      const required = [
        'id','name','final_score','rating_label','summary','strengths',
        'weaknesses','gaps','conclusion','criteria','criteria_sum',
        'formula_result','score_table','analysis_sections'
      ];
      for (const f of required) {
        if (v[f] === undefined) errors.push(`Variable "${v.name}": falta campo "${f}"`);
      }

      if (v.criteria && typeof v.criteria === 'object') {
        for (const k of CRITERIA_KEYS) {
          if (v.criteria[k] === undefined)
            errors.push(`Variable "${v.name}": falta criteria.${k}`);
        }
      }
    }
  }

  if (json.blocks.length === 8 && totalVars !== 30)
    errors.push(`Se esperan 30 variables en total, se encontraron ${totalVars}`);

  return errors;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

function cacheKey(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
function cacheRead(hash) {
  const p = path.join(CACHE_DIR, `${hash}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return obj._validated ? obj : null;
  } catch { return null; }
}
function cacheWrite(hash, obj) {
  fs.writeFileSync(path.join(CACHE_DIR, `${hash}.json`), JSON.stringify(obj, null, 2));
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function processDocx(buffer, onProgress) {
  const hash   = cacheKey(buffer);
  const cached = cacheRead(hash);
  if (cached) {
    onProgress?.({ phase: 'cache', message: 'Usando resultado en caché (ya validado)', pct: 100 });
    return { success: true, json: cached };
  }

  // ── Phase 1 ────────────────────────────────────────────────────────────
  onProgress?.({ phase: '1', message: 'Extrayendo texto del DOCX…', pct: 2 });
  const fullText = await extractText(buffer);
  if (!fullText || fullText.length < 200) {
    return { success: false, errors: ['El documento está vacío o no contiene texto extraíble'] };
  }

  // ── Phase 2 ────────────────────────────────────────────────────────────
  onProgress?.({ phase: '2', message: 'Detectando bloques y variables localmente…', pct: 8 });
  const { blocks, parseLog } = parseStructure(fullText);
  const totalBlocks = blocks.length;
  const totalVars   = blocks.reduce((s, b) => s + b.variables.length, 0);

  // Emit deduplication log to frontend
  for (const msg of parseLog) {
    onProgress?.({ phase: '2', message: msg, pct: 10 });
  }

  onProgress?.({
    phase: '2',
    message: `Estructura deduplicada: ${totalBlocks} bloque(s), ${totalVars} variable(s)`,
    pct: 12
  });

  if (totalBlocks === 0) {
    return {
      success: false,
      errors: ['No se detectaron bloques. El documento debe usar encabezados tipo "BLOQUE 1: Nombre".']
    };
  }
  if (totalVars === 0) {
    return {
      success: false,
      errors: ['No se detectaron variables. El documento debe usar encabezados tipo "Variable 1: Nombre".']
    };
  }

  // ── Phase 3 ────────────────────────────────────────────────────────────
  onProgress?.({ phase: '3', message: 'Extrayendo rúbricas y puntajes localmente…', pct: 15 });

  let critFound     = 0;
  const critMissing = [];

  for (const block of blocks) {
    for (const v of block.variables) {
      v.hardData = extractHardData(v.text || '');

      // Emit per-variable logs from the parser (_logs array)
      for (const logLine of (v.hardData._logs || [])) {
        onProgress?.({ phase: '3', message: `[${v.name}] ${logLine}`, pct: 15 });
      }

      const c = v.hardData.criteria;
      if (c && Object.keys(c).length === 6) {
        critFound++;
        onProgress?.({
          phase: '3',
          message: `Rúbrica extraída: ${v.name} → D=${c.diagnostico} P=${c.propuesta} M=${c.medidas} I=${c.implementacion} V=${c.viabilidad} E=${c.especificidad} (${v.hardData._parseNote})`,
          pct: 15
        });
      } else {
        critMissing.push(v.name);
        onProgress?.({
          phase: '3',
          message: `No se pudo extraer rúbrica en: ${v.name} (${v.hardData._parseNote || 'sin patrón'}) — texto inicio: "${(v.text || '').slice(0, 120).replace(/\n/g, ' ')}"`,
          pct: 15
        });
      }
    }
  }

  const varsWithScores = blocks.flatMap(b => b.variables).filter(v => v.hardData?.final_score !== undefined).length;

  if (critMissing.length > 0) {
    onProgress?.({ phase: '3', message: `Variables sin rúbrica: ${critMissing.join(' | ')}`, pct: 16 });
  }

  onProgress?.({
    phase: '3',
    message: `Fase 3 completada: ${critFound}/${totalVars} variables con rúbrica completa, ${varsWithScores}/${totalVars} con puntaje final`,
    pct: 17
  });

  // ── Phase 6 ────────────────────────────────────────────────────────────
  onProgress?.({ phase: '6', message: 'Extrayendo metadatos del candidato…', pct: 18 });
  const candidateMeta = await extractCandidateData(fullText);

  onProgress?.({ phase: '6', message: 'Extrayendo metodología…', pct: 20 });
  const methodology   = await extractMethodology(fullText);

  const candidateId = slug(candidateMeta.name || 'candidato');

  // ── Phase 4 + 5 ────────────────────────────────────────────────────────
  const aiCallsTotal = totalVars * 2;
  let   aiCallsDone  = 0;
  const PCT_START = 22;
  const PCT_END   = 92;

  const processedBlocks = [];

  for (const block of blocks) {
    const processedVars = [];

    for (const v of block.variables) {
      onProgress?.({
        phase: '4',
        message: `IA: "${v.name}" (bloque: ${block.name})`,
        pct: Math.round(PCT_START + (aiCallsDone / aiCallsTotal) * (PCT_END - PCT_START))
      });

      let aiA = {}, aiB = {};
      try {
        const { callA, callB } = await enrichVariableWithAI(
          v.name, block.name, v.text || '', v.hardData || {},
          () => {
            aiCallsDone++;
            onProgress?.({
              phase: '4',
              message: `Llamada IA ${aiCallsDone}/${aiCallsTotal} completada`,
              pct: Math.round(PCT_START + (aiCallsDone / aiCallsTotal) * (PCT_END - PCT_START))
            });
          }
        );
        aiA = callA || {};
        aiB = callB || {};
      } catch (err) {
        onProgress?.({
          phase: '4',
          message: `Advertencia: fallo IA en "${v.name}": ${err.message}`,
          pct: Math.round(PCT_START + (aiCallsDone / aiCallsTotal) * (PCT_END - PCT_START))
        });
        aiCallsDone += 2;
      }

      processedVars.push(mergeVariable(v, v.hardData || {}, aiA, aiB, block.id));
    }

    processedBlocks.push(aggregateBlock(block, processedVars));
  }

  // ── Phase 7 ────────────────────────────────────────────────────────────
  onProgress?.({ phase: '7', message: 'Ensamblando JSON final…', pct: 93 });

  const allScores = processedBlocks
    .flatMap(b => b.variables)
    .map(v => v.final_score)
    .filter(s => typeof s === 'number');
  const totalScore = allScores.length > 0
    ? parseFloat((allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(2))
    : null;

  const finalJSON = {
    _schema_version: '2.0',
    candidate: {
      id:                         candidateId,
      name:                       candidateMeta.name,
      party:                      candidateMeta.party,
      color:                      candidateMeta.color       || null,
      plan_period:                candidateMeta.plan_period || '2026-2031',
      plan_pages:                 candidateMeta.plan_pages  || null,
      total_score:                candidateMeta.total_score || totalScore,
      ranking_position:           null,
      summary:                    candidateMeta.summary     || '',
      strengths:                  [],
      weaknesses:                 [],
      methodological_notes:       [],
      methodological_corrections: []
    },
    methodology: {
      evaluation_method:    methodology.evaluation_method    || '',
      scoring_scale:        methodology.scoring_scale        || '0–2 por criterio, (suma/12)×10',
      criteria_description: methodology.criteria_description || {},
      formula:              methodology.formula              || '(suma_criterios / 12) × 10',
      analysts:             methodology.analysts             || [],
      review_date:          methodology.review_date          || null
    },
    blocks: processedBlocks
  };

  // ── Phase 8 ────────────────────────────────────────────────────────────
  onProgress?.({ phase: '8', message: 'Validando JSON estrictamente…', pct: 96 });
  const errors = validateJSON(finalJSON);

  if (errors.length > 0) {
    return {
      success: false,
      errors,
      partial: finalJSON,
      structureFound: { blocks: totalBlocks, variables: totalVars }
    };
  }

  // ── Save to cache ────────────────────────────────────────────────────
  finalJSON._validated = true;
  cacheWrite(hash, finalJSON);
  delete finalJSON._validated;

  onProgress?.({ phase: 'done', message: 'Proceso completado exitosamente', pct: 100 });

  return { success: true, json: finalJSON };
}

module.exports = { processDocx };
