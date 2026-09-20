# Voice supply requests

This version adds bilingual voice requests to the cleaner room cards.

## Required configuration

- Keep `OPENAI_API_KEY` configured in Render.
- Keep `DATABASENEW_URL` connected so confirmed requests can be saved in `service_orders`.
- The app must be opened over HTTPS for mobile microphone permission.

## Cleaner flow

1. Tap the microphone on the assigned room.
2. Record the items and exact quantities in Spanish, English, or both.
3. Review or edit the transcription result.
4. Tap **Enviar solicitud**.

The confirmed request is created in the existing Service Orders system, sent in real time to the runner screen, and included in runner/admin push notifications.

## HotSOS

The internal order flow is ready. Direct HotSOS delivery remains disabled until Amadeus supplies the certified API endpoint, credentials, property identifier, and item/category codes. Do not place HotSOS credentials in frontend files.
