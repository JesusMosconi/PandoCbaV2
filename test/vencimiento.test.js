import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { confirmarCheckout, resumenCheckout } from "../src/services/checkout.js";
import { disponibilidadVariantes, horaBaseDatos } from "../src/services/inventario.js";
import {
  barrerOrdenesVencidas, cancelarOrdenCliente, confirmarPagoAdmin,
  obtenerOrdenAdmin, obtenerOrdenCliente,
} from "../src/services/ordenes.js";
import { crearEscenario } from "./soporte/escenario.js";

async function crearOrden(escenario) {
  const usuario = escenario.usuarios[0];
  await escenario.carrito(usuario);
  const resumen = await resumenCheckout(usuario.id, { tipoEntrega: "retiro" });
  const { orden } = await confirmarCheckout(usuario.id, {
    tipoEntrega: "retiro", huellaResumen: resumen.huellaResumen,
    claveConfirmacion: randomUUID(), aceptaPrecioVigente: true,
  });
  return orden;
}

async function medir(escenario, ordenId) {
  const [orden, reserva, eventos, variante] = await Promise.all([
    escenario.prisma.orden.findUnique({ where: { id: ordenId } }),
    escenario.prisma.reservaStock.findFirst({ where: { ordenId } }),
    escenario.prisma.eventoOrden.count({ where: { ordenId } }),
    escenario.prisma.talleProducto.findUnique({ where: { id: escenario.variante.id } }),
  ]);
  return { orden, reserva, eventos, variante };
}

test("antes de T, la reserva reduce disponibilidad y el barrido no cancela", async () => {
  const escenario = await crearEscenario({ stock: 1 });
  try {
    const orden = await crearOrden(escenario);
    const antes = await horaBaseDatos(escenario.prisma);
    const disponibilidad = await disponibilidadVariantes(escenario.prisma, [escenario.variante], antes);
    assert.equal(disponibilidad.get(escenario.variante.id), 0);
    const barrido = await barrerOrdenesVencidas({ excluirIds: [] });
    assert.equal(barrido.procesadas.includes(orden.id), false);
    assert.equal((await medir(escenario, orden.id)).orden.estado, "pendiente_pago");
  } finally { await escenario.limpiar(); }
});

test("en T, la reserva ya no compromete stock ni admite pago; la vista indica proceso", async () => {
  const escenario = await crearEscenario({ stock: 1 });
  try {
    const orden = await crearOrden(escenario);
    const limite = await horaBaseDatos(escenario.prisma);
    await escenario.prisma.orden.update({ where: { id: orden.id }, data: { venceEn: limite } });
    const disponibilidad = await disponibilidadVariantes(escenario.prisma, [escenario.variante]);
    assert.equal(disponibilidad.get(escenario.variante.id), 1);
    const cliente = await obtenerOrdenCliente(escenario.usuarios[0].id, orden.id);
    const admin = await obtenerOrdenAdmin(orden.id);
    assert.equal(cliente.estadoVisible, "reserva_vencida_en_proceso");
    assert.equal(admin.estadoVisible, "reserva_vencida_en_proceso");
    assert.equal(cliente.puedeCancelar, false);
    const pago = await confirmarPagoAdmin(orden.id, escenario.usuarios[0].id);
    assert.equal(pago.status, 409);
    assert.equal((await medir(escenario, orden.id)).orden.estado, "cancelada_vencimiento");
  } finally { await escenario.limpiar(); }
});

test("barrido tardío y repetido conserva el límite, libera una vez y muestra cancelación", async () => {
  const escenario = await crearEscenario({ stock: 1 });
  try {
    const orden = await crearOrden(escenario);
    const limite = new Date(Date.now() - 60_000);
    await escenario.prisma.orden.update({ where: { id: orden.id }, data: { venceEn: limite } });
    const primero = await barrerOrdenesVencidas();
    const segundo = await barrerOrdenesVencidas();
    assert.equal(primero.procesadas.includes(orden.id), true);
    assert.equal(segundo.procesadas.includes(orden.id), false);
    const { orden: final, reserva, eventos, variante } = await medir(escenario, orden.id);
    assert.equal(final.estado, "cancelada_vencimiento");
    assert.equal(final.venceEn.toISOString(), limite.toISOString());
    assert.ok(final.canceladaEn > limite);
    assert.equal(reserva.estado, "liberada");
    assert.equal(eventos, 2);
    assert.equal(variante.stock, 1);
    const cliente = await obtenerOrdenCliente(escenario.usuarios[0].id, orden.id);
    assert.equal(cliente.estadoVisible, "cancelada_vencimiento");
    assert.equal(cliente.canceladaEn, final.canceladaEn.toISOString());
  } finally { await escenario.limpiar(); }
});

test("pago anterior a T permanece pagado aun después del límite y del barrido", async () => {
  const escenario = await crearEscenario({ stock: 1 });
  try {
    const orden = await crearOrden(escenario);
    assert.equal((await confirmarPagoAdmin(orden.id, escenario.usuarios[0].id)).status, 200);
    await escenario.prisma.orden.update({ where: { id: orden.id }, data: {
      venceEn: new Date(Date.now() - 60_000),
    } });
    const barrido = await barrerOrdenesVencidas();
    assert.equal(barrido.procesadas.includes(orden.id), false);
    const { orden: final, reserva, eventos } = await medir(escenario, orden.id);
    assert.equal(final.estado, "pago_confirmado");
    assert.equal(reserva.estado, "activa");
    assert.equal(eventos, 2);
  } finally { await escenario.limpiar(); }
});

test("carreras con pago y cancelación después de T generan una sola transición", async () => {
  for (const accion of ["pago", "cancelacion"]) {
    const escenario = await crearEscenario({ stock: 1 });
    try {
      const orden = await crearOrden(escenario);
      const horaBase = await horaBaseDatos(escenario.prisma);
      await escenario.prisma.orden.update({ where: { id: orden.id }, data: {
        venceEn: new Date(horaBase.getTime() - 60_000),
      } });
      const actuar = accion === "pago"
        ? confirmarPagoAdmin(orden.id, escenario.usuarios[0].id)
        : cancelarOrdenCliente(escenario.usuarios[0].id, orden.id);
      const [accionResultado, barrido] = await Promise.all([actuar, barrerOrdenesVencidas()]);
      assert.equal(accionResultado.status, 409);
      assert.ok(barrido.procesadas.includes(orden.id) || barrido.omitidas.includes(orden.id)
        || barrido.seleccionadas === 0);
      const { orden: final, reserva, eventos, variante } = await medir(escenario, orden.id);
      assert.equal(final.estado, "cancelada_vencimiento");
      assert.equal(reserva.estado, "liberada");
      assert.equal(eventos, 2);
      assert.equal(variante.stock, 1);
    } finally { await escenario.limpiar(); }
  }
});
