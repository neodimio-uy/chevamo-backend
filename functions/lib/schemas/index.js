/**
 * Barrel file — re-exporta todos los schemas canónicos del backend.
 * Punto único de import para las rutas: `require("./lib/schemas")`.
 */

module.exports = {
  ...require("./health"),
  ...require("./bus"),
  ...require("./busstop"),
  ...require("./upcomingBus"),
  ...require("./lineVariant"),
  ...require("./place"),
  ...require("./directions"),
  ...require("./ack"),
  ...require("./schedules"),
  ...require("./weather"),
  ...require("./airQuality"),
  ...require("./feeds/canonical-vehicle"),
};
