/**
 * Auth helpers — Firebase Auth ID token + App Check.
 *
 * Modo "shadow auth": extractAuth() verifica los tokens si vienen pero NO
 * rechaza requests si faltan o son inválidos — solo loguea. Adjunta
 * `req.auth` y `req.appCheck` cuando son válidos.
 *
 * Esto permite deployar enforcement gradualmente. Una vez que el cliente
 * mande siempre los headers, los endpoints sensibles pueden migrar a
 * fail-closed.
 *
 * Para endpoints admin se usa requireAdminEmail() que SÍ es fail-closed.
 */

const admin = require("firebase-admin");
const { logger } = require("firebase-functions");
const { fail } = require("./response");

async function extractAuth(req) {
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    const idToken = authHeader.substring(7);
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      req.auth = {
        uid: decoded.uid,
        email: decoded.email,
        emailVerified: decoded.email_verified === true,
      };
    } catch (e) {
      logger.warn(`auth.idToken invalid: ${e.code || e.message}`);
    }
  }

  const appCheckToken = req.headers["x-firebase-appcheck"];
  if (appCheckToken) {
    try {
      const decoded = await admin.appCheck().verifyToken(appCheckToken);
      req.appCheck = { appId: decoded.appId };
    } catch (e) {
      logger.warn(`auth.appCheck invalid: ${e.code || e.message}`);
    }
  }
}

/**
 * Fail-closed para endpoints admin.
 * Verifica idToken con email *@neodimio.com.uy y email_verified=true.
 *
 * Retorna true si autorizó. Si no, escribe la respuesta de error y retorna false.
 */
async function requireAdminEmail(req, res) {
  await extractAuth(req);
  const auth = req.auth;
  if (!auth?.uid) {
    fail(res, "UNAUTHORIZED", "Falta idToken");
    return false;
  }
  if (!auth.emailVerified) {
    fail(res, "FORBIDDEN", "Email no verificado");
    return false;
  }
  if (!auth.email?.endsWith("@neodimio.com.uy")) {
    fail(res, "FORBIDDEN", "Solo personal Neodimio");
    return false;
  }
  return true;
}

module.exports = { extractAuth, requireAdminEmail };
