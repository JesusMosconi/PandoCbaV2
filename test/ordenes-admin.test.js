import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { confirmarCheckout, resumenCheckout } from "../src/services/checkout.js";
import {
  cambiarEstadoAdmin, cancelarOrdenAdmin, confirmarPagoAdmin, obtenerOrdenAdmin,
} from "../src/services/ordenes.js";
import { esAdmin } from "../src/middleware/es-admin.js";
import { crearEscenario } from "./soporte/escenario.js";

async function crearOrden(escenario, tipoEntrega = "retiro") {
  const usuario = escenario.usuarios[0];
  await escenario.carrito(usuario);
  const datosEnvio = tipoEntrega === "envio" ? {
    direccion: "Calle 123", ciudad: "Córdoba", codPostal: "X5000",
    telefono: "+543511234567", email: "cliente@ejemplo.com",
  } : undefined;
  const resumen = await resumenCheckout(usuario.id, { tipoEntrega, datosEnvio });
  const { orden } = await confirmarCheckout(usuario.id, {
    tipoEntrega, datosEnvio, huellaResumen: resumen.huellaResumen,
    claveConfirmacion: randomUUID(), aceptaPrecioVigente: true,
  });
  return orden;
}

async function estadoReserva(escenario, ordenId) {
  const [reserva, variante, eventos] = await Promise.all([
    escenario.prisma.reservaStock.findFirst({ where: { ordenId } }),
    escenario.prisma.talleProducto.findUnique({ where: { id: escenario.variante.id } }),
    escenario.prisma.eventoOrden.count({ where: { ordenId } }),
  ]);
  return { reserva: reserva.estado, stock: variante.stock, eventos };
}

test("solo el rol admin vigente accede y una orden inexistente da 404", async () => {
  const escenario = await crearEscenario();
  try {
    const usuario = escenario.usuarios[0];
    let estado = null;
    await esAdmin({ usuario: { id: usuario.id } }, {
      status(valor) { estado = valor; return this; }, json() { return this; },
    }, () => { throw new Error("El cliente no debe acceder a administración"); });
    assert.equal(estado, 403);
    await escenario.prisma.usuario.update({ where: { id: usuario.id }, data: { rol: "admin" } });
    let admitido = false;
    await esAdmin({ usuario: { id: usuario.id } }, {}, () => { admitido = true; });
    assert.equal(admitido, true);
    assert.equal(await obtenerOrdenAdmin(2_000_000_000), null);
    assert.equal((await confirmarPagoAdmin(2_000_000_000, usuario.id)).status, 404);
  } finally { await escenario.limpiar(); }
});

test("pago antes del límite acredita solo productos y el reintento no duplica evento", async () => {
  const escenario = await crearEscenario();
  try {
    const orden = await crearOrden(escenario, "envio");
    const actor = escenario.usuarios[0].id;
    const pago = await confirmarPagoAdmin(orden.id, actor);
    const reiterado = await confirmarPagoAdmin(orden.id, actor);
    assert.equal(pago.status, 200);
    assert.equal(pago.importeAcreditado, "120.5");
    assert.equal(pago.orden.totalFinal, null);
    assert.equal(reiterado.reiterada, true);
    assert.deepEqual(await estadoReserva(escenario, orden.id), {
      reserva: "activa", stock: 4, eventos: 2,
    });
  } finally { await escenario.limpiar(); }
});

test("pago exactamente al vencer se rechaza y libera la reserva una sola vez", async () => {
  const escenario = await crearEscenario();
  try {
    const orden = await crearOrden(escenario);
    const [{ ahora }] = await escenario.prisma.$queryRaw`SELECT clock_timestamp() AS ahora`;
    await escenario.prisma.orden.update({ where: { id: orden.id }, data: {
      venceEn: new Date(ahora.getTime() - 1000),
    } });
    const actor = escenario.usuarios[0].id;
    const primero = await confirmarPagoAdmin(orden.id, actor);
    const reiterado = await confirmarPagoAdmin(orden.id, actor);
    assert.equal(primero.status, 409);
    assert.equal(primero.orden.estado, "cancelada_vencimiento");
    assert.equal(reiterado.status, 409);
    assert.deepEqual(await estadoReserva(escenario, orden.id), {
      reserva: "liberada", stock: 4, eventos: 2,
    });
  } finally { await escenario.limpiar(); }
});

test("envío exige constancia y no admite saltos; la transición repetida no consume dos veces", async () => {
  const escenario = await crearEscenario();
  try {
    const orden = await crearOrden(escenario, "envio");
    const actor = escenario.usuarios[0].id;
    assert.equal((await cambiarEstadoAdmin(orden.id, actor, "enviada", true)).status, 409);
    assert.equal((await confirmarPagoAdmin(orden.id, actor)).status, 200);
    assert.equal((await cambiarEstadoAdmin(orden.id, actor, "lista_para_retiro")).status, 409);
    assert.equal((await cambiarEstadoAdmin(orden.id, actor, "en_preparacion")).status, 200);
    assert.equal((await cambiarEstadoAdmin(orden.id, actor, "enviada")).status, 409);
    const enviada = await cambiarEstadoAdmin(orden.id, actor, "enviada", true);
    const reiterada = await cambiarEstadoAdmin(orden.id, actor, "enviada", true);
    assert.equal(enviada.status, 200);
    assert.equal(reiterada.reiterada, true);
    assert.deepEqual(await estadoReserva(escenario, orden.id), {
      reserva: "consumida", stock: 3, eventos: 4,
    });
  } finally { await escenario.limpiar(); }
});

test("cancelar una pagada antes del consumo libera o consume según decisión expresa", async () => {
  for (const restituir of [true, false]) {
    const escenario = await crearEscenario();
    try {
      const orden = await crearOrden(escenario);
      const actor = escenario.usuarios[0].id;
      await confirmarPagoAdmin(orden.id, actor);
      assert.equal((await cancelarOrdenAdmin(orden.id, actor, "Prueba")).status, 400);
      const cancelada = await cancelarOrdenAdmin(orden.id, actor, "Prueba", restituir);
      const reiterada = await cancelarOrdenAdmin(orden.id, actor, "Prueba", restituir);
      assert.equal(cancelada.status, 200);
      assert.equal(cancelada.orden.estado, "cancelada_admin");
      assert.equal(reiterada.reiterada, true);
      assert.deepEqual(await estadoReserva(escenario, orden.id), {
        reserva: restituir ? "liberada" : "consumida", stock: restituir ? 4 : 3, eventos: 3,
      });
    } finally { await escenario.limpiar(); }
  }
});

test("después de la salida física se exige devolución y no se altera el stock", async () => {
  for (const restituir of [true, false]) {
    const escenario = await crearEscenario();
    try {
      const orden = await crearOrden(escenario, "envio");
      const actor = escenario.usuarios[0].id;
      await confirmarPagoAdmin(orden.id, actor);
      await cambiarEstadoAdmin(orden.id, actor, "en_preparacion");
      await cambiarEstadoAdmin(orden.id, actor, "enviada", true);
      const cancelada = await cancelarOrdenAdmin(orden.id, actor, "Prueba", restituir);
      assert.equal(cancelada.status, 409);
      assert.equal(cancelada.codigo, "DEVOLUCION_REQUERIDA");
      assert.deepEqual(await estadoReserva(escenario, orden.id), {
        reserva: "consumida", stock: 3, eventos: 4,
      });
    } finally { await escenario.limpiar(); }
  }
});
