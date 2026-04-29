/**
 * Tests del wrapper Mercado Pago Checkout API.
 * Cubre: detección modo MOCK vs REAL, currencyForCountry, verifyWebhookSignature,
 * createPayment en mock mode (sin tocar MP API real).
 */

const mp = require("../payments/mercadopago");

describe("mp.getClient", () => {
  test("token vacío → modo MOCK", () => {
    const client = mp.getClient("UY", { MP_ACCESS_TOKEN_UY: () => "" });
    expect(client.mock).toBe(true);
    expect(client.accessToken).toBeNull();
  });

  test("token placeholder no real → modo MOCK", () => {
    const client = mp.getClient("UY", {
      MP_ACCESS_TOKEN_UY: () => "PLACEHOLDER_REPLACE_WITH_REAL_TOKEN",
    });
    expect(client.mock).toBe(true);
  });

  test("token APP_USR-... → modo REAL", () => {
    const client = mp.getClient("UY", {
      MP_ACCESS_TOKEN_UY: () => "APP_USR-1234567890-abcdef-real-token",
    });
    expect(client.mock).toBe(false);
    expect(client.accessToken).toMatch(/^APP_USR-/);
  });

  test("token TEST-... → modo REAL (sandbox)", () => {
    const client = mp.getClient("AR", {
      MP_ACCESS_TOKEN_AR: () => "TEST-1234567890-test-token",
    });
    expect(client.mock).toBe(false);
    expect(client.country).toBe("AR");
  });

  test("país no soportado tira error", () => {
    expect(() => mp.getClient("XX", {})).toThrow(/no soportado/);
  });

  test("acepta lowercase", () => {
    const client = mp.getClient("uy", { MP_ACCESS_TOKEN_UY: () => "" });
    expect(client.country).toBe("UY");
  });
});

describe("mp.currencyForCountry", () => {
  test("UY → UYU, AR → ARS, BR → BRL", () => {
    expect(mp.currencyForCountry("UY")).toBe("UYU");
    expect(mp.currencyForCountry("AR")).toBe("ARS");
    expect(mp.currencyForCountry("BR")).toBe("BRL");
  });
  test("default → USD", () => {
    expect(mp.currencyForCountry("XX")).toBe("USD");
  });
});

describe("mp.createPayment (mock mode)", () => {
  test("devuelve approved con _mock=true cuando client.mock", async () => {
    const client = mp.getClient("UY", { MP_ACCESS_TOKEN_UY: () => "" });
    const payment = await mp.createPayment(client, {
      amount: 100,
      token: "mock_card_token",
      description: "test ride",
      paymentMethodId: "visa",
      payerEmail: "test@vamo.com.uy",
    });
    expect(payment.status).toBe("approved");
    expect(payment._mock).toBe(true);
    expect(payment.transaction_amount).toBe(100);
    expect(payment.currency_id).toBe("UYU");
  });

  test("preserva externalReference (ride id)", async () => {
    const client = mp.getClient("AR", { MP_ACCESS_TOKEN_AR: () => "" });
    const payment = await mp.createPayment(client, {
      amount: 500,
      token: "mock",
      description: "test",
      paymentMethodId: "visa",
      payerEmail: "test@v.com",
      externalReference: "ride_abc123",
    });
    expect(payment.external_reference).toBe("ride_abc123");
  });
});

describe("mp.verifyWebhookSignature", () => {
  test("sin secret en producción: rechaza (fail-closed)", () => {
    // Hardening 2026-04-28: en producción `!secret` retorna false para evitar
    // webhook spoofing si el secret se borra por error en Secret Manager.
    const prevEnv = process.env.NODE_ENV;
    const prevEmu = process.env.FUNCTIONS_EMULATOR;
    delete process.env.NODE_ENV;
    delete process.env.FUNCTIONS_EMULATOR;
    const ok = mp.verifyWebhookSignature({
      secret: null,
      xSignature: "garbage",
      xRequestId: "req-1",
      dataId: "123",
    });
    expect(ok).toBe(false);
    if (prevEnv !== undefined) process.env.NODE_ENV = prevEnv;
    if (prevEmu !== undefined) process.env.FUNCTIONS_EMULATOR = prevEmu;
  });

  test("sin secret en emulator: acepta (mock mode dev)", () => {
    const prev = process.env.FUNCTIONS_EMULATOR;
    process.env.FUNCTIONS_EMULATOR = "true";
    const ok = mp.verifyWebhookSignature({
      secret: null,
      xSignature: "garbage",
      xRequestId: "req-1",
      dataId: "123",
    });
    expect(ok).toBe(true);
    if (prev !== undefined) process.env.FUNCTIONS_EMULATOR = prev;
    else delete process.env.FUNCTIONS_EMULATOR;
  });

  test("rechaza firma vacía con secret", () => {
    const ok = mp.verifyWebhookSignature({
      secret: "real-secret",
      xSignature: "",
      xRequestId: "req-1",
      dataId: "123",
    });
    expect(ok).toBe(false);
  });

  test("rechaza si dataId vacío", () => {
    const ok = mp.verifyWebhookSignature({
      secret: "real-secret",
      xSignature: "ts=1234,v1=abc",
      xRequestId: "req-1",
      dataId: "",
    });
    expect(ok).toBe(false);
  });

  test("acepta firma válida con secret correcto", () => {
    const crypto = require("crypto");
    const secret = "test-secret";
    const dataId = "12345";
    const requestId = "req-789";
    const ts = "1700000000";
    const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
    const v1 = crypto.createHmac("sha256", secret).update(manifest).digest("hex");
    const xSignature = `ts=${ts},v1=${v1}`;
    const ok = mp.verifyWebhookSignature({
      secret, xSignature, xRequestId: requestId, dataId,
    });
    expect(ok).toBe(true);
  });
});

describe("mp.SUPPORTED_COUNTRIES", () => {
  test("incluye UY/AR/BR", () => {
    expect(mp.SUPPORTED_COUNTRIES).toEqual(
      expect.arrayContaining(["UY", "AR", "BR"])
    );
  });
});
