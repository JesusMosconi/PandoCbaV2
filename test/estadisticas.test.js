import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import prisma from "../src/db.js";
import { confirmarCheckout, resumenCheckout } from "../src/services/checkout.js";
import { aceptarDevolucionCliente } from "../src/services/devoluciones.js";
import {
  ErrorEstadistica, estadisticasProducto, filtrosEstadisticas, pendientesInicio, periodoAnterior, rankingProductos, resumenInicio,
} from "../src/services/estadisticas.js";
import { confirmarPagoAdmin } from "../src/services/ordenes.js";
import { agregarVentaRapida } from "../src/services/venta-local.js";
import { resumenPorCanal } from "../src/services/ventas-canal.js";
import { exigirBasePrueba } from "./soporte/escenario.js";
import { crearEscenarioLocal, hayCajaAbiertaAjena } from "./soporte/venta-local.js";

const opciones = { skip: !process.env.PANDO_TEST_BRANCH_ID && "Base de prueba no configurada" };

const diaBuenosAires = (fecha) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Argentina/Buenos_Aires",
}).format(fecha);

function rechaza(query, opcionesFiltro, mensaje) {
  assert.throws(() => filtrosEstadisticas(query, opcionesFiltro), (error) =>
    error instanceof ErrorEstadistica && error.status === 400 && error.codigo === "FILTROS_INVALIDOS"
    && mensaje.test(error.message));
}

test("los filtros exigen un período válido de hasta 366 días", () => {
  rechaza({}, {}, /desde/);
  rechaza({ desde: "2026-02-30", hasta: "2026-03-01" }, {}, /fecha válida/);
  rechaza({ desde: "2026-03-02", hasta: "2026-03-01" }, {}, /posterior/);
  rechaza({ desde: "2025-01-01", hasta: "2026-01-02" }, {}, /366/);
  assert.deepEqual(filtrosEstadisticas({ desde: "2025-01-01", hasta: "2026-01-01" }),
    { desde: "2025-01-01", hasta: "2026-01-01" });
  rechaza({ desde: "2026-03-01", hasta: "2026-03-01", canal: "otro" }, {}, /canal/);
  assert.equal(filtrosEstadisticas({ desde: "2026-03-01", hasta: "2026-03-01", canal: "web" },
    { canal: false }).canal, undefined);
});

test("los filtros del ranking validan orden, mínimos y paginación", () => {
  const base = { desde: "2026-03-01", hasta: "2026-03-31" };
  assert.equal(filtrosEstadisticas(base, { ranking: true }).orden, "unidades");
  rechaza({ ...base, orden: "nombre" }, { ranking: true }, /orden/);
  rechaza({ ...base, minUnidades: "-1" }, { ranking: true }, /unidades/);
  rechaza({ ...base, minUnidades: "1.5" }, { ranking: true }, /unidades/);
  rechaza({ ...base, minImporte: "10.123" }, { ranking: true }, /importe/);
  rechaza({ ...base, limite: "101" }, { ranking: true }, /100/);
  rechaza({ ...base, categoriaId: "0" }, { ranking: true }, /categoriaId/);
  assert.deepEqual(filtrosEstadisticas({ ...base, orden: "importe", minUnidades: "0", minImporte: "99.9",
    categoriaId: "4", pagina: "2", limite: "10", canal: "local" }, { ranking: true }), {
    ...base, canal: "local", orden: "importe", categoriaId: 4, pagina: 2, limite: 10,
    minUnidades: 0, minImporte: "99.9" });
});

test("el período anterior tiene la misma duración y termina el día previo", () => {
  assert.deepEqual(periodoAnterior("2026-10-08", "2026-11-06"), { desde: "2026-09-08", hasta: "2026-10-07" });
  assert.deepEqual(periodoAnterior("2026-03-01", "2026-03-01"), { desde: "2026-02-28", hasta: "2026-02-28" });
  assert.deepEqual(periodoAnterior("2024-03-01", "2024-03-31"), { desde: "2024-01-30", hasta: "2024-02-29" });
});

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

/**
 * Producto A (escenario, $100): 1 unidad web y 3 en el local, con 1 devuelta.
 * Producto B ($1.000): 1 unidad en el local. Más una venta rápida de $50.
 */
async function prepararVentas(escenario) {
  await escenario.abrir();
  const web = await ventaWebPagada(escenario);
  const b = await escenario.crearProducto({ precio: "1000.00", stock: 2 });
  await agregarVentaRapida(escenario.operador.id, { concepto: "Accesorio", importe: "50.00" });
  const { venta } = await escenario.vender([
    { talleProductoId: escenario.variante.id, cantidad: 3 },
    { talleProductoId: b.variante.id, cantidad: 1 },
  ]);
  const detalle = await prisma.detalleOrden.findFirst({
    where: { ordenId: venta.id, talleProductoId: escenario.variante.id } });
  await aceptarDevolucionCliente(venta.id, {
    lineas: [{ detalleOrdenId: detalle.id, cantidad: 1 }],
    motivo: "Cambio de talle", claveOperacion: randomUUID(),
  }, escenario.operador.id);
  return { web, venta, a: escenario.producto, b: b.producto };
}

test("el ranking ordena por unidades o importe netos y aplica mínimos, canal y devoluciones", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    const { web, a, b } = await prepararVentas(escenario);
    const hoy = diaBuenosAires(new Date());
    const base = { desde: hoy, hasta: hoy, categoriaId: escenario.categoria.id };
    const ranking = async (filtros) => (await rankingProductos({ orden: "unidades", ...base, ...filtros })).datos;

    const porUnidades = await ranking({});
    assert.deepEqual(porUnidades.map((fila) => fila.productoId), [a.id, b.id]);
    assert.deepEqual(porUnidades.map((fila) => fila.posicion), [1, 2]);
    assert.equal(porUnidades.some((fila) => fila.productoId === null), false);
    const filaA = porUnidades[0];
    assert.equal(filaA.unidadesVendidas, 4);
    assert.equal(filaA.unidadesDevueltas, 1);
    assert.equal(filaA.unidadesNetas, 3);
    assert.equal(filaA.importeVendido, "400.00");
    assert.equal(filaA.importeDevuelto, "100.00");
    assert.equal(filaA.importeNeto, "300.00");
    assert.equal(filaA.precioPromedio, "100.00");
    assert.equal(filaA.cantidadOrdenes, 2);

    assert.deepEqual((await ranking({ orden: "importe" })).map((fila) => fila.productoId), [b.id, a.id]);
    assert.deepEqual((await ranking({ minUnidades: 2 })).map((fila) => fila.productoId), [a.id]);
    assert.deepEqual((await ranking({ minImporte: "500" })).map((fila) => fila.productoId), [b.id]);

    const soloWeb = await ranking({ canal: "web" });
    assert.deepEqual(soloWeb.map((fila) => [fila.productoId, fila.unidadesNetas]), [[a.id, 1]]);

    const pagina = await rankingProductos({ orden: "unidades", ...base, limite: 1, pagina: 2 });
    assert.equal(pagina.totalResultados, 2);
    assert.equal(pagina.paginas, 2);
    assert.deepEqual(pagina.datos.map((fila) => fila.posicion), [2]);

    // Sin pago confirmado la orden no cuenta.
    const pagadaEn = (await prisma.orden.findUnique({ where: { id: web.id } })).pagoConfirmadoEn;
    await prisma.orden.update({ where: { id: web.id }, data: { pagoConfirmadoEn: null } });
    try {
      assert.equal((await ranking({}))[0].unidadesVendidas, 3);
    } finally {
      await prisma.orden.update({ where: { id: web.id }, data: { pagoConfirmadoEn: pagadaEn } });
    }
  });
});

test("el panel coincide con el resumen por canal e incluye la venta rápida", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    await prepararVentas(escenario);
    const hoy = diaBuenosAires(new Date());
    const [panel, resumen] = await Promise.all([
      resumenInicio({ desde: hoy, hasta: hoy }), resumenPorCanal(hoy, hoy)]);

    assert.equal(panel.metricas.total.actual, resumen.total);
    assert.equal(panel.metricas.cantidad.actual, resumen.cantidad);
    assert.deepEqual(panel.canales.map(({ canal, total }) => [canal, total]),
      resumen.canales.map(({ canal, total }) => [canal, total]));
    assert.deepEqual(panel.anterior, periodoAnterior(hoy, hoy));
    assert.equal(panel.serieDiaria.length, 1);
    assert.equal(panel.serieDiaria[0].fecha, hoy);
    assert.equal(panel.serieDiaria[0].total, resumen.total);
    assert.ok(panel.topProductos.length <= 5);
  });
});

test("la serie diaria completa los días sin ventas con cero", opciones, async () => {
  exigirBasePrueba();
  const panel = await resumenInicio({ desde: "2000-01-01", hasta: "2000-01-03" });
  assert.deepEqual(panel.serieDiaria.map(({ fecha, total }) => [fecha, total]),
    [["2000-01-01", "0.00"], ["2000-01-02", "0.00"], ["2000-01-03", "0.00"]]);
  assert.equal(panel.metricas.total.variacion, null);
  assert.equal(panel.metricas.ticketPromedio.actual, "0.00");
});

test("la trazabilidad separa canales y variantes e informa precios y posición", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    const { a } = await prepararVentas(escenario);
    const hoy = diaBuenosAires(new Date());
    const traza = await estadisticasProducto(a.id, { desde: hoy, hasta: hoy });

    assert.equal(traza.producto.id, a.id);
    assert.ok(Number.isSafeInteger(traza.posicion) && traza.posicion >= 1);
    assert.equal(traza.totales.unidadesNetas, 3);
    assert.equal(traza.totales.importeNeto, "300.00");
    assert.deepEqual(traza.canales.map(({ canal, unidadesNetas }) => [canal, unidadesNetas]),
      [["web", 1], ["local", 2]]);
    const variante = traza.variantes.find(({ varianteId }) => varianteId === escenario.variante.id);
    assert.equal(variante.unidadesNetas, 3);
    assert.equal(traza.serieDiaria.length, 1);
    assert.equal(traza.serieDiaria[0].importeNeto, "300.00");
    assert.ok(Array.isArray(traza.precios));

    await assert.rejects(estadisticasProducto(2147483647, { desde: hoy, hasta: hoy }),
      (error) => error instanceof ErrorEstadistica && error.status === 404);
  });
});

test("los pendientes cuentan órdenes, stock crítico y caja desde la base", opciones, async () => {
  const pendientes = await pendientesInicio();
  for (const valor of Object.values(pendientes.ordenes)) assert.ok(Number.isInteger(valor) && valor >= 0);
  assert.equal(pendientes.stock.umbralBajo, 2);
  assert.ok(pendientes.stock.variantes.length <= 8);
  for (const variante of pendientes.stock.variantes) assert.ok(variante.disponible <= 2);
  const disponibles = pendientes.stock.variantes.map((variante) => variante.disponible);
  assert.deepEqual(disponibles, [...disponibles].sort((a, b) => a - b));
  assert.equal(typeof pendientes.caja.abierta, "boolean");
});
