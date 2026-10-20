import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { crearEscenario } from "./soporte/escenario.js";
import { confirmarCheckout, resumenCheckout } from "../src/services/checkout.js";
import { confirmarPagoAdmin } from "../src/services/ordenes.js";
import { ajustarInventario } from "../src/services/inventario.js";
import {
  activarCorteInventario, conciliarCorteInventario, incorporarVariante,
  iniciarCorteInventario, registrarRutasVerificadas, registrarVarianteBloqueada,
} from "../src/services/corte-inventario.js";

test("el corte se reanuda sin duplicar saldos y solo se activa tras verificar rutas", {
  skip: process.env.PANDO_TEST_SPECIAL !== "1",
}, async () => {
  const primera = await crearEscenario({ stock: 10 });
  const segunda = await crearEscenario({ stock: 5 });
  const nueva = await crearEscenario({ stock: 3 });
  const bloqueada = await crearEscenario({ stock: 1 });
  const db = primera.prisma;
  const actor = primera.usuarios[0].id;
  const variantes = [primera, segunda, nueva, bloqueada];
  await db.talleProducto.updateMany({
    where: { id: { in: [nueva.variante.id, bloqueada.variante.id] } },
    data: { inicioInventarioCero: true },
  });
  const partida = await db.partidaInventario.create({ data: {
    varianteId: nueva.variante.id, origen: "ajuste", cantidadOriginal: 3,
    costoUnitario: "4.00", confirmadaEn: new Date(),
  } });
  await db.movimientoInventario.create({ data: {
    varianteId: nueva.variante.id, partidaId: partida.id, tipo: "ajuste_positivo",
    cantidad: 3, motivo: "Fixture de corte", actorUsuarioId: actor,
  } });
  await primera.carrito(primera.usuarios[0], [2]);
  const resumen = await resumenCheckout(actor, { tipoEntrega: "retiro" });
  const { orden } = await confirmarCheckout(actor, {
    tipoEntrega: "retiro", huellaResumen: resumen.huellaResumen,
    claveConfirmacion: randomUUID(), aceptaPrecioVigente: true,
  });
  const actorPagado = segunda.usuarios[0].id;
  await segunda.carrito(segunda.usuarios[0], [1]);
  const resumenPagado = await resumenCheckout(actorPagado, { tipoEntrega: "retiro" });
  const { orden: ordenPagada } = await confirmarCheckout(actorPagado, {
    tipoEntrega: "retiro", huellaResumen: resumenPagado.huellaResumen,
    claveConfirmacion: randomUUID(), aceptaPrecioVigente: true,
  });
  assert.equal((await confirmarPagoAdmin(ordenPagada.id, actorPagado)).status, 200);

  await iniciarCorteInventario(actor);
  const [escrituraSuspendida, corteConcurrente] = await Promise.allSettled([
    ajustarInventario({ varianteId: primera.variante.id, tipo: "positivo",
      cantidad: 1, motivo: "Durante corte", actorUsuarioId: actor }),
    incorporarVariante(primera.variante.id, actor, null),
  ]);
  assert.equal(escrituraSuspendida.status, "rejected");
  assert.equal(escrituraSuspendida.reason.codigo, "INVENTARIO_SUSPENDIDO");
  assert.equal(corteConcurrente.status, "fulfilled");
  const inicial = corteConcurrente.value;
  assert.equal(inicial.reiterada, false);
  assert.equal((await incorporarVariante(primera.variante.id, actor, null)).reiterada, true);
  const existencia = await db.existenciaInicial.findUnique({ where: { varianteId: primera.variante.id } });
  assert.equal(existencia.saldoFisico, 10);
  assert.equal(existencia.costoUnitario, null);
  const asignaciones = await db.asignacionPartida.findMany({ where: {
    detalleOrden: { ordenId: orden.id },
  } });
  assert.equal(asignaciones.reduce((total, item) => total + item.cantidad, 0), 2);
  assert.equal(asignaciones[0].estado, "reservada");
  assert.equal((await db.talleProducto.findUnique({ where: { id: primera.variante.id } })).stock, 10);

  await assert.rejects(conciliarCorteInventario(), (error) => error.codigo === "CORTE_INCOMPLETO");
  await assert.rejects(incorporarVariante(bloqueada.variante.id, actor),
    (error) => error.codigo === "RESERVA_SIN_PARTIDA");
  await registrarVarianteBloqueada(bloqueada.variante.id, actor, "Falta procedencia");
  assert.equal((await db.estadoCorteVariante.findUnique({ where: {
    varianteId: bloqueada.variante.id,
  } })).estado, "bloqueado");

  await incorporarVariante(segunda.variante.id, actor, "0.00");
  const asignacionesPagadas = await db.asignacionPartida.findMany({ where: {
    detalleOrden: { ordenId: ordenPagada.id },
  } });
  assert.equal(asignacionesPagadas.reduce((total, item) => total + item.cantidad, 0), 1);
  assert.equal(asignacionesPagadas.every((item) => item.estado === "vendida"), true);
  assert.equal((await db.talleProducto.findUnique({ where: { id: segunda.variante.id } })).stock, 5);
  await incorporarVariante(nueva.variante.id, actor);
  assert.equal(await db.existenciaInicial.count({ where: { varianteId: nueva.variante.id } }), 0);
  const partidaRecuperada = await db.partidaInventario.create({ data: {
    varianteId: bloqueada.variante.id, origen: "ajuste", cantidadOriginal: 1,
    costoUnitario: null, confirmadaEn: new Date(),
  } });
  await db.movimientoInventario.create({ data: {
    varianteId: bloqueada.variante.id, partidaId: partidaRecuperada.id,
    tipo: "ajuste_positivo", cantidad: 1, motivo: "Procedencia recuperada", actorUsuarioId: actor,
  } });
  await incorporarVariante(bloqueada.variante.id, actor);
  const conciliado = await conciliarCorteInventario();
  assert.equal(conciliado.estado, "conciliado");
  assert.equal(conciliado.suspendido, true);
  await assert.rejects(activarCorteInventario(actor),
    (error) => error.codigo === "ACTIVACION_NO_AUTORIZADA");
  await registrarRutasVerificadas(actor);
  const activo = await activarCorteInventario(actor);
  assert.equal(activo.estado, "activo");
  assert.equal(activo.suspendido, false);
  assert.equal((await db.existenciaInicial.findUnique({ where: {
    varianteId: segunda.variante.id,
  } })).costoUnitario.toFixed(2), "0.00");
  assert.equal(variantes.length, 4);
});
