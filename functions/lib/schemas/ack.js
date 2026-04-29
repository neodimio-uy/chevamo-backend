/**
 * Schema universal para endpoints de escritura (POST) que solo confirman éxito.
 * Evita retornar `data: null` — siempre hay shape.
 */

const { z } = require("zod");

const AckSchema = z.object({
  ack: z.literal(true),
});

// Helper: construye un objeto ack listo para `ok(res, ack())`
const ack = () => ({ ack: true });

module.exports = { AckSchema, ack };
