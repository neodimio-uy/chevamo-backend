const fs = require("fs");
const path = require("path");

const stopSchedules = JSON.parse(fs.readFileSync(path.join(__dirname, "stop-schedules.json"), "utf8"));
const stopLines = JSON.parse(fs.readFileSync(path.join(__dirname, "stop-lines.json"), "utf8"));

// Formato compacto: { stopId: [line1, line2, ...] }
// Solo las líneas, sin horarios — los horarios los pedimos al proxy
const compact = {};
Object.keys(stopLines).forEach(stopId => {
  compact[stopId] = stopLines[stopId];
});

const outPath = path.join(__dirname, "stop-lines-compact.json");
fs.writeFileSync(outPath, JSON.stringify(compact));
const size = Math.round(fs.statSync(outPath).size / 1024);
console.log(`stop-lines-compact.json — ${size}KB`);

// Verificar parada 570
console.log("Parada 570:", compact["570"]);
