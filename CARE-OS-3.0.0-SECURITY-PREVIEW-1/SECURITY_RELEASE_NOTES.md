# Care OS 3.0.0 Security Preview 1

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

## Deployment gate

Do not deploy until PostgreSQL is configured and the environment values in `CARE_OS_SETUP.md` are present. Test Admin, Manager, Operations, Cleaner, Inspector and Runner accounts in a Render preview service before replacing production.

## Next security increment

- Remove the remaining compatibility dependency on employee codes in browser storage.
- Bind room actions and time clock actions to the authenticated employee.
- Move Socket.IO broadcasts into role/property rooms.
- Add CSRF protection for sensitive mutations.
- Add full integration tests against a temporary PostgreSQL database.
