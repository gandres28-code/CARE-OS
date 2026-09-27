# Care OS 3.0.0 Security Preview 5

This release begins the production-security migration without replacing operational data.

## Included

- PostgreSQL-backed opaque sessions.
- HttpOnly, SameSite and production Secure cookies.
- Server-side role enforcement for payroll, employees, sync, analytics and administration.
- Authenticated Socket.IO connections.
- Restricted CORS through `ALLOWED_ORIGINS`.
- Login throttling and temporary lockouts.
- Security audit log for successful logins and denied access.
- Employee APIs no longer expose access codes.
- `/api/me` and `/api/bootstrap` resolve identity from the server session.
- Legacy login by employee name is disabled unless explicitly enabled.
- Cleaning and inspection actions derive the employee from the authenticated session.
- Room actions reject employees who are not assigned to the room.
- Cleaner actions reject Stayover rooms.
- Time Clock derives the employee code on the server; the browser no longer sends it.
- Cleaner and inspector assignment fallbacks derive identity from the session.
- Socket connections join restricted employee and role rooms.
- Payroll, employee and administrative live events are no longer broadcast to every role.
- Mutation requests reject origins outside `ALLOWED_ORIGINS`.
- Payroll approval, reopening, resets, deletions and employee changes require recent code confirmation.
- Employee Center now creates, edits, activates and deactivates real PostgreSQL employees without displaying saved codes.
- Runner Orders are filtered by assignment; accepting a generic order claims it for that runner.
- Runner identities come from the authenticated session and order status must advance sequentially.
- Push registration and employee notifications use the authenticated employee instead of a client-provided name.
- Intelligence, quality, room catalog and administrative events use restricted realtime rooms.
- Employee access codes are stored with salted scrypt hashes and a peppered HMAC lookup; PostgreSQL no longer needs readable employee codes.
- PostgreSQL-first login and recent reauthentication verify hashes with constant-time comparison.
- Valid Notion credentials are migrated on first use, and full Notion employee sync writes only protected credentials.
- Admin-only, recently reauthenticated migration and status endpoints support a controlled rollout and audit trail.
- Credential unit tests and an optional isolated PostgreSQL integration test cover the new authentication storage contract.
- GitHub Actions now provisions PostgreSQL 16 and executes the real schema-and-authentication integration test automatically.
- Production startup validates database, Notion, allowed-origin and credential-pepper configuration before accepting traffic.
- Production fails closed instead of opening an insecure fallback panel after bootstrap failure.
- `/healthz` and `/readyz` separate process health from true operational readiness for Render deployments.

## Deployment gate

Do not deploy until PostgreSQL is configured and the environment values in `CARE_OS_SETUP.md` are present. Test Admin, Manager, Operations, Cleaner, Inspector and Runner accounts in a Render preview service before replacing production.

## Remaining production gate

- Run the code migration in a Render preview and confirm `plaintext: 0` before production cutover.
- Confirm the first successful `Care OS Security CI` run in GitHub before deploying.
- Upgrade Firebase/Excel transitive dependencies after dedicated notification and workbook regression testing.
