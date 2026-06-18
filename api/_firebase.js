// api/_firebase.js — lazy Firebase Admin init for the generation gateway.
//
// Set the env var FIREBASE_SERVICE_ACCOUNT (the full JSON of a Firebase
// service-account key) in Vercel to enable the gateway's server-side features:
//   • verifying the caller's Firebase ID token (auth)
//   • the generation cache  (Firestore collection `generations`)
//   • usage logging         (Firestore collection `usage_events`)
//
// Without it the gateway STILL generates — it just skips auth/cache/logging,
// so local dev and first deploys keep working. Activate the full pipeline by
// adding the env var. Admin is imported dynamically so the dependency only
// loads when configured.

let _admin = null;
let _tried = false;

export async function getAdmin() {
  if (_tried) return _admin;
  _tried = true;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return _admin; // not configured → graceful no-op mode
  try {
    const admin = (await import("firebase-admin")).default;
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    }
    _admin = admin;
  } catch (e) {
    console.error("[gateway] Firebase Admin init failed:", e?.message || e);
    _admin = null;
  }
  return _admin;
}
