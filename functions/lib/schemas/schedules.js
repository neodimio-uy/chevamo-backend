/**
 * Schema de horarios programados por parada.
 * Devuelve { [lineId]: [time-string...] } — hasta 3 próximos por línea.
 */

const { z } = require("zod");

// HH:MM (o HH:MM:SS) como string — validación mínima, no estricta
const TimeStringSchema = z.string().regex(/^\d{1,2}:\d{2}(:\d{2})?$/);

const SchedulesSchema = z.record(z.string(), z.array(TimeStringSchema));

module.exports = { SchedulesSchema };
