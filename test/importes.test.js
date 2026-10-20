import assert from "node:assert/strict";
import test from "node:test";
import { atribuirCentavos, centavos, costoTotal, importeDecimal } from "../src/services/importes.js";

test("costo desconocido se distingue de costo conocido cero", () => {
  assert.equal(costoTotal(null, 3), null);
  assert.equal(costoTotal("0.00", 3), "0.00");
  assert.equal(costoTotal("12.35", 3), "37.05");
});

test("centavos exactos no aceptan importes ambiguos", () => {
  assert.equal(centavos("9007199254740993.01"), 900719925474099301n);
  assert.equal(importeDecimal(-101n), "-1.01");
  assert.throws(() => centavos("1.001"));
  assert.throws(() => centavos(1.01));
});

test("reparte centavos restantes por mayor fracción y desempate FIFO", () => {
  assert.deepEqual(atribuirCentavos("0.05", [1n, 1n, 1n]), ["0.02", "0.02", "0.01"]);
  assert.deepEqual(atribuirCentavos("0.05", [1n, 3n, 1n]), ["0.01", "0.03", "0.01"]);
  assert.equal(atribuirCentavos("19.99", [4n, 3n, 3n]).reduce((s, item) => s + centavos(item), 0n), 1999n);
});
