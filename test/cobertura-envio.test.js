import test from "node:test";
import assert from "node:assert/strict";
import { cotizarEntrega } from "../src/services/cobertura-envio.js";

test("retiro no exige dirección y tiene costo cero", () => {
  assert.deepEqual(cotizarEntrega({ tipoEntrega: "retiro" }), {
    cubierta: true, costoEnvio: "0.00", cobertura: "retiro", ciudad: null,
  });
});
test("normaliza la selección expresa de Capital y cobra tarifa fija", () => {
  for (const ciudad of ["Córdoba Capital", " CORDOBA   CAPITAL ", "córdoba capital"]) {
    assert.deepEqual(cotizarEntrega({ tipoEntrega: "envio", datosEnvio: { ciudad, codPostal: "5000" } }), {
      cubierta: true, costoEnvio: "15000.00", cobertura: "cordoba_capital", ciudad: "Córdoba Capital",
    });
  }
});
test("otra localidad y Córdoba sin Capital no habilitan envío", () => {
  for (const ciudad of ["Córdoba", "Villa Allende", "Carlos Paz", "Buenos Aires", "", null]) {
    const resultado = cotizarEntrega({ tipoEntrega: "envio", datosEnvio: { ciudad, codPostal: "5000" } });
    assert.equal(resultado.cubierta, false);
    assert.equal(resultado.costoEnvio, null);
    assert.equal(resultado.codigo, "ENVIO_FUERA_COBERTURA");
  }
});
test("el código postal informativo no se usa para inventar cobertura", () => {
  for (const codPostal of ["5000", "X5009ABC", "9999"]) {
    assert.equal(cotizarEntrega({ tipoEntrega: "envio", datosEnvio: { ciudad: "Córdoba Capital", codPostal } }).cubierta, true);
  }
  assert.equal(cotizarEntrega({ tipoEntrega: "envio", datosEnvio: { ciudad: "Villa Allende", codPostal: "5000" } }).cubierta, false);
});
test("un tipo de entrega desconocido no se interpreta como retiro", () => {
  assert.equal(cotizarEntrega({ tipoEntrega: "otro" }).cubierta, false);
});
