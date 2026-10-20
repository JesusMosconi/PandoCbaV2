import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { costoVentaOrden } from "../src/services/costos.js";

const decimal = (valor) => new Prisma.Decimal(valor);
const orden = {
  id: 1, pagoConfirmadoEn: new Date(), subtotal: decimal("300.00"),
  detalles: [{ cantidad: 2 }],
};
const asignacion = (partidaId, importe, costo, cantidad = 1) => ({
  partidaId, cantidad, estado: "vendida",
  importeEfectivo: decimal(importe),
  descuentoAtribuido: decimal("0.00"),
  costoUnitarioAlPago: costo === null ? null : decimal(costo),
  devolucionesCliente: [],
  partida: { origen: "ingreso", costoUnitario: costo === null ? null : decimal(costo),
    ingreso: { proveedor: { id: partidaId, nombre: `Proveedor ${partidaId}` } } },
});

test("costo cero conocido permite margen; costo desconocido lo deja indeterminado", async () => {
  const conocido = await costoVentaOrden(orden, {
    asignacionPartida: { findMany: async () => [
      asignacion(1, "150.00", "0.00"), asignacion(2, "150.00", "100.00"),
    ] },
  });
  assert.equal(conocido.estado, "completo");
  assert.equal(conocido.costoConocido, "100.00");
  assert.equal(conocido.margenBruto, "200.00");
  assert.deepEqual(conocido.origenes.map(({ proveedorId }) => proveedorId), [1, 2]);

  const desconocido = await costoVentaOrden(orden, {
    asignacionPartida: { findMany: async () => [
      asignacion(1, "150.00", null), asignacion(2, "150.00", "100.00"),
    ] },
  });
  assert.equal(desconocido.estado, "costo_desconocido");
  assert.equal(desconocido.unidadesSinCosto, 1);
  assert.equal(desconocido.margenBruto, null);
});

test("no afirma margen para una orden con cobertura FIFO parcial o sin pago", async () => {
  const parcial = await costoVentaOrden(orden, {
    asignacionPartida: { findMany: async () => [asignacion(1, "150.00", "100.00")] },
  });
  assert.equal(parcial.estado, "parcial");
  assert.equal(parcial.margenBruto, null);
  const sinPago = await costoVentaOrden({ ...orden, pagoConfirmadoEn: null }, {
    asignacionPartida: { findMany: async () => { throw new Error("No debe consultar asignaciones"); } },
  });
  assert.equal(sinPago.estado, "sin_pago");
});
