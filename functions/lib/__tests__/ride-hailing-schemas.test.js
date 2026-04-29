/**
 * Tests Zod de schemas ride-hailing. Cubre validación de inputs de endpoints
 * + schemas internos (RideRequest, Driver, Trip, FareEstimate).
 */

const s = require("../ride-hailing/schemas");

describe("CreateRideInputSchema", () => {
  const validInput = {
    origin: {
      coord: { lat: -34.9, lng: -56.18 },
      address: "Plaza Independencia",
      jurisdictionId: "uy.mvd",
    },
    destination: {
      coord: { lat: -34.92, lng: -56.16 },
      address: "Pocitos",
      jurisdictionId: "uy.mvd",
    },
    serviceKind: "taxi",
    paymentMethod: "cash",
  };

  test("input válido pasa", () => {
    expect(s.CreateRideInputSchema.safeParse(validInput).success).toBe(true);
  });

  test("default paymentMethod = cash", () => {
    const { origin, destination, serviceKind } = validInput;
    const r = s.CreateRideInputSchema.safeParse({
      origin, destination, serviceKind,
    });
    expect(r.success).toBe(true);
    expect(r.data.paymentMethod).toBe("cash");
  });

  test("rechaza coord lat fuera de rango", () => {
    const bad = { ...validInput, origin: { ...validInput.origin, coord: { lat: 91, lng: 0 } } };
    expect(s.CreateRideInputSchema.safeParse(bad).success).toBe(false);
  });

  test("rechaza serviceKind desconocido", () => {
    const bad = { ...validInput, serviceKind: "helicopter" };
    expect(s.CreateRideInputSchema.safeParse(bad).success).toBe(false);
  });

  test("acepta paymentCardId opcional", () => {
    const ok = { ...validInput, paymentMethod: "mercadopago", paymentCardId: "card_abc123" };
    const r = s.CreateRideInputSchema.safeParse(ok);
    expect(r.success).toBe(true);
    expect(r.data.paymentCardId).toBe("card_abc123");
  });
});

describe("ServiceKindSchema", () => {
  test("acepta taxi/remis/moto", () => {
    expect(s.ServiceKindSchema.safeParse("taxi").success).toBe(true);
    expect(s.ServiceKindSchema.safeParse("remis").success).toBe(true);
    expect(s.ServiceKindSchema.safeParse("moto").success).toBe(true);
  });
  test("rechaza otros", () => {
    expect(s.ServiceKindSchema.safeParse("uber").success).toBe(false);
  });
});

describe("PaymentMethodSchema", () => {
  test("acepta cash/mercadopago/stm-card", () => {
    expect(s.PaymentMethodSchema.safeParse("cash").success).toBe(true);
    expect(s.PaymentMethodSchema.safeParse("mercadopago").success).toBe(true);
    expect(s.PaymentMethodSchema.safeParse("stm-card").success).toBe(true);
  });
  test("rechaza abitab/red-pagos (descartados por decisión 2026-04-27)", () => {
    expect(s.PaymentMethodSchema.safeParse("abitab").success).toBe(false);
    expect(s.PaymentMethodSchema.safeParse("red-pagos").success).toBe(false);
  });
});

describe("FareEstimateSchema", () => {
  test("min/max nonnegative en cents", () => {
    expect(s.FareEstimateSchema.safeParse({ min: 5000, max: 7000, currency: "UYU" }).success).toBe(true);
    expect(s.FareEstimateSchema.safeParse({ min: -1, max: 100, currency: "UYU" }).success).toBe(false);
  });
  test("currency ISO 4217 (3 chars)", () => {
    expect(s.FareEstimateSchema.safeParse({ min: 100, max: 200, currency: "UY" }).success).toBe(false);
    expect(s.FareEstimateSchema.safeParse({ min: 100, max: 200, currency: "UYUY" }).success).toBe(false);
  });
});

describe("RideRequestStatusSchema", () => {
  test("acepta status terminales y activos", () => {
    const valid = ["searching", "matched", "driver_accepted", "completed",
                   "cancelled_by_passenger", "no_drivers_available"];
    for (const v of valid) {
      expect(s.RideRequestStatusSchema.safeParse(v).success).toBe(true);
    }
  });
  test("rechaza status desconocido", () => {
    expect(s.RideRequestStatusSchema.safeParse("magic").success).toBe(false);
  });
});

describe("CancelRideInputSchema", () => {
  test("reason opcional", () => {
    expect(s.CancelRideInputSchema.safeParse({}).success).toBe(true);
    expect(s.CancelRideInputSchema.safeParse({ reason: "cambié de opinión" }).success).toBe(true);
  });
  test("reason max 500 chars", () => {
    const longReason = "x".repeat(501);
    expect(s.CancelRideInputSchema.safeParse({ reason: longReason }).success).toBe(false);
  });
});

describe("RateRideInputSchema", () => {
  test("score 1-5 válido", () => {
    expect(s.RateRideInputSchema.safeParse({ score: 5 }).success).toBe(true);
    expect(s.RateRideInputSchema.safeParse({ score: 3, comment: "ok" }).success).toBe(true);
  });
  test("rechaza score fuera 1-5", () => {
    expect(s.RateRideInputSchema.safeParse({ score: 0 }).success).toBe(false);
    expect(s.RateRideInputSchema.safeParse({ score: 6 }).success).toBe(false);
  });
});

describe("DriverSchema (ride-hailing operator side)", () => {
  test("driver válido pasa", () => {
    const driver = {
      id: "driver_1",
      userId: "user_1",
      jurisdictionId: "uy.mvd",
      operatorId: "su-taxi-mvd",
      serviceKind: "taxi",
      licenseNumber: "ABC123",
      status: "active",
    };
    const r = s.DriverSchema.safeParse(driver);
    expect(r.success).toBe(true);
    // defaults
    expect(r.data.documentVerified).toBe(false);
    expect(r.data.rating.avg).toBe(0);
  });
});
