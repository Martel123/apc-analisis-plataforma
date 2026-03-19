const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const multer   = require('multer');
const { processDocx } = require('./converter/docx-processor');

const app  = express();
const PORT = 3000;
const ANALISIS_DIR = path.join(__dirname, 'analisis');
const UPLOADS_DIR  = path.join(__dirname, 'uploads', 'docx');

// Crear carpetas si no existen
if (!fs.existsSync(ANALISIS_DIR)) fs.mkdirSync(ANALISIS_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR))  fs.mkdirSync(UPLOADS_DIR,  { recursive: true });

app.use(express.static(path.join(__dirname)));

// ── In-memory job store ────────────────────────────────────────────────────────

/**
 * jobId → {
 *   status: 'queued' | 'running' | 'done' | 'error',
 *   pct: 0-100,
 *   logs: string[],
 *   result: object | null,
 *   error: string | null,
 *   errors: string[] | null,
 *   structureFound: object | null,
 *   createdAt: Date
 * }
 */
const jobs = new Map();

function newJob() {
  const id = crypto.randomBytes(8).toString('hex');
  jobs.set(id, {
    status:         'queued',
    pct:            0,
    logs:           [],
    result:         null,
    error:          null,
    errors:         null,
    structureFound: null,
    createdAt:      new Date()
  });
  return id;
}

function jobLog(id, msg) {
  const job = jobs.get(id);
  if (!job) return;
  job.logs.push(msg);
  console.log(`[job:${id}]`, msg);
}

// Expire completed jobs after 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt.getTime() < cutoff) jobs.delete(id);
  }
}, 5 * 60 * 1000);

// ── Multer: recibe sólo DOCX ──────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      file.originalname.toLowerCase().endsWith('.docx');
    if (!ok) return cb(new Error('Solo se aceptan archivos .docx'));
    cb(null, true);
  }
});

// ── POST /api/convert — recibe el archivo y lanza job en background ───────────

app.post('/api/convert', upload.single('docx'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'No se recibió ningún archivo DOCX.' });
  }

  const jobId    = newJob();
  const filePath = req.file.path;
  const fileName = req.file.originalname;

  // Responder inmediatamente con el jobId — no esperar el procesamiento
  res.json({ ok: true, jobId, message: 'Procesamiento iniciado' });

  // Lanzar el procesamiento en el siguiente tick (no bloquea el servidor)
  setImmediate(() => runJob(jobId, filePath, fileName));
});

// ── Background job runner ─────────────────────────────────────────────────────

async function runJob(jobId, filePath, fileName) {
  const job = jobs.get(jobId);
  job.status = 'running';

  const log = (msg) => jobLog(jobId, msg);
  const progress = (update) => {
    const msg = typeof update === 'string'
      ? update
      : `[Fase ${update.phase}] ${update.message}`;
    job.pct = typeof update === 'object' ? (update.pct || job.pct) : job.pct;
    jobLog(jobId, msg);
  };

  log(`Iniciando conversión: ${fileName}`);

  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
    log(`Archivo leído: ${(buffer.length / 1024).toFixed(0)} KB`);
  } catch (err) {
    job.pct    = 100;
    job.status = 'error';
    job.error  = `No se pudo leer el archivo subido: ${err.message}`;
    log(`ERROR: ${job.error}`);
    return;
  } finally {
    try { fs.unlinkSync(filePath); } catch (_) {}
  }

  let result;
  try {
    result = await processDocx(buffer, progress);
  } catch (err) {
    job.pct    = 100;
    job.status = 'error';
    job.error  = `Error inesperado en el procesador: ${err.message}`;
    log(`ERROR fatal: ${err.message}`);
    if (err.stack) log(err.stack.split('\n')[1] || '');
    return;
  }

  // Always reach 100% visually — success or validation failure
  job.pct = 100;

  if (!result.success) {
    log(`Procesamiento técnico: completado (100%)`);
    log(`Validación final: FALLIDA — ${result.errors?.length || 0} error(es)`);
    job.status         = 'error';
    job.errors         = result.errors || ['Error desconocido'];
    job.structureFound = result.structureFound || null;
    return;
  }

  // Guardar en /analisis
  try {
    const json = result.json;
    json._converted_from_docx = true;
    json._converted_at = new Date().toISOString();

    const candidateId = json.candidate?.id || 'candidato';
    const outputFile  = path.join(ANALISIS_DIR, `${candidateId}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(json, null, 2), 'utf8');

    const totalScore = json.candidate?.total_score ?? null;
    const totalVars  = json.blocks?.reduce((s, b) => s + (b.variables?.length || 0), 0) ?? 0;

    job.status = 'done';
    job.result = {
      candidateId,
      outputFile:  path.basename(outputFile),
      totalScore,
      blocks:      json.blocks?.length ?? 0,
      totalVars,
      message:     `Conversión exitosa → /analisis/${path.basename(outputFile)}`
    };
    log(`Completado: candidato="${json.candidate?.name}", ${totalVars} variables, puntaje=${totalScore}`);
  } catch (err) {
    job.status = 'error';
    job.error  = `Error al guardar el JSON: ${err.message}`;
    log(`ERROR al guardar: ${err.message}`);
  }
}

// ── GET /api/job/:jobId — polling de progreso ─────────────────────────────────

app.get('/api/job/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ ok: false, error: 'Job no encontrado o expirado' });
  }
  res.json({
    ok:             true,
    status:         job.status,
    pct:            job.pct,
    logs:           job.logs,
    result:         job.result,
    error:          job.error,
    errors:         job.errors,
    structureFound: job.structureFound
  });
});

// ── GET /api/convert/status — lista de candidatos convertidos ─────────────────

app.get('/api/convert/status', (_req, res) => {
  try {
    const files = fs.readdirSync(ANALISIS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(ANALISIS_DIR, f), 'utf8'));
          return {
            file:        f,
            name:        data.candidate?.name || '—',
            totalScore:  data.candidate?.total_score,
            fromDocx:    !!data._converted_from_docx,
            convertedAt: data._converted_at || null
          };
        } catch (_) {
          return { file: f, name: '(error)', fromDocx: false };
        }
      })
      .sort((a, b) => (b.convertedAt || '').localeCompare(a.convertedAt || ''));

    res.json({ ok: true, candidates: files });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── GET /api/candidates ────────────────────────────────────────────────────────

app.get('/api/candidates', (_req, res) => {
  if (!fs.existsSync(ANALISIS_DIR)) {
    return res.json({ candidates: [], count: 0 });
  }

  const files = fs.readdirSync(ANALISIS_DIR).filter(f => f.endsWith('.json'));
  const candidates = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(ANALISIS_DIR, file), 'utf8');
      const data    = JSON.parse(content);
      candidates.push({ ...data, _file: file, _valid: true });
    } catch (e) {
      candidates.push({ _file: file, _valid: false, _error: e.message });
    }
  }

  res.json({ candidates, count: candidates.length });
});

// ── GET /api/validate ─────────────────────────────────────────────────────────

app.get('/api/validate', (_req, res) => {
  if (!fs.existsSync(ANALISIS_DIR)) {
    return res.json({ reports: [], error: 'Carpeta /analisis no encontrada' });
  }

  const files   = fs.readdirSync(ANALISIS_DIR).filter(f => f.endsWith('.json'));
  const reports = [];

  for (const file of files) {
    const report = { file, issues: [], warnings: [], ok: false };

    try {
      const content = fs.readFileSync(path.join(ANALISIS_DIR, file), 'utf8');
      const data    = JSON.parse(content);

      if (!data.candidate) {
        report.issues.push('Falta el objeto raíz "candidate"');
      } else {
        const c = data.candidate;
        for (const f of ['id', 'name', 'party', 'total_score']) {
          if (c[f] === undefined || c[f] === null || c[f] === '')
            report.issues.push(`candidate.${f} es obligatorio y está vacío`);
        }
        const recommended = ['color', 'plan_period', 'plan_pages', 'summary', 'strengths', 'weaknesses', 'methodological_notes'];
        for (const f of recommended) {
          if (c[f] === undefined) report.warnings.push(`candidate.${f} recomendado pero falta`);
        }
        if (c.methodological_corrections !== undefined && !Array.isArray(c.methodological_corrections))
          report.issues.push('candidate.methodological_corrections debe ser un array');
      }

      if (!data.blocks || !Array.isArray(data.blocks)) {
        report.issues.push('Falta el array "blocks"');
      } else {
        if (data.blocks.length === 0) report.warnings.push('El array "blocks" está vacío');

        data.blocks.forEach((block, bi) => {
          if (!block.id)   report.issues.push(`blocks[${bi}] le falta "id"`);
          if (!block.name) report.issues.push(`blocks[${bi}] le falta "name"`);
          if (block.average_score === undefined) report.warnings.push(`blocks[${bi}] le falta "average_score"`);
          if (!block.summary) report.warnings.push(`blocks[${bi}] (${block.name || bi}) le falta "summary"`);

          if (!block.variables || !Array.isArray(block.variables)) {
            report.warnings.push(`blocks[${bi}] (${block.name || bi}) no tiene variables`);
          } else {
            block.variables.forEach((v, vi) => {
              const vkey = `blocks[${bi}].variables[${vi}]`;
              if (!v.id)   report.issues.push(`${vkey} le falta "id"`);
              if (!v.name) report.issues.push(`${vkey} le falta "name"`);
              if (v.final_score === undefined) report.warnings.push(`${vkey} le falta "final_score"`);
              if (!v.summary) report.warnings.push(`${vkey} le falta "summary"`);

              if (!v.criteria) {
                report.warnings.push(`${vkey} le falta el objeto "criteria"`);
              } else {
                const criterios = ['diagnostico', 'propuesta', 'medidas', 'implementacion', 'viabilidad', 'especificidad'];
                for (const cr of criterios) {
                  if (v.criteria[cr] === undefined) {
                    report.warnings.push(`${vkey}.criteria.${cr} falta`);
                  } else if (![0, 1, 2].includes(v.criteria[cr])) {
                    report.warnings.push(`${vkey}.criteria.${cr} debe ser 0, 1 o 2 (tiene: ${v.criteria[cr]})`);
                  }
                }
              }

              const SECTIONS = ['definicion','importancia','diagnostico_externo','propuesta_plan','medidas_concretas','implementacion_necesaria','impacto_potencial','vacios','evaluacion_tecnica','conclusion'];
              if (!v.analysis_sections) {
                report.warnings.push(`${vkey} le falta "analysis_sections"`);
              } else {
                for (const s of SECTIONS) {
                  if (!v.analysis_sections[s]) report.warnings.push(`${vkey}.analysis_sections.${s} está vacío`);
                }
              }

              if (v.sources !== undefined && !Array.isArray(v.sources)) {
                report.issues.push(`${vkey}.sources debe ser un array`);
              }
              if (v.corrected_methodology && !v.correction_note) {
                report.warnings.push(`${vkey} marca corrected_methodology=true pero le falta "correction_note"`);
              }
            });
          }
        });
      }

      if (!data.final_analysis) {
        report.warnings.push('Falta el objeto "final_analysis"');
      } else if (!data.final_analysis.final_conclusion) {
        report.warnings.push('final_analysis.final_conclusion está vacío');
      }

      report.ok = report.issues.length === 0;
    } catch (e) {
      report.issues.push(`Error al parsear JSON: ${e.message}`);
    }

    reports.push(report);
  }

  res.json({ reports, total: files.length });
});

// ── Global error handler ──────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('[server] Error no capturado:', err.message);
  res.status(500).json({ ok: false, error: err.message });
});

// ── Iniciar servidor ──────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor corriendo en http://0.0.0.0:${PORT}`);
  console.log(`Leyendo candidatos desde: ${ANALISIS_DIR}`);
  console.log(`Conversor DOCX activo en: POST /api/convert + GET /api/job/:jobId`);
  if (!process.env.OPENAI_API_KEY) {
    console.warn('⚠ OPENAI_API_KEY no configurada. El conversor DOCX no funcionará.');
  }
});
