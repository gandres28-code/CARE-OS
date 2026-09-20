# C.A.R.E 3.0 Security

## Required security variables

Add these values in Render before deploying this version:

- `ALLOWED_ORIGINS=https://your-service.onrender.com`
- `SESSION_DURATION_HOURS=12`
- `ADMIN_SESSION_DURATION_HOURS=4`
- `LOGIN_MAX_ATTEMPTS=5`
- `LOGIN_LOCK_MINUTES=15`
- `TRUST_PROXY=1`
- `ALLOW_LEGACY_NAME_LOGIN=false`
- `SENSITIVE_REAUTH_MINUTES=10`
- `CODE_PEPPER=<secreto aleatorio de 32 caracteres o más>`

`CODE_PEPPER` debe ser distinto de los códigos de empleados y no debe guardarse en Git ni en Notion. Genere un valor aleatorio, guárdelo como secreto de Render y consérvelo estable: cambiarlo invalida la búsqueda de los hashes existentes hasta repetir la migración desde Notion.

Authentication now uses an opaque `HttpOnly` session cookie backed by PostgreSQL. Administrative APIs enforce roles on the server, employee APIs no longer return access codes, and security decisions are recorded in `security_audit_log`.

Each C.A.R.E screen now stores its theme independently. Executive Operations Wall defaults to dark and all other screens default to light. The central `/app` page embeds the current Executive Operations Wall, which reads from the new dashboard data flow.

C.A.R.E 2.3 replaces the old module menu with unified Operations, Communications and Performance centers. Master List is removed from navigation and `/master` redirects to the Operations center.

## Deploy

1. Keep the existing Render environment variables, especially `DATABASENEW_URL`, Notion, Cloudinary and push-notification values.
2. Add `OPENAI_API_KEY` to enable the Care voice assistant.
3. Deploy with Node 20 or newer. Build command: `npm ci`. Start command: `npm start`.
4. La migración de base de datos se ejecuta desde `db/schema.sql` al iniciar y añade las columnas seguras sin borrar información operativa.
5. Después del primer despliegue, inicie sesión como Admin, confirme nuevamente su código y ejecute `POST /api/security/migrate-employee-codes`. Verifique `GET /api/security/employee-code-status`: `plaintext` debe ser `0`.

## Production readiness

- Configure Render Health Check Path as `/readyz`. It returns HTTP 200 only when PostgreSQL is connected and the production security configuration is valid.
- `/healthz` confirms that the Node process is alive, but it does not mean the service is ready to accept operational traffic.
- Production now fails closed when PostgreSQL, `CODE_PEPPER`, Notion Employees or `ALLOWED_ORIGINS` are missing or invalid. It will not expose a misleading fallback panel.
- GitHub Actions runs the complete suite with an isolated PostgreSQL 16 service on every push and pull request.
- Require the `Care OS Security CI / test` status check before merging into the production branch.

## Notion fields

The daily assignments data source should include these fields:

- `Room Number`
- `Date`
- `Assigned Cleaner`
- `Assigned Inspector`
- `Cleaning Status`
- `Arrival` (checkbox)
- `Stayover` (checkbox)
- `Guest Out` (checkbox)
- `Urgent` (checkbox)

If the Stayover checkbox is missing, add it before using Notion as the main assignment editor.

## Voice assistant

From the cleaner panel, open **Asistente** and say a complete command, for example:

- “Inicia la limpieza de 334 B.”
- “Terminé la 334 B.”
- “En 334 B necesito cuatro toallas grandes y dos sábanas king.”
- “La 334 B tiene una fuga y no puedo continuar.”

Care validates that the spoken room belongs to the signed-in cleaner before starting or finishing it. Ambiguous commands require confirmation. The browser must have microphone permission.

## Verification

Run `npm test` before every deploy. It checks server syntax, business engines, access rules and credential hashing. To execute the PostgreSQL integration test, provide an isolated `TEST_DATABASE_URL`; the test uses only a temporary table.
