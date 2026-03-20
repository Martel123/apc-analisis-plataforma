const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
// const { processDocx } = require("./converter/docx-processor");
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  AlignmentType,
  WidthType,
  BorderStyle,
  ShadingType,
} = require("docx");

const app = express();
const PORT = process.env.PORT || 3000;
const ANALISIS_DIR = path.join(__dirname, "analisis");
const UPLOADS_DIR = path.join(__dirname, "uploads", "docx");

// Crear carpetas si no existen
if (!fs.existsSync(ANALISIS_DIR))
  fs.mkdirSync(ANALISIS_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

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
  const id = crypto.randomBytes(8).toString("hex");
  jobs.set(id, {
    status: "queued",
    pct: 0,
    logs: [],
    result: null,
    error: null,
    errors: null,
    structureFound: null,
    createdAt: new Date(),
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
setInterval(
  () => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, job] of jobs) {
      if (job.createdAt.getTime() < cutoff) jobs.delete(id);
    }
  },
  5 * 60 * 1000,
);

// ── Multer: recibe sólo DOCX ──────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      file.originalname.toLowerCase().endsWith(".docx");
    if (!ok) return cb(new Error("Solo se aceptan archivos .docx"));
    cb(null, true);
  },
});

// ── POST /api/convert — recibe el archivo y lanza job en background ───────────

app.post("/api/convert", upload.single("docx"), (req, res) => {
  if (!req.file) {
    return res
      .status(400)
      .json({ ok: false, error: "No se recibió ningún archivo DOCX." });
  }

  const jobId = newJob();
  const filePath = req.file.path;
  const fileName = req.file.originalname;

  // Responder inmediatamente con el jobId — no esperar el procesamiento
  res.json({ ok: true, jobId, message: "Procesamiento iniciado" });

  // Lanzar el procesamiento en el siguiente tick (no bloquea el servidor)
  setImmediate(() => runJob(jobId, filePath, fileName));
});

// ── Background job runner ─────────────────────────────────────────────────────

async function runJob(jobId, filePath, fileName) {
  const job = jobs.get(jobId);
  job.status = "running";

  const log = (msg) => jobLog(jobId, msg);
  const progress = (update) => {
    const msg =
      typeof update === "string"
        ? update
        : `[Fase ${update.phase}] ${update.message}`;
    job.pct = typeof update === "object" ? update.pct || job.pct : job.pct;
    jobLog(jobId, msg);
  };

  log(`Iniciando conversión: ${fileName}`);

  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
    log(`Archivo leído: ${(buffer.length / 1024).toFixed(0)} KB`);
  } catch (err) {
    job.pct = 100;
    job.status = "error";
    job.error = `No se pudo leer el archivo subido: ${err.message}`;
    log(`ERROR: ${job.error}`);
    return;
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch (_) {}
  }

  let result;
  try {
    result = await processDocx(buffer, progress);
  } catch (err) {
    job.pct = 100;
    job.status = "error";
    job.error = `Error inesperado en el procesador: ${err.message}`;
    log(`ERROR fatal: ${err.message}`);
    if (err.stack) log(err.stack.split("\n")[1] || "");
    return;
  }

  // Always reach 100% visually — success or validation failure
  job.pct = 100;

  if (!result.success) {
    log(`Procesamiento técnico: completado (100%)`);
    log(`Validación final: FALLIDA — ${result.errors?.length || 0} error(es)`);
    job.status = "error";
    job.errors = result.errors || ["Error desconocido"];
    job.structureFound = result.structureFound || null;
    return;
  }

  // Guardar en /analisis
  try {
    const json = result.json;
    json._converted_from_docx = true;
    json._converted_at = new Date().toISOString();

    const candidateId = json.candidate?.id || "candidato";
    const outputFile = path.join(ANALISIS_DIR, `${candidateId}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(json, null, 2), "utf8");

    const totalScore = json.candidate?.total_score ?? null;
    const totalVars =
      json.blocks?.reduce((s, b) => s + (b.variables?.length || 0), 0) ?? 0;

    job.status = "done";
    job.result = {
      candidateId,
      outputFile: path.basename(outputFile),
      totalScore,
      blocks: json.blocks?.length ?? 0,
      totalVars,
      message: `Conversión exitosa → /analisis/${path.basename(outputFile)}`,
    };
    log(
      `Completado: candidato="${json.candidate?.name}", ${totalVars} variables, puntaje=${totalScore}`,
    );
  } catch (err) {
    job.status = "error";
    job.error = `Error al guardar el JSON: ${err.message}`;
    log(`ERROR al guardar: ${err.message}`);
  }
}

// ── GET /api/job/:jobId — polling de progreso ─────────────────────────────────

app.get("/api/job/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res
      .status(404)
      .json({ ok: false, error: "Job no encontrado o expirado" });
  }
  res.json({
    ok: true,
    status: job.status,
    pct: job.pct,
    logs: job.logs,
    result: job.result,
    error: job.error,
    errors: job.errors,
    structureFound: job.structureFound,
  });
});

// ── GET /api/convert/status — lista de candidatos convertidos ─────────────────

app.get("/api/convert/status", (_req, res) => {
  try {
    const files = fs
      .readdirSync(ANALISIS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const data = JSON.parse(
            fs.readFileSync(path.join(ANALISIS_DIR, f), "utf8"),
          );
          return {
            file: f,
            name: data.candidate?.name || "—",
            totalScore: data.candidate?.total_score,
            fromDocx: !!data._converted_from_docx,
            convertedAt: data._converted_at || null,
          };
        } catch (_) {
          return { file: f, name: "(error)", fromDocx: false };
        }
      })
      .sort((a, b) => (b.convertedAt || "").localeCompare(a.convertedAt || ""));

    res.json({ ok: true, candidates: files });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── GET /api/candidates ────────────────────────────────────────────────────────

app.get("/api/candidates", (_req, res) => {
  if (!fs.existsSync(ANALISIS_DIR)) {
    return res.json({ candidates: [], count: 0 });
  }

  const files = fs.readdirSync(ANALISIS_DIR).filter((f) => f.endsWith(".json"));
  const candidates = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(ANALISIS_DIR, file), "utf8");
      const data = JSON.parse(content);
      candidates.push({ ...data, _file: file, _valid: true });
    } catch (e) {
      candidates.push({ _file: file, _valid: false, _error: e.message });
    }
  }

  res.json({ candidates, count: candidates.length });
});

// ── GET /api/validate ─────────────────────────────────────────────────────────

app.get("/api/validate", (_req, res) => {
  if (!fs.existsSync(ANALISIS_DIR)) {
    return res.json({ reports: [], error: "Carpeta /analisis no encontrada" });
  }

  const files = fs.readdirSync(ANALISIS_DIR).filter((f) => f.endsWith(".json"));
  const reports = [];

  for (const file of files) {
    const report = { file, issues: [], warnings: [], ok: false };

    try {
      const content = fs.readFileSync(path.join(ANALISIS_DIR, file), "utf8");
      const data = JSON.parse(content);

      if (!data.candidate) {
        report.issues.push('Falta el objeto raíz "candidate"');
      } else {
        const c = data.candidate;
        for (const f of ["id", "name", "party", "total_score"]) {
          if (c[f] === undefined || c[f] === null || c[f] === "")
            report.issues.push(`candidate.${f} es obligatorio y está vacío`);
        }
        const recommended = [
          "color",
          "plan_period",
          "plan_pages",
          "summary",
          "strengths",
          "weaknesses",
          "methodological_notes",
        ];
        for (const f of recommended) {
          if (c[f] === undefined)
            report.warnings.push(`candidate.${f} recomendado pero falta`);
        }
        if (
          c.methodological_corrections !== undefined &&
          !Array.isArray(c.methodological_corrections)
        )
          report.issues.push(
            "candidate.methodological_corrections debe ser un array",
          );
      }

      if (!data.blocks || !Array.isArray(data.blocks)) {
        report.issues.push('Falta el array "blocks"');
      } else {
        if (data.blocks.length === 0)
          report.warnings.push('El array "blocks" está vacío');

        data.blocks.forEach((block, bi) => {
          if (!block.id) report.issues.push(`blocks[${bi}] le falta "id"`);
          if (!block.name) report.issues.push(`blocks[${bi}] le falta "name"`);
          if (block.average_score === undefined)
            report.warnings.push(`blocks[${bi}] le falta "average_score"`);
          if (!block.summary)
            report.warnings.push(
              `blocks[${bi}] (${block.name || bi}) le falta "summary"`,
            );

          if (!block.variables || !Array.isArray(block.variables)) {
            report.warnings.push(
              `blocks[${bi}] (${block.name || bi}) no tiene variables`,
            );
          } else {
            block.variables.forEach((v, vi) => {
              const vkey = `blocks[${bi}].variables[${vi}]`;
              if (!v.id) report.issues.push(`${vkey} le falta "id"`);
              if (!v.name) report.issues.push(`${vkey} le falta "name"`);
              if (v.final_score === undefined)
                report.warnings.push(`${vkey} le falta "final_score"`);
              if (!v.summary)
                report.warnings.push(`${vkey} le falta "summary"`);

              if (!v.criteria) {
                report.warnings.push(`${vkey} le falta el objeto "criteria"`);
              } else {
                const criterios = [
                  "diagnostico",
                  "propuesta",
                  "medidas",
                  "implementacion",
                  "viabilidad",
                  "especificidad",
                ];
                for (const cr of criterios) {
                  if (v.criteria[cr] === undefined) {
                    report.warnings.push(`${vkey}.criteria.${cr} falta`);
                  } else if (![0, 1, 2].includes(v.criteria[cr])) {
                    report.warnings.push(
                      `${vkey}.criteria.${cr} debe ser 0, 1 o 2 (tiene: ${v.criteria[cr]})`,
                    );
                  }
                }
              }

              const SECTIONS = [
                "definicion",
                "importancia",
                "diagnostico_externo",
                "propuesta_plan",
                "medidas_concretas",
                "implementacion_necesaria",
                "impacto_potencial",
                "vacios",
                "evaluacion_tecnica",
                "conclusion",
              ];
              if (!v.analysis_sections) {
                report.warnings.push(`${vkey} le falta "analysis_sections"`);
              } else {
                for (const s of SECTIONS) {
                  if (!v.analysis_sections[s])
                    report.warnings.push(
                      `${vkey}.analysis_sections.${s} está vacío`,
                    );
                }
              }

              if (v.sources !== undefined && !Array.isArray(v.sources)) {
                report.issues.push(`${vkey}.sources debe ser un array`);
              }
              if (v.corrected_methodology && !v.correction_note) {
                report.warnings.push(
                  `${vkey} marca corrected_methodology=true pero le falta "correction_note"`,
                );
              }
            });
          }
        });
      }

      if (!data.final_analysis) {
        report.warnings.push('Falta el objeto "final_analysis"');
      } else if (!data.final_analysis.final_conclusion) {
        report.warnings.push("final_analysis.final_conclusion está vacío");
      }

      report.ok = report.issues.length === 0;
    } catch (e) {
      report.issues.push(`Error al parsear JSON: ${e.message}`);
    }

    reports.push(report);
  }

  res.json({ reports, total: files.length });
});

// ── Comparison DOCX export ────────────────────────────────────────────────────

function loadCandidateRaw(id) {
  const file = path.join(ANALISIS_DIR, id + ".json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function normCandidate(raw) {
  const cand = raw.candidate || {};
  const blocks = (raw.blocks || []).map((b) => ({
    id: b.id || "bloque",
    name: b.name || "Sin nombre",
    average_score: b.average_score != null ? parseFloat(b.average_score) : null,
    variables: (b.variables || []).map((v) => ({
      id: v.id || "var",
      name: v.name || "Sin nombre",
      final_score: v.final_score != null ? parseFloat(v.final_score) : null,
    })),
    strengths: b.strengths || [],
    weaknesses: b.weaknesses || [],
  }));
  return {
    id: cand.id || raw._file?.replace(".json", "") || id,
    name: cand.name || "Sin nombre",
    party: cand.party || "",
    total_score: cand.total_score != null ? parseFloat(cand.total_score) : null,
    strengths: cand.strengths || [],
    weaknesses: cand.weaknesses || [],
    blocks,
  };
}

function fmt(s) {
  return s != null ? parseFloat(s).toFixed(1) : "—";
}

function scoreLevelText(s) {
  if (s == null) return "Sin datos";
  if (s >= 8) return "Muy sólido";
  if (s >= 6) return "Sólido";
  if (s >= 4) return "Intermedio";
  if (s >= 2) return "Débil";
  return "Muy débil";
}

function makeCell(text, options = {}) {
  const {
    bold = false,
    color = "000000",
    shade = null,
    width = null,
  } = options;
  const cellOptions = {
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: String(text), bold, color })],
      }),
    ],
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
  };
  if (shade) cellOptions.shading = { type: ShadingType.CLEAR, fill: shade };
  if (width) cellOptions.width = { size: width, type: WidthType.DXA };
  return new TableCell(cellOptions);
}

function scoreShade(s) {
  if (s == null) return "DDDDDD";
  if (s >= 8) return "DCFCE7";
  if (s >= 6) return "DBEAFE";
  if (s >= 4) return "FEF3C7";
  if (s >= 2) return "FFEDD5";
  return "FEE2E2";
}

app.post("/api/comparison-docx", async (req, res) => {
  const { ids } = req.body || {};
  if (!ids || !Array.isArray(ids) || ids.length < 2) {
    return res
      .status(400)
      .json({ ok: false, error: "Se requieren al menos 2 ids de candidatos" });
  }

  const candidates = ids
    .map((id) => {
      const raw = loadCandidateRaw(id);
      if (!raw) return null;
      return normCandidate(raw);
    })
    .filter(Boolean);

  if (candidates.length < 2) {
    return res
      .status(400)
      .json({ ok: false, error: "No se encontraron suficientes candidatos" });
  }

  const names = candidates.map((c) => c.name).join(" vs ");
  const allBlockIds = [
    ...new Set(candidates.flatMap((c) => c.blocks.map((b) => b.id))),
  ];
  const blockNames = {};
  candidates
    .flatMap((c) => c.blocks)
    .forEach((b) => {
      blockNames[b.id] = b.name;
    });

  // Sorted by score
  const sorted = [...candidates].sort(
    (a, b) => (b.total_score || 0) - (a.total_score || 0),
  );
  const leader = sorted[0];

  const sections = [];

  // ── Title ─────────────────────────────────────────────────────────────────
  sections.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [
        new TextRun({
          text: "Comparación técnica de planes de gobierno",
          bold: true,
          size: 36,
        }),
      ],
    }),
  );
  sections.push(
    new Paragraph({
      children: [new TextRun({ text: names, color: "777777", size: 24 })],
    }),
  );
  sections.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "Evaluación Técnica · Perú 2026",
          color: "999999",
          size: 20,
        }),
      ],
    }),
  );
  sections.push(new Paragraph({ text: "" }));

  // ── Puntajes generales ────────────────────────────────────────────────────
  sections.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [
        new TextRun({ text: "1. Puntaje total por candidato", bold: true }),
      ],
    }),
  );

  const scoreTable = new Table({
    width: { size: 9000, type: WidthType.DXA },
    rows: [
      new TableRow({
        tableHeader: true,
        children: [
          makeCell("Candidato", { bold: true, shade: "F3F4F6" }),
          makeCell("Partido", { bold: true, shade: "F3F4F6" }),
          makeCell("Puntaje", { bold: true, shade: "F3F4F6" }),
          makeCell("Nivel", { bold: true, shade: "F3F4F6" }),
        ],
      }),
      ...sorted.map(
        (c) =>
          new TableRow({
            children: [
              makeCell(c.name),
              makeCell(c.party || "—"),
              makeCell(fmt(c.total_score), {
                shade: scoreShade(c.total_score),
                bold: true,
              }),
              makeCell(scoreLevelText(c.total_score), {
                shade: scoreShade(c.total_score),
              }),
            ],
          }),
      ),
    ],
  });
  sections.push(scoreTable);
  sections.push(new Paragraph({ text: "" }));

  // ── Tabla por bloques ─────────────────────────────────────────────────────
  sections.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [
        new TextRun({ text: "2. Tabla comparativa por bloques", bold: true }),
      ],
    }),
  );

  const blockTableRows = [
    new TableRow({
      tableHeader: true,
      children: [
        makeCell("Bloque", { bold: true, shade: "F3F4F6" }),
        ...candidates.map((c) =>
          makeCell(c.name, { bold: true, shade: "F3F4F6" }),
        ),
        makeCell("Líder", { bold: true, shade: "F3F4F6" }),
      ],
    }),
    ...allBlockIds.map((bid) => {
      const scores = candidates.map(
        (c) => c.blocks.find((b) => b.id === bid)?.average_score ?? null,
      );
      const max = Math.max(...scores.filter((s) => s !== null));
      const leaderIdx = scores.indexOf(max);
      return new TableRow({
        children: [
          makeCell(blockNames[bid] || bid),
          ...scores.map((s, i) =>
            makeCell(fmt(s), {
              shade: scoreShade(s),
              bold: s === max && s !== null,
            }),
          ),
          makeCell(
            leaderIdx >= 0 ? candidates[leaderIdx].name.split(" ")[0] : "—",
          ),
        ],
      });
    }),
  ];
  sections.push(
    new Table({
      width: { size: 9000, type: WidthType.DXA },
      rows: blockTableRows,
    }),
  );
  sections.push(new Paragraph({ text: "" }));

  // ── Variables destacadas ──────────────────────────────────────────────────
  sections.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [
        new TextRun({
          text: "3. Variables destacadas (top por candidato)",
          bold: true,
        }),
      ],
    }),
  );

  candidates.forEach((c) => {
    const allVars = c.blocks.flatMap((b) =>
      b.variables.map((v) => ({ ...v, blockName: b.name })),
    );
    const top = [...allVars]
      .filter((v) => v.final_score != null)
      .sort((a, b) => b.final_score - a.final_score)
      .slice(0, 5);
    sections.push(
      new Paragraph({
        children: [new TextRun({ text: c.name, bold: true, size: 24 })],
      }),
    );
    top.forEach((v) => {
      sections.push(
        new Paragraph({
          bullet: { level: 0 },
          children: [
            new TextRun({
              text: `${v.name} (${v.blockName}): ${fmt(v.final_score)}/10`,
            }),
          ],
        }),
      );
    });
    sections.push(new Paragraph({ text: "" }));
  });

  // ── Fortalezas ────────────────────────────────────────────────────────────
  sections.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [
        new TextRun({ text: "4. Fortalezas por candidato", bold: true }),
      ],
    }),
  );
  candidates.forEach((c) => {
    const items = [
      ...(c.strengths || []),
      ...(c.blocks || []).flatMap((b) => b.strengths || []),
    ]
      .filter((s, i, a) => s && a.indexOf(s) === i)
      .slice(0, 5);
    sections.push(
      new Paragraph({
        children: [new TextRun({ text: c.name, bold: true, size: 24 })],
      }),
    );
    if (items.length) {
      items.forEach((s) =>
        sections.push(
          new Paragraph({
            bullet: { level: 0 },
            children: [new TextRun({ text: s })],
          }),
        ),
      );
    } else {
      sections.push(
        new Paragraph({
          children: [
            new TextRun({
              text: "Sin fortalezas registradas",
              color: "999999",
            }),
          ],
        }),
      );
    }
    sections.push(new Paragraph({ text: "" }));
  });

  // ── Debilidades ───────────────────────────────────────────────────────────
  sections.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [
        new TextRun({ text: "5. Debilidades por candidato", bold: true }),
      ],
    }),
  );
  candidates.forEach((c) => {
    const items = [
      ...(c.weaknesses || []),
      ...(c.blocks || []).flatMap((b) => b.weaknesses || []),
    ]
      .filter((s, i, a) => s && a.indexOf(s) === i)
      .slice(0, 5);
    sections.push(
      new Paragraph({
        children: [new TextRun({ text: c.name, bold: true, size: 24 })],
      }),
    );
    if (items.length) {
      items.forEach((s) =>
        sections.push(
          new Paragraph({
            bullet: { level: 0 },
            children: [new TextRun({ text: s })],
          }),
        ),
      );
    } else {
      sections.push(
        new Paragraph({
          children: [
            new TextRun({
              text: "Sin debilidades registradas",
              color: "999999",
            }),
          ],
        }),
      );
    }
    sections.push(new Paragraph({ text: "" }));
  });

  // ── Conclusión ────────────────────────────────────────────────────────────
  sections.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [
        new TextRun({ text: "6. Conclusión comparativa", bold: true }),
      ],
    }),
  );

  const blockWins = {};
  allBlockIds.forEach((bid) => {
    let best = null,
      bestS = -1;
    candidates.forEach((c) => {
      const s = c.blocks.find((b) => b.id === bid)?.average_score ?? null;
      if (s !== null && s > bestS) {
        best = c;
        bestS = s;
      }
    });
    if (best) blockWins[best.id] = (blockWins[best.id] || 0) + 1;
  });
  const mostWins = candidates.reduce(
    (b, c) => ((blockWins[c.id] || 0) > (blockWins[b?.id] || 0) ? c : b),
    candidates[0],
  );

  const conclusion = `La comparación técnica entre ${names} revela diferencias significativas en el nivel de detalle y solidez propositiva de sus planes de gobierno. ${leader.name} lidera con un puntaje general de ${fmt(leader.total_score)}/10 (${scoreLevelText(leader.total_score)}), demostrando mayor consistencia técnica. ${sorted[sorted.length - 1].name} presenta el puntaje más bajo (${fmt(sorted[sorted.length - 1].total_score)}/10), con vacíos estructurales más marcados. ${mostWins && mostWins.id !== leader.id ? `${mostWins.name} lidera en más bloques individuales (${blockWins[mostWins.id] || 0}), aunque su promedio global no sea el más alto. ` : ""}Ningún candidato alcanza el umbral de sólido (8/10) en el puntaje global, lo que indica que los planes evaluados presentan aún limitaciones en especificidad técnica e instrumentos de implementación.`;

  sections.push(
    new Paragraph({
      children: [new TextRun({ text: conclusion })],
    }),
  );

  // ── Build document ────────────────────────────────────────────────────────
  const doc = new Document({
    sections: [{ properties: {}, children: sections }],
  });

  const buffer = await Packer.toBuffer(doc);
  const filename = `comparacion_${candidates.map((c) => c.id).join("_vs_")}.docx`;

  res.set({
    "Content-Type":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": buffer.length,
  });
  res.send(buffer);
});

// ── Global error handler ──────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error("[server] Error no capturado:", err.message);
  res.status(500).json({ ok: false, error: err.message });
});

// ── Iniciar servidor ──────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en http://0.0.0.0:${PORT}`);
  console.log(`Leyendo candidatos desde: ${ANALISIS_DIR}`);
  console.log(
    `Conversor DOCX activo en: POST /api/convert + GET /api/job/:jobId`,
  );
  if (!process.env.OPENAI_API_KEY) {
    console.warn(
      "⚠ OPENAI_API_KEY no configurada. El conversor DOCX no funcionará.",
    );
  }
});
