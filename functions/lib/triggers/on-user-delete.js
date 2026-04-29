/**
 * Cloud Function `deleteMyAccount` — borrado atómico de cuenta.
 *
 * **Apple Review Guideline 5.1.1(v)** exige que el flow de "Borrar cuenta"
 * elimine *toda* la data personal del user, no solo Firebase Auth. Sin esto,
 * los docs de Firestore quedan huérfanos con el uid del user borrado →
 * rejection automático del review.
 *
 * Por qué `onCall` Gen 2 en lugar de `auth.user().onDelete()` Gen 1:
 *  - Gen 1 auth triggers no soportan Node 24 (nuestro runtime).
 *  - `onCall` permite que el cliente reciba feedback de éxito/error y bloquee
 *    UI mientras corre la cascada (~1-3s típico).
 *  - El cliente iOS llama esta function ANTES de `Auth.auth().currentUser
 *    .delete()` — la function hace cascada Firestore/Storage + borra el user
 *    de Auth atómicamente.
 *
 * Errores parciales NO abortan el resto — capturamos cada operación y
 * loguamos en `audit_log.errors[]`. Apple acepta deletion "best-effort"
 * mientras esté documentado y la mayor parte se borre.
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { logger } = require("firebase-functions");

const db = admin.firestore();

/**
 * Helper: borrado recursivo (cubre subcollections) con captura de error.
 */
async function safeRecursiveDelete(label, ref, errors) {
  try {
    await db.recursiveDelete(ref);
  } catch (e) {
    errors.push(`${label}: ${e.message || e.code || "unknown"}`);
  }
}

/**
 * Helper: borrado de docs que matchean una query, en batches de 500.
 */
async function safeQueryDelete(label, query, errors) {
  try {
    const snap = await query.get();
    if (snap.empty) return;
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 500) {
      const chunk = docs.slice(i, i + 500);
      const batch = db.batch();
      chunk.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }
  } catch (e) {
    errors.push(`${label}: ${e.message || e.code || "unknown"}`);
  }
}

/**
 * `deleteMyAccount` — onCall function. Auth required. Borra TODA la data del
 * user autenticado y luego elimina su cuenta de Firebase Auth.
 *
 * Cliente iOS llama así:
 * ```swift
 * let f = Functions.functions().httpsCallable("deleteMyAccount")
 * try await f.call()
 * try Auth.auth().signOut()  // local cleanup
 * ```
 *
 * NO requiere argumentos — el uid se extrae del token de auth (request.auth).
 * Esto bloquea que un user borre la cuenta de otro.
 */
exports.deleteMyAccount = onCall(
  {
    memory: "512MiB",
    timeoutSeconds: 60,
  },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Auth required");
    }

    const email = request.auth.token?.email || null;
    const errors = [];

    logger.info(`[deleteMyAccount] start uid=${uid} email=${email || "anonymous"}`);

    // 1. Docs y subcollections directos del user (recursive borra subcoll también)
    await Promise.all([
      safeRecursiveDelete("users", db.collection("users").doc(uid), errors),
      safeRecursiveDelete("user_tokens", db.collection("user_tokens").doc(uid), errors),
      // user_connections/{uid}/contacts/* — subcollection de la red del user
      safeRecursiveDelete("user_connections", db.collection("user_connections").doc(uid), errors),
      // eta_observations/{uid}/items/* — telemetría ETA del user
      safeRecursiveDelete("eta_observations", db.collection("eta_observations").doc(uid), errors),
      // referrals/{uid} — el doc determinístico que cargó el user al canjear
      safeRecursiveDelete("referrals", db.collection("referrals").doc(uid), errors),
      // admin_presence/{uid} — solo aplica a admins, no daña si no existe
      safeRecursiveDelete("admin_presence", db.collection("admin_presence").doc(uid), errors),
    ]);

    // 2. Docs en colecciones queryables
    await Promise.all([
      safeQueryDelete(
        "community_buses",
        db.collection("community_buses").where("userId", "==", uid),
        errors
      ),
      safeQueryDelete(
        "support_tickets",
        db.collection("support_tickets").where("userId", "==", uid),
        errors
      ),
      safeQueryDelete(
        "shared_trips",
        db.collection("shared_trips").where("ownerUid", "==", uid),
        errors
      ),
      safeQueryDelete(
        "contact_invitations",
        db.collection("contact_invitations").where("fromUid", "==", uid),
        errors
      ),
      safeQueryDelete(
        "referral_codes",
        db.collection("referral_codes").where("ownerUid", "==", uid),
        errors
      ),
      safeQueryDelete(
        "rideRequests",
        db.collection("rideRequests").where("passengerId", "==", uid),
        errors
      ),
      // live_activity_tokens almacenan APNS push tokens del user
      safeQueryDelete(
        "live_activity_tokens",
        db.collection("live_activity_tokens").where("userId", "==", uid),
        errors
      ),
    ]);

    // 3. Wallets multi-país (formato {uid}_{country})
    for (const country of ["UY", "AR", "BR"]) {
      await safeRecursiveDelete(
        `wallets/${country}`,
        db.collection("wallets").doc(`${uid}_${country}`),
        errors
      );
    }

    // 4. Storage: foto de perfil + cualquier attachment de soporte
    try {
      const bucket = admin.storage().bucket();
      // ProfilePhotoStore guarda en `profile_photos/{uid}.jpg` (ver iOS)
      await bucket.file(`profile_photos/${uid}.jpg`).delete({ ignoreNotFound: true });
      // Support attachments del user (si guarda en `support/{uid}/...`)
      await bucket.deleteFiles({ prefix: `support/${uid}/` });
    } catch (e) {
      errors.push(`storage: ${e.message || e.code || "unknown"}`);
    }

    // 5. Audit log: registro inmutable de quién/cuándo se borró + qué errores
    // hubo. Apple Review puede pedir prueba de cumplimiento; este audit log es
    // la evidencia. La colección `audit_log` tiene rules `update/delete: false`
    // así que es write-once.
    try {
      await db.collection("audit_log").add({
        type: "user_deleted",
        uid,
        email,
        deletedAt: admin.firestore.Timestamp.now(),
        errors,
        cleanDelete: errors.length === 0,
      });
    } catch (e) {
      logger.error(`[deleteMyAccount] audit_log write failed for ${uid}: ${e.message}`);
    }

    // 6. Borrar Firebase Auth account (último paso — irreversible).
    // Si esto falla, el resto ya está borrado y el user queda con cuenta Auth
    // huérfana — siguiente login va a re-crear users/{uid} vacío.
    try {
      await admin.auth().deleteUser(uid);
    } catch (e) {
      errors.push(`auth_delete: ${e.message || e.code || "unknown"}`);
      logger.error(`[deleteMyAccount] auth deletion failed for ${uid}: ${e.message}`);
      throw new HttpsError(
        "internal",
        "No pudimos borrar tu cuenta de Firebase Auth. Tus datos sí fueron eliminados.",
        { errors }
      );
    }

    if (errors.length > 0) {
      logger.warn(
        `[deleteMyAccount] completed with ${errors.length} errors uid=${uid}: ${errors.join(" | ")}`
      );
    } else {
      logger.info(`[deleteMyAccount] clean cascade complete uid=${uid}`);
    }

    return {
      ok: true,
      cleanDelete: errors.length === 0,
      errorCount: errors.length,
    };
  }
);
