# Operations Intelligence Core v1

## Incluido

- `room_metrics`: historial diario por habitación.
- `employee_metrics`: resumen diario de desempeño por cleaner.
- Quality Engine modular en `services/intelligence/qualityEngine.js`.
- Cálculo de calidad, eficiencia, overall score, first-pass rate y severidades.
- Tiempo esperado usando mediana histórica de 60 días y fallback por room type.
- Actualización automática después de guardar una inspección de calidad.
- Endpoints:
  - `POST /api/intelligence/quality/refresh`
  - `GET /api/intelligence/quality/cleaners?from=YYYY-MM-DD&to=YYYY-MM-DD`
  - `GET /api/intelligence/quality/rooms?date=YYYY-MM-DD`

## Despliegue

Sube el proyecto completo a GitHub y despliega en Render. Al iniciar, `db/schema.sql` crea las tablas nuevas automáticamente mediante `initializeDatabase()`.

No elimines `DATABASENEW_URL`. Notion continúa como fuente operativa; PostgreSQL guarda la inteligencia y el historial.
