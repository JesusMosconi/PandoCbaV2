import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ErrorCaja, abrirCaja, cerrarCaja, esDeJornadaAnterior, normalizarImporte, obtenerCajaActual,
} from "../src/services/caja.js";
import { agregarItem, confirmarVentaLocal, obtenerVentaEnCurso, resumenVentaLocal } from "../src/services/venta-local.js";
import prisma from "../src/db.js";
import { exigirBasePrueba } from "./soporte/escenario.js";
import { crearEscenarioLocal, hayCajaAbiertaAjena } from "./soporte/venta-local.js";

const opciones = { skip: !process.env.PANDO_TEST_BRANCH_ID && "Base de prueba no configurada" };

async function conCaja(t, prueba, escenarioOpciones) {
  exigirBasePrueba();
  if (await hayCajaAbiertaAjena(prisma)) {
    t.skip("La base de prueba tiene una caja abierta ajena a la prueba");
    return;
  }
  const escenario = await crearEscenarioLocal(escenarioOpciones);
  try { await prueba(escenario); } finally { await escenario.limpiar(); }
}

test("el importe admite hasta dos decimales y rechaza negativos o texto", () => {
  assert.equal(normalizarImporte("10000", "importe").toFixed(2), "10000.00");
  assert.equal(normalizarImporte(0.5, "importe").toFixed(2), "0.50");
  for (const invalido of ["-1", "1.234", "abc", "", null, Number.NaN, "01"]) {
    assert.throws(() => normalizarImporte(invalido, "importe"),
      (error) => error instanceof ErrorCaja && error.codigo === "IMPORTE_INVALIDO");
  }
});

test("una caja es de una jornada anterior según el día de Buenos Aires", () => {
  // 02:00 UTC del 4/11 es el 3/11 a las 23:00 en Buenos Aires.
  const caja = { estado: "abierta", abiertaEn: new Date("2026-11-04T02:00:00Z") };
  assert.equal(esDeJornadaAnterior(caja, new Date("2026-11-04T02:59:00Z")), false);
  assert.equal(esDeJornadaAnterior(caja, new Date("2026-11-04T03:00:00Z")), true);
  assert.equal(esDeJornadaAnterior({ ...caja, estado: "cerrada" }, new Date("2026-11-10T12:00:00Z")), false);
  assert.equal(esDeJornadaAnterior(null), false);
});

test("cerrar la caja descarta las ventas en curso sin confirmar", opciones, async (t) => {
  await conCaja(t, async (escenario) => {
    const caja = await escenario.abrir();
    await agregarItem(escenario.operador.id, { talleProductoId: escenario.variante.id, cantidad: 1 });
    const antes = await obtenerVentaEnCurso(escenario.operador.id);
    assert.equal(antes.lineas.length, 1);

    const cierre = await cerrarCaja(escenario.operador.id, caja.id, { efectivoDeclarado: "0" });
    assert.equal(cierre.ventasEnCursoDescartadas >= 1, true);
    assert.equal((await prisma.carrito.findUnique({ where: { id: antes.carritoId } })).estado, "expirado");
    const despues = await obtenerVentaEnCurso(escenario.operador.id);
    assert.notEqual(despues.carritoId, antes.carritoId);
    assert.equal(despues.lineas.length, 0);
  });
});

test("una caja abierta un día anterior bloquea las ventas hasta cerrarla", opciones, async (t) => {
  await conCaja(t, async (escenario) => {
    const caja = await escenario.abrir();
    await prisma.caja.update({ where: { id: caja.id }, data: { abiertaEn: new Date(Date.now() - 36 * 60 * 60 * 1000) } });
    assert.equal((await obtenerCajaActual()).deJornadaAnterior, true);

    await agregarItem(escenario.operador.id, { talleProductoId: escenario.variante.id, cantidad: 1 });
    const resumen = await resumenVentaLocal(prisma, escenario.operador.id);
    assert.equal(resumen.caja.deJornadaAnterior, true);
    assert.equal(resumen.puedeConfirmar, false);
    await assert.rejects(confirmarVentaLocal(escenario.operador.id, {
      claveConfirmacion: randomUUID(), huellaResumen: resumen.huellaResumen, metodoPago: "efectivo",
    }), (error) => error.status === 409 && error.codigo === "CAJA_JORNADA_ANTERIOR");

    await cerrarCaja(escenario.operador.id, caja.id, { efectivoDeclarado: "0" });
    const nueva = await escenario.abrir();
    assert.equal((await obtenerCajaActual()).deJornadaAnterior, false);
    assert.notEqual(nueva.id, caja.id);
  });
});

test("la apertura es idempotente por clave y una segunda caja se rechaza", opciones, async (t) => {
  await conCaja(t, async ({ operador }) => {
    const clave = randomUUID();
    const primera = await abrirCaja(operador.id, { claveApertura: clave, efectivoInicial: "10000" });
    const reintento = await abrirCaja(operador.id, { claveApertura: clave, efectivoInicial: "10000" });
    assert.equal(primera.creada, true);
    assert.equal(reintento.creada, false);
    assert.equal(reintento.caja.id, primera.caja.id);
    assert.equal(primera.caja.efectivoInicial, "10000.00");
    await assert.rejects(abrirCaja(operador.id, { claveApertura: randomUUID(), efectivoInicial: "0" }),
      (error) => error.status === 409 && error.codigo === "CAJA_YA_ABIERTA" && error.caja.id === primera.caja.id);
    assert.equal(await prisma.caja.count({ where: { estado: "abierta" } }), 1);
  });
});

test("dos aperturas simultáneas con claves distintas dejan una sola caja abierta", opciones, async (t) => {
  await conCaja(t, async ({ operador }) => {
    const resultados = await Promise.allSettled([1, 2].map(() =>
      abrirCaja(operador.id, { claveApertura: randomUUID(), efectivoInicial: "500" })));
    assert.equal(resultados.filter(({ status }) => status === "fulfilled").length, 1);
    const rechazo = resultados.find(({ status }) => status === "rejected");
    assert.equal(rechazo.reason.codigo, "CAJA_YA_ABIERTA");
    assert.equal(await prisma.caja.count({ where: { estado: "abierta" } }), 1);
  });
});

test("esperado = inicial + efectivo y diferencia = declarado - esperado (SC-005)", opciones, async (t) => {
  await conCaja(t, async (escenario) => {
    const remera = await escenario.crearProducto({ precio: "25000.00" });
    const campera = await escenario.crearProducto({ precio: "40000.00" });
    const caja = await escenario.abrir("10000");
    await escenario.vender([{ talleProductoId: remera.variante.id, cantidad: 1 }]);
    await escenario.vender([{ talleProductoId: remera.variante.id, cantidad: 1 }]);
    await escenario.vender([{ talleProductoId: campera.variante.id, cantidad: 1 }], { metodoPago: "debito" });

    const abierta = await obtenerCajaActual();
    assert.equal(abierta.id, caja.id);
    assert.equal(abierta.cantidadVentas, 3);
    assert.deepEqual(abierta.totalesPorMedio, { efectivo: "50000.00", debito: "40000.00" });
    assert.equal(abierta.totalVentas, "90000.00");
    assert.equal(abierta.efectivoEsperado, "60000.00");

    const { caja: cerrada } = await cerrarCaja(escenario.operador.id, caja.id,
      { efectivoDeclarado: "59000", observacion: "  Faltante de cambio  " });
    assert.equal(cerrada.estado, "cerrada");
    assert.equal(cerrada.cantidadVentas, 3);
    assert.equal(cerrada.efectivoEsperado, "60000.00");
    assert.equal(cerrada.efectivoDeclarado, "59000.00");
    assert.equal(cerrada.diferencia, "-1000.00");
    assert.equal(cerrada.observacion, "Faltante de cambio");
    assert.deepEqual(cerrada.totalesPorMedio, { efectivo: "50000.00", debito: "40000.00" });
    assert.equal(await obtenerCajaActual(), null);
  });
});

test("el cierre repetido devuelve el mismo cierre, otro importe da 409 y la caja no se reabre", opciones, async (t) => {
  await conCaja(t, async ({ operador }) => {
    const clave = randomUUID();
    const { caja } = await abrirCaja(operador.id, { claveApertura: clave, efectivoInicial: "100" });
    const primero = await cerrarCaja(operador.id, caja.id, { efectivoDeclarado: "100" });
    const reiterado = await cerrarCaja(operador.id, caja.id, { efectivoDeclarado: "100.00" });
    assert.equal(primero.reiterada, false);
    assert.equal(reiterado.reiterada, true);
    assert.equal(reiterado.caja.cerradaEn.getTime(), primero.caja.cerradaEn.getTime());
    await assert.rejects(cerrarCaja(operador.id, caja.id, { efectivoDeclarado: "90" }),
      (error) => error.status === 409 && error.codigo === "CAJA_CERRADA");
    await assert.rejects(cerrarCaja(operador.id, 2_000_000_000, { efectivoDeclarado: "0" }),
      (error) => error.status === 404);

    // Reintentar la apertura con la misma clave devuelve la caja cerrada, sin reabrirla.
    const reapertura = await abrirCaja(operador.id, { claveApertura: clave, efectivoInicial: "100" });
    assert.equal(reapertura.creada, false);
    assert.equal(reapertura.caja.estado, "cerrada");
    const nueva = await abrirCaja(operador.id, { claveApertura: randomUUID(), efectivoInicial: "0" });
    assert.notEqual(nueva.caja.id, caja.id);
    assert.equal((await prisma.caja.findUnique({ where: { id: caja.id } })).estado, "cerrada");
  });
});
