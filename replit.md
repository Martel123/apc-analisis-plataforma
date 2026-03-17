# Evaluación Técnica de Planes de Gobierno · Perú 2026

## Descripción
Plataforma web interactiva para explorar y comparar análisis técnicos de planes de gobierno presidenciales del Perú. El sistema es completamente data-driven: la fuente única de verdad es la carpeta `/analisis`, que contiene un archivo JSON por candidato.

## Arquitectura

```
/
├── server.js             → Servidor Express (puerto 5000)
├── package.json
├── index.html            → Home / Ranking
├── analizar.html         → Vista de análisis por candidato
├── comparar.html         → Vista de comparación multi-candidato
├── heatmap.html          → Heatmap global de variables × candidatos
├── validacion.html       → Validador de estructura JSON
│
├── /analisis/            ← FUENTE ÚNICA DE VERDAD
│   └── demo-candidato.json  → Plantilla con schema completo documentado
│
└── /public/
    ├── /js/
    │   ├── data.js       → Data layer: getCandidates(), getRanking(), getHeatmapMatrix(), etc.
    │   ├── engine.js     → Procesamiento: KPIs, radar, comparaciones, brechas
    │   ├── charts.js     → Gráficos: radar, barras, heatmap
    │   └── ui.js         → Helpers de UI: scoreBadge(), criteriaBars(), tagList(), etc.
    └── /styles/
        ├── globals.css   → Sistema de diseño completo
        └── home.css      → Estilos específicos del home
```

## API del servidor

- `GET /api/candidates` → Lee todos los `.json` de `/analisis` y los retorna
- `GET /api/validate`   → Valida estructura de cada archivo y reporta errores/advertencias

## Schema JSON (por candidato)

Cada archivo en `/analisis/*.json` debe seguir el schema de `demo-candidato.json`:

```json
{
  "candidate": {
    "id": "...",            // OBLIGATORIO
    "name": "...",          // OBLIGATORIO
    "party": "...",         // OBLIGATORIO
    "total_score": 7.1,     // OBLIGATORIO
    "color": "#b5121b",
    "plan_period": "2026-2031",
    "plan_pages": 98,
    "summary": "...",
    "strengths": ["..."],
    "weaknesses": ["..."],
    "methodological_notes": ["..."]
  },
  "blocks": [{
    "id": "economia",       // OBLIGATORIO
    "name": "Economía",     // OBLIGATORIO
    "average_score": 7.4,
    "summary": "...",
    "strengths": ["..."],
    "weaknesses": ["..."],
    "variables": [{
      "id": "politica_tributaria",  // OBLIGATORIO
      "name": "Política tributaria", // OBLIGATORIO
      "final_score": 8.3,
      "corrected_methodology": false,
      "correction_note": "...",
      "criteria": {
        "diagnostico": 2,   // 0-2
        "propuesta": 2,
        "medidas": 1,
        "implementacion": 1,
        "viabilidad": 1,
        "especificidad": 2
      },
      "strengths": ["..."],
      "weaknesses": ["..."],
      "gaps": ["..."],
      "conclusion": "...",
      "analysis_sections": {
        "definicion": "...",
        "importancia": "...",
        "diagnostico_externo": "...",
        "propuesta_plan": "...",
        "medidas_concretas": "...",
        "implementacion_necesaria": "...",
        "impacto_potencial": "...",
        "vacios": "...",
        "evaluacion_tecnica": "...",
        "calificacion_final": "...",
        "conclusion": "..."
      }
    }]
  }],
  "final_analysis": {
    "global_findings": ["..."],
    "final_conclusion": "...",
    "ranking_note": "...",
    "comparability_note": "..."
  }
}
```

## Escala de puntajes
- 8.5–10.0 → Excelente (verde)
- 7.0–8.4  → Sólido (azul)
- 5.5–6.9  → Intermedio (ámbar)
- 4.0–5.4  → Débil (naranja)
- 0.0–3.9  → Muy débil (rojo)

## Metodología
- 30 variables por candidato
- 8 bloques temáticos
- 6 criterios por variable (Diagnóstico, Propuesta, Medidas, Implementación, Viabilidad, Especificidad)
- Cada criterio: 0, 1 o 2 puntos
- Puntaje final por variable: (suma_criterios / 12) * 10

## Flujo de trabajo
Para agregar un nuevo candidato:
1. Copiar `analisis/demo-candidato.json`
2. Renombrar con el ID del candidato (ej: `acuna.json`)
3. Completar los campos
4. Guardar → la plataforma lo detecta automáticamente

Para validar la estructura:
- Visitar `/validacion.html` → Ejecutar validación

## Tech Stack
- Backend: Node.js + Express
- Frontend: HTML + CSS + Vanilla JS
- Charts: Chart.js (CDN)
- Fonts: Inter + Sora (Google Fonts)
- Puerto: 5000
