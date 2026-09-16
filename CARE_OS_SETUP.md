# C.A.R.E 2.4

The C.A.R.E application remains in light mode. Executive Operations Wall is the only dark screen and uses four operational states: cleaning, completed, stayover and not started. The wall treats the existing Urgent/Priority field as Pager and shows a blinking red corner.

C.A.R.E 2.3 replaces the old module menu with unified Operations, Communications and Performance centers. Master List is removed from navigation and `/master` redirects to the Operations center.

## Deploy

1. Keep the existing Render environment variables, especially `DATABASENEW_URL`, Notion, Cloudinary and push-notification values.
2. Add `OPENAI_API_KEY` to enable the Care voice assistant.
3. Deploy with Node 20 or newer. Build command: `npm ci`. Start command: `npm start`.
4. The database migration runs from `db/schema.sql` during startup and adds the `stayover` field safely.

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

Run `npm test` before every deploy. It checks server syntax, the room engine and quality calculations.
