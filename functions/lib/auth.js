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

/**
 * App Check con rollout gradual.
 *
 * Modo por defecto = **monitor**: loggea presencia/ausencia del token por path
 * y por origen, pero NO bloquea. Permite descubrir clientes legítimos sin
 * token antes de hacer enforce hard.
 *
 * Modo enforce = `APP_CHECK_ENFORCE === "true"` o el path está en
 * `APP_CHECK_ENFORCE_PATHS`. Rechaza con 401 si `req.appCheck` no fue poblado
 * por `extractAuth` (token ausente o inválido).
 *
 * **Pre-requisito:** llamar a `extractAuth(req)` antes. El handler `exports.api`
 * ya lo hace al inicio.
 *
 * **Telemetry agregada:** counters in-memory por path para `/admin/diagnostics`.
 * Se resetean cuando la instancia se recicla — útil para ver el último período
 * sin acumular leaks.
 */
const _appCheckCounters = new Map(); // path → { withToken, withoutToken }

function _incrementCounter(path, hasToken) {
  let entry = _appCheckCounters.get(path);
  if (!entry) {
    entry = { withToken: 0, withoutToken: 0 };
    _appCheckCounters.set(path, entry);
  }
  if (hasToken) entry.withToken++;
  else entry.withoutToken++;
}

function _isEnforced(path) {
  if (process.env.APP_CHECK_ENFORCE === "true") return true;
  const list = (process.env.APP_CHECK_ENFORCE_PATHS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.some((prefix) => path.startsWith(prefix));
}

/**
 * Devuelve true si el request puede continuar.
 *
 * En modo monitor (default): loggea + retorna true siempre.
 * En modo enforce: si `!req.appCheck`, escribe 401 y retorna false.
 *
 * @param {object} req — express-like request
 * @param {object} res — express-like response (solo se usa si enforce activo)
 * @param {string} path — el path del request, para counters
 * @returns {boolean} si seguir procesando el request
 */
function requireAppCheck(req, res, path) {
  const hasToken = !!req.appCheck?.appId;
  _incrementCounter(path, hasToken);

  if (!hasToken) {
    // Sample log para no inundar — 1 de cada 100 sin token aprox.
    if (Math.random() < 0.01) {
      const ip = req.headers["x-forwarded-for"] || req.ip || "unknown";
      const ua = req.headers["user-agent"] || "unknown";
      logger.info(`appCheck.missing path=${path} ip=${ip} ua=${ua.substring(0, 60)}`);
    }
    if (_isEnforced(path)) {
      fail(res, "UNAUTHORIZED", "App Check token requerido");
      return false;
    }
  }
  return true;
}

/** Snapshot de counters para diagnostics. Se incluye en /admin/diagnostics. */
function getAppCheckStats() {
  const out = {};
  for (const [path, v] of _appCheckCounters) {
    const total = v.withToken + v.withoutToken;
    out[path] = {
      withToken: v.withToken,
      withoutToken: v.withoutToken,
      total,
      pctWithToken: total > 0 ? Math.round((v.withToken / total) * 100) : 0,
    };
  }
  return out;
}

module.exports = { extractAuth, requireAdminEmail, requireAppCheck, getAppCheckStats };
