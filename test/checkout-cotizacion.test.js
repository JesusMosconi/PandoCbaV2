import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { resumenCheckout } from "../src/services/checkout.js";

const envio = { tipoEntrega: "envio", datosEnvio: { direccion: "Calle de prueba 123", ciudad: "Córdoba Capital",
  codPostal: "X5000ABC", telefono: "3511234567", email: "tesis@example.invalid" } };
const carrito = { id: 1, items: [{ id: 1, cantidad: 2, talleProductoId: 1,
  precioUnitario: new Prisma.Decimal("20000.01"), productoImprovisadoId: null,
  talleProducto: { id: 1, stock: 3, estado: "activo", talle: { valor: "M" }, color: { nombre: "Negro" },
    producto: { id: 1, nombre: "Tesis", precio: new Prisma.Decimal("20000.01"), activo: true, web: true } } }] };
const tx = { $queryRaw: async () => [{ ahora: new Date() }], reservaStock: { findMany: async () => [] } };

test("cotización de tesis fija el total con centavos y exige la localidad expresa", async () => {
  const anteriores = { ...process.env };
  Object.assign(process.env, { PAGOS_ONLINE_HABILITADOS: "true", PAGOS_ENTORNO: "prueba",
    PANDO_TEST_BRANCH_ID: "br-holy-flower-achmzkpy",
    DATABASE_URL: "postgresql://ficticio:ficticio@ep-delicate-frost-ac77l56d.sa-east-1.aws.neon.tech/neondb" });
  try {
    const retiro = await resumenCheckout(1, { tipoEntrega: "retiro" }, tx, carrito);
    const cubierto = await resumenCheckout(1, envio, tx, carrito);
    assert.equal(retiro.totalFinal, "40000.02");
    assert.equal(retiro.costoEnvio, "0.00");
    assert.equal(cubierto.totalFinal, "55000.02");
    assert.equal(cubierto.costoEnvio, "15000.00");
    assert.equal(cubierto.pagosOnlineDisponibles, true);
    assert.notEqual(retiro.huellaResumen, cubierto.huellaResumen);
    const fuera = await resumenCheckout(1, { ...envio, datosEnvio: { ...envio.datosEnvio, ciudad: "Villa Allende" } }, tx, carrito);
    assert.equal(fuera.puedeConfirmar, false);
    assert.equal(fuera.totalFinal, null);
    assert.equal(fuera.camposInvalidos[0].codigo, "ENVIO_FUERA_COBERTURA");
    process.env.PAGOS_ONLINE_HABILITADOS = "false";
    const manual = await resumenCheckout(1, envio, tx, carrito);
    assert.equal(manual.estadoCostoEnvio, "sin_cotizar");
    assert.equal(manual.totalFinal, null);
    assert.equal(manual.pagosOnlineDisponibles, false);
    assert.notEqual(manual.huellaResumen, cubierto.huellaResumen);
  } finally {
    for (const clave of ["PAGOS_ONLINE_HABILITADOS", "PAGOS_ENTORNO", "PANDO_TEST_BRANCH_ID", "DATABASE_URL"]) {
      if (anteriores[clave] === undefined) delete process.env[clave]; else process.env[clave] = anteriores[clave];
    }
  }
});
