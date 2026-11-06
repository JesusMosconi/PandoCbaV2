import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import prisma from "../src/db.js";
import { cerrarCaja } from "../src/services/caja.js";
import { confirmarCheckout, resumenCheckout } from "../src/services/checkout.js";
import { aceptarDevolucionCliente } from "../src/services/devoluciones.js";
import { informeComprasVentas } from "../src/services/informes.js";
import { confirmarPagoAdmin, listarOrdenesAdmin } from "../src/services/ordenes.js";
import { listarVentas, rangoBuenosAires, resumenPorCanal } from "../src/services/ventas-canal.js";
import { exigirBasePrueba } from "./soporte/escenario.js";
import { crearEscenarioLocal, hayCajaAbiertaAjena } from "./soporte/venta-local.js";

const opciones = { skip: !process.env.PANDO_TEST_BRANCH_ID && "Base de prueba no configurada" };

async function conLocal(t, prueba, escenarioOpciones) {
  exigirBasePrueba();
  if (await hayCajaAbiertaAjena(prisma)) {
    t.skip("La base de prueba tiene una caja abierta ajena a la prueba");
    return;
  }
  const escenario = await crearEscenarioLocal(escenarioOpciones);
  try { await prueba(escenario); } finally { await escenario.limpiar(); }
}

async function ventaWebPagada(escenario, cantidad = 1) {
  const cliente = escenario.clientes[0];
  await escenario.carrito(cliente, [cantidad]);
  const resumen = await resumenCheckout(cliente.id, { tipoEntrega: "retiro" });
  const { orden } = await confirmarCheckout(cliente.id, {
    tipoEntrega: "retiro", huellaResumen: resumen.huellaResumen,
    claveConfirmacion: randomUUID(), aceptaPrecioVigente: true,
  });
  assert.equal((await confirmarPagoAdmin(orden.id, escenario.operador.id)).status, 200);
  return orden;
}

const diaBuenosAires = (fecha) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Argentina/Buenos_Aires",
}).format(fecha);

/** Importe por canal y medio en centavos, para comparar antes y después. */
function centavosPorMedio(resumen) {
  const mapa = new Map();
  for (const canal of resumen.canales) {
    for (const medio of canal.medios) {
      mapa.set(`${canal.canal}:${medio.metodoPago}`, Math.round(Number(medio.total) * 100));
    }
  }
  return mapa;
}

const enCentavos = (importe) => BigInt(importe.replace(".", ""));

test("el día de Buenos Aires incluye su medianoche y excluye la siguiente", () => {
  const { gte, lt } = rangoBuenosAires("2026-03-10", "2026-03-10");
  assert.equal(gte.toISOString(), "2026-03-10T03:00:00.000Z");
  assert.equal(lt.toISOString(), "2026-03-11T03:00:00.000Z");
});

test("los subtotales por canal y medio suman exactamente el total (SC-004)", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    const hoy = diaBuenosAires(new Date());
    const antes = centavosPorMedio(await resumenPorCanal(hoy, hoy));
    await escenario.abrir();
    await ventaWebPagada(escenario);
    await escenario.vender(undefined, { metodoPago: "efectivo" });
    await escenario.vender([{ talleProductoId: escenario.variante.id, cantidad: 2 }], { metodoPago: "debito" });

    const resumen = await resumenPorCanal(hoy, hoy);
    const despues = centavosPorMedio(resumen);
    const delta = (clave) => (despues.get(clave) ?? 0) - (antes.get(clave) ?? 0);
    assert.equal(delta("web:manual"), 10_050);
    assert.equal(delta("local:efectivo"), 10_050);
    assert.equal(delta("local:debito"), 20_100);

    assert.deepEqual(resumen.canales.map(({ canal }) => canal), ["web", "local"]);
    let suma = 0n;
    for (const canal of resumen.canales) {
      const medios = canal.medios.reduce((total, medio) => total + enCentavos(medio.total), 0n);
      assert.equal(medios, enCentavos(canal.total));
      assert.equal(canal.medios.reduce((total, medio) => total + medio.cantidad, 0), canal.cantidad);
      suma += enCentavos(canal.total);
    }
    assert.equal(suma, enCentavos(resumen.total));
  }, { stock: 5, precio: "100.50" });
});

test("el listado filtra por canal y medio y respeta los límites del día", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    await escenario.abrir();
    const web = await ventaWebPagada(escenario);
    const { venta } = await escenario.vender(undefined, { metodoPago: "transferencia" });
    const ids = async (filtros) => (await listarVentas({ limite: 100, ...filtros })).ventas.map(({ id }) => id);

    const locales = await ids({ canal: "local", metodoPago: "transferencia" });
    assert.equal(locales.includes(venta.id), true);
    assert.equal(locales.includes(web.id), false);
    assert.equal((await ids({ canal: "web" })).includes(venta.id), false);
    const fila = (await listarVentas({ canal: "local", limite: 100 })).ventas.find(({ id }) => id === venta.id);
    assert.equal(fila.numeroComprobante, venta.numeroComprobante);
    assert.equal(fila.nombreCliente, null);
    assert.equal(fila.telefonoCliente, null);
    assert.equal("usuarioId" in fila, false);

    // Medianoche de Buenos Aires: pertenece al día que empieza, no al anterior.
    await prisma.orden.update({ where: { id: venta.id }, data: { pagoConfirmadoEn: new Date("2026-03-10T00:00:00-03:00") } });
    assert.equal((await ids({ canal: "local", desde: "2026-03-10", hasta: "2026-03-10" })).includes(venta.id), true);
    assert.equal((await ids({ canal: "local", desde: "2026-03-09", hasta: "2026-03-09" })).includes(venta.id), false);
    await prisma.orden.update({ where: { id: venta.id }, data: { pagoConfirmadoEn: new Date("2026-03-10T23:59:59.999-03:00") } });
    assert.equal((await ids({ canal: "local", desde: "2026-03-10", hasta: "2026-03-10" })).includes(venta.id), true);
    assert.equal((await ids({ canal: "local", desde: "2026-03-11", hasta: "2026-03-11" })).includes(venta.id), false);
  });
});

test("órdenes admin e informe separan el canal sin alterar los totales sin filtro", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    await escenario.abrir();
    const web = await ventaWebPagada(escenario);
    const { venta } = await escenario.vender([{ talleProductoId: escenario.variante.id, cantidad: 2 }]);

    const ordenesLocales = await listarOrdenesAdmin({ canal: "local", metodoPago: "efectivo", limite: 100 });
    const local = ordenesLocales.ordenes.find(({ id }) => id === venta.id);
    assert.equal(local.canal, "local");
    assert.equal(local.numeroComprobante, venta.numeroComprobante);
    assert.equal(local.nombreCliente, null);
    assert.equal(local.cliente, null);
    assert.equal(local.usuarioId, null);
    assert.equal(local.eventos.every(({ actorUsuarioId }) => actorUsuarioId === null), true);
    assert.equal(ordenesLocales.ordenes.some(({ id }) => id === web.id), false);

    const hoy = diaBuenosAires(new Date());
    const base = { desde: hoy, hasta: hoy, productoId: escenario.producto.id, limite: 100 };
    const todos = await informeComprasVentas(base);
    const soloLocal = await informeComprasVentas({ ...base, canal: "local" });
    const soloWeb = await informeComprasVentas({ ...base, canal: "web" });
    assert.equal(todos.resumen.importeVentaAtribuido, "300.00");
    assert.equal(soloLocal.resumen.importeVentaAtribuido, "200.00");
    assert.equal(soloWeb.resumen.importeVentaAtribuido, "100.00");
    assert.equal(todos.datos.filter(({ tipo }) => tipo === "venta").every(({ canal }) => ["web", "local"].includes(canal)), true);
    assert.equal(soloLocal.datos.every(({ tipo, canal }) => tipo === "venta" && canal === "local"), true);
    // Los movimientos de inventario no tienen canal: aparecen solo sin filtro.
    assert.equal(todos.datos.some(({ tipo }) => tipo === "movimiento_inventario"), true);
  }, { stock: 5, fifo: true });
});

test("una devolución posterior no modifica la caja cerrada", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    const caja = await escenario.abrir("500");
    const { venta } = await escenario.vender([{ talleProductoId: escenario.variante.id, cantidad: 2 }]);
    const { caja: cerrada } = await cerrarCaja(escenario.operador.id, caja.id, { efectivoDeclarado: "700" });
    assert.equal(cerrada.diferencia, "0.00");

    const detalle = await prisma.detalleOrden.findFirst({ where: { ordenId: venta.id } });
    await aceptarDevolucionCliente(venta.id, {
      lineas: [{ detalleOrdenId: detalle.id, cantidad: 1 }],
      motivo: "Cambio de talle", claveOperacion: randomUUID(),
    }, escenario.operador.id);

    const despues = await prisma.caja.findUnique({ where: { id: caja.id } });
    assert.equal(despues.cantidadVentas, 1);
    assert.equal(despues.totalVentas.toFixed(2), "200.00");
    assert.equal(despues.efectivoEsperado.toFixed(2), "700.00");
    assert.equal(despues.diferencia.toFixed(2), "0.00");
    assert.deepEqual(despues.totalesPorMedio, { efectivo: "200.00" });
  }, { stock: 3, fifo: true });
});
