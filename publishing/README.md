# Shared catalog publishing

Settings exposes this protected area only after Kayfa's publishing backend confirms the source account's current `catalogPublisher` role. Source publishers can manage shared flashcards and media; they cannot administer Watch or access learner records.

Choose an owned deck or shared preset explicitly, review the content-only projection, then Save draft → Preview → Publish. Personal notes, schedules, grades, captures and account fields never enter the shared draft. Existing decks/presets are not modified or automatically published. Drafts retain stable deck/card IDs, and publish uses version checks and idempotent operation IDs.

Set `VITE_CONTENT_PUBLISHING_URL` only after the Kayfa backend's separate publishing identity, exact CORS origins and source rules are reviewed and configured. Unconfigured access fails closed. This repository does not contain the live Firestore rules; no rule deployment or production grant is included.

The UI is a local implementation of Kayfa's publishing contract, not an iframe or a dynamically synchronized screen package. Keep the contract and intentional parity changes aligned with Kayfa's `docs/cf07-content-publishing.md`.

Verification: source-selection unit tests exclude private fields and reject malformed selections; actual two-project emulator checks verify role/project/revocation boundaries, immutable publication, media and conflict recovery. Both full apps completed publish/copy/update workflows with synthetic data, with mobile text-size and navigation checks. Detailed evidence is kept separately. Other experience editors and production activation remain outside this stage.
