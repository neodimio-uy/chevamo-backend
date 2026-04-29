/**
 * Mercado Pago Checkout API wrapper — multi-país (UY/AR/BR).
 *
 * Doc oficial: https://www.mercadopago.com.uy/developers/es/docs/checkout-api/landing
 *
 * Esta es la API de **máxima personalización** (5/5 según el comparador MP).
 * El user nunca sale de Vamo: tarjeta tokenizada en cliente, charge directo
 * server-side. PCI-DSS compliant porque la tarjeta NO toca nuestro server.
 *
 * Multi-país:
 *   - `MP_ACCESS_TOKEN_UY` (production tokens viven en Secret Manager)
 *   - `MP_ACCESS_TOKEN_AR`
 *   - `MP_ACCESS_TOKEN_BR`
 * Si el token de un país no está seteado, el wrapper opera en MODO MOCK:
 *   devuelve `{status:"approved", id:"mock_..."}` para que UI funcione en
 *   preview visual. Útil pre-launch antes de generar credenciales reales.
 *
 * Etapa 1 (2026-04-27): wrapper + endpoints stub. Webhook firma + retry
 * lifecycle se completan en Etapa 2 cuando haya cuenta MP real.
 */

const axios = require("axios");

const MP_API = "https://api.mercadopago.com";

// País → secret name. Set en Secret Manager o en `defineSecret` del index.js.
const ACCESS_TOKEN_BY_COUNTRY = {
  UY: "MP_ACCESS_TOKEN_UY",
  AR: "MP_ACCESS_TOKEN_AR",
  BR: "MP_ACCESS_TOKEN_BR",
};

// Países soportados por MP (cobertura nativa).
const SUPPORTED_COUNTRIES = ["UY", "AR", "BR"];

/**
 * @typedef {Object} CountryClient
 * @property {string} country - "UY"/"AR"/"BR"
 * @property {string|null} accessToken - null si modo MOCK
 * @property {boolean} mock - true si no hay token configurado
 */

/**
 * Devuelve un client configurado para el país. Si no hay token, modo mock.
 * @param {string} country - ISO2
 * @param {Object} secrets - { MP_ACCESS_TOKEN_UY: () => "...", ... }
 * @returns {CountryClient}
 */
function getClient(country, secrets) {
  const ucCountry = (country || "").toUpperCase();
  if (!SUPPORTED_COUNTRIES.includes(ucCountry)) {
    throw new Error(`País no soportado por Mercado Pago: ${country}`);
  }
  const tokenName = ACCESS_TOKEN_BY_COUNTRY[ucCountry];
  let token = null;
  try {
    const secret = secrets?.[tokenName];
    token = typeof secret === "function" ? secret() : secret;
  } catch {
    token = null;
  }
  // Tokens reales de MP empiezan con `APP_USR-` (production) o `TEST-`
  // (sandbox). Cualquier otro valor (placeholder, vacío) → modo MOCK.
  const isReal = typeof token === "string" &&
                 (token.startsWith("APP_USR-") || token.startsWith("TEST-"));
  return {
    country: ucCountry,
    accessToken: isReal ? token : null,
    mock: !isReal,
  };
}

/**
 * Crear pago directo con `card_token` (transparent flow).
 *
 * @param {CountryClient} client
 * @param {Object} input
 * @param {number} input.amount - en unidades enteras (ej $450 UYU = 450)
 * @param {string} input.token - card_token tokenizado en cliente
 * @param {string} input.description
 * @param {string} input.payerEmail
 * @param {string} input.paymentMethodId - "visa"/"master"/etc (resuelto en cliente)
 * @param {number} [input.installments=1]
 * @param {string} [input.externalReference] - rideRequestId
 * @returns {Promise<Object>} payment con { id, status, status_detail, ... }
 */
async function createPayment(client, input) {
  if (client.mock) {
    return {
      id: `mock_pay_${Date.now()}`,
      status: "approved",
      status_detail: "accredited",
      transaction_amount: input.amount,
      currency_id: currencyForCountry(client.country),
      description: input.description,
      external_reference: input.externalReference || null,
      _mock: true,
    };
  }

  const url = `${MP_API}/v1/payments`;
  const body = {
    transaction_amount:    input.amount,
    token:                 input.token,
    description:           input.description,
    installments:          input.installments || 1,
    payment_method_id:     input.paymentMethodId,
    payer:                 { email: input.payerEmail },
    external_reference:    input.externalReference || undefined,
    statement_descriptor:  "VAMO",
  };

  const r = await axios.post(url, body, {
    headers: {
      "Authorization":  `Bearer ${client.accessToken}`,
      "Content-Type":   "application/json",
      "X-Idempotency-Key": input.idempotencyKey || `vamo-${input.externalReference || Date.now()}`,
    },
    timeout: 15_000,
  });
  return r.data;
}

/**
 * Crear customer en MP (lo usamos para asociar tarjetas guardadas al user).
 * Doc: https://www.mercadopago.com.uy/developers/es/reference/customers/_customers/post
 *
 * @returns {Promise<Object>} customer con { id, email, ... }
 */
async function createCustomer(client, { email, firstName, lastName }) {
  if (client.mock) {
    return { id: `mock_cust_${Date.now()}`, email, _mock: true };
  }
  const url = `${MP_API}/v1/customers`;
  const r = await axios.post(url, {
    email,
    first_name: firstName || undefined,
    last_name:  lastName || undefined,
  }, {
    headers: { "Authorization": `Bearer ${client.accessToken}` },
    timeout: 10_000,
  });
  return r.data;
}

/**
 * Asociar tarjeta tokenizada a un customer (queda guardada para próximos pagos).
 * @returns {Promise<Object>} card con { id, last_four_digits, payment_method, ... }
 */
async function saveCardToCustomer(client, { customerId, cardToken }) {
  if (client.mock) {
    return {
      id: `mock_card_${Date.now()}`,
      last_four_digits: "0006",
      payment_method: { id: "visa", name: "Visa" },
      _mock: true,
    };
  }
  const url = `${MP_API}/v1/customers/${customerId}/cards`;
  const r = await axios.post(url, { token: cardToken }, {
    headers: { "Authorization": `Bearer ${client.accessToken}` },
    timeout: 10_000,
  });
  return r.data;
}

/**
 * Listar tarjetas guardadas de un customer.
 */
async function listCustomerCards(client, customerId) {
  if (client.mock) return [];
  const url = `${MP_API}/v1/customers/${customerId}/cards`;
  const r = await axios.get(url, {
    headers: { "Authorization": `Bearer ${client.accessToken}` },
    timeout: 10_000,
  });
  return Array.isArray(r.data) ? r.data : [];
}

/**
 * Eliminar tarjeta guardada.
 */
async function deleteCustomerCard(client, { customerId, cardId }) {
  if (client.mock) return { id: cardId, _mock: true, deleted: true };
  const url = `${MP_API}/v1/customers/${customerId}/cards/${cardId}`;
  const r = await axios.delete(url, {
    headers: { "Authorization": `Bearer ${client.accessToken}` },
    timeout: 10_000,
  });
  return r.data;
}

/**
 * Charge a un customer existente con una tarjeta guardada (sin re-tokenizar).
 * Requiere `cardId` + flow de regenerar token desde la tarjeta guardada.
 *
 * Ver doc: el flow completo es:
 *   1. cliente toma `cardId` + `securityCode` (CVV — siempre en cliente)
 *   2. cliente genera `card_token` con POST /v1/card_tokens enviando cardId+CVV
 *   3. server hace `createPayment` con ese token
 *
 * Esta función es helper que asume el step 2 ya pasó (cliente nos dio el token).
 */
async function chargeWithSavedCard(client, input) {
  // Identical to createPayment — la diferencia es que el token vino de un cardId
  // existente. MP lo trata igual.
  return createPayment(client, input);
}

/**
 * Verificar firma de webhook (HMAC SHA256) — Etapa 2 cuando MP esté configurado.
 * Doc: https://www.mercadopago.com.uy/developers/es/docs/your-integrations/notifications/webhooks
 *
 * @param {string} secret - el `WEBHOOK_SECRET` de la app MP
 * @param {string} xSignature - header `x-signature`
 * @param {string} xRequestId - header `x-request-id`
 * @param {string} dataId - id del recurso del payload
 * @returns {boolean}
 */
function verifyWebhookSignature({ secret, xSignature, xRequestId, dataId }) {
  if (!secret) {
    // Sin secret configurado: aceptar solo en entorno explícitamente de
    // desarrollo (FUNCTIONS_EMULATOR=true o NODE_ENV=development). En cualquier
    // otra condición — incluido producción donde por error se borre el secret —
    // **rechazar** para evitar webhook spoofing de MP.
    const isDev = process.env.FUNCTIONS_EMULATOR === "true"
               || process.env.NODE_ENV === "development";
    if (isDev) return true;
    return false;
  }
  const crypto = require("crypto");
  // Formato: "ts=NNN,v1=hexhash"
  const parts = (xSignature || "").split(",");
  const tsPart = parts.find((p) => p.startsWith("ts=")) || "";
  const v1Part = parts.find((p) => p.startsWith("v1=")) || "";
  const ts = tsPart.replace("ts=", "");
  const v1 = v1Part.replace("v1=", "");
  if (!ts || !v1 || !dataId) return false;
  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
  const computed = crypto.createHmac("sha256", secret).update(manifest).digest("hex");
  return computed === v1;
}

function currencyForCountry(country) {
  switch (country.toUpperCase()) {
    case "UY": return "UYU";
    case "AR": return "ARS";
    case "BR": return "BRL";
    default:   return "USD";
  }
}

module.exports = {
  getClient,
  createPayment,
  createCustomer,
  saveCardToCustomer,
  listCustomerCards,
  deleteCustomerCard,
  chargeWithSavedCard,
  verifyWebhookSignature,
  currencyForCountry,
  SUPPORTED_COUNTRIES,
  ACCESS_TOKEN_BY_COUNTRY,
};
