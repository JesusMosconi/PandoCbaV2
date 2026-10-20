import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { crearEscenario } from "./soporte/escenario.js";
import { crearProveedor } from "../src/services/proveedores.js";
import { crearBorradorIngreso, confirmarIngreso } from "../src/services/compras.js";
import { resumenCheckout, confirmarCheckout } from "../src/services/checkout.js";
import { confirmarPagoAdmin, cambiarEstadoAdmin } from "../src/services/ordenes.js";
import { aceptarDevolucionCliente, registrarReintegro } from "../src/services/devoluciones.js";
import { informeComprasVentas, historialProducto } from "../src/services/informes.js";
import { ajustarInventario } from "../src/services/inventario.js";

test("informe separa recepción y venta de enero de reintegro de febrero sin cambiar el resumen al paginar", {
  skip: process.env.PANDO_TEST_SPECIAL !== "1",
}, async () => {
  const e = await crearEscenario({ stock: 0, precio: "200.00" });
  const db = e.prisma;
  const actor = e.usuarios[0].id;
  const corte = await db.estadoCorteInventario.findUnique({ where: { id: 1 } });
  assert.equal(corte.estado, "activo");
  await db.talleProducto.update({ where: { id: e.variante.id },
    data: { inicioInventarioCero: true } });
  await db.estadoCorteVariante.create({ data: {
    varianteId: e.variante.id, corteId: corte.id, estado: "conciliado",
    origen: "nueva", saldoCapturado: 0, comprometido: 0, diferencia: 0,
    conciliadoEn: new Date(), conciliadoPorId: actor,
  } });
  const proveedor = await crearProveedor({ nombre: `Informe ${randomUUID()}` }, actor);
  const ingreso = await crearBorradorIngreso({ proveedorId: proveedor.id,
    fechaCompra: "2026-01-04", fechaRecepcion: "2026-01-05",
    lineas: [{ varianteId: e.variante.id, cantidad: 3, costoUnitario: "50.00" }] });
  await confirmarIngreso(ingreso.id, { claveOperacion: randomUUID(),
    resumenAceptado: ingreso.huellaResumen }, actor);
  await e.carrito(e.usuarios[0], [2]);
  const resumen = await resumenCheckout(actor, { tipoEntrega: "retiro" });
  const { orden } = await confirmarCheckout(actor, { tipoEntrega: "retiro",
    huellaResumen: resumen.huellaResumen, claveConfirmacion: randomUUID(),
    aceptaPrecioVigente: true });
  assert.equal((await confirmarPagoAdmin(orden.id, actor)).status, 200);
  for (const estado of ["en_preparacion", "lista_para_retiro", "entregada"]) {
    assert.equal((await cambiarEstadoAdmin(orden.id, actor, estado)).status, 200);
  }
  const detalle = await db.detalleOrden.findFirst({ where: { ordenId: orden.id } });
  const aceptada = await aceptarDevolucionCliente(orden.id, {
    lineas: [{ detalleOrdenId: detalle.id, cantidad: 1 }],
    motivo: "Períodos de informe", claveOperacion: randomUUID(),
  }, actor);
  const devolucionId = aceptada.devoluciones[0].id;
  await registrarReintegro(orden.id, devolucionId, {
    importeEfectivo: "200.00", claveOperacion: randomUUID(),
  }, actor);
  // El fixture conserva los hechos, pero los fecha en dos meses contables explícitos.
  await db.orden.update({ where: { id: orden.id },
    data: { pagoConfirmadoEn: new Date("2026-01-10T15:00:00Z") } });
  await db.devolucionCliente.update({ where: { id: devolucionId },
    data: { aceptadaEn: new Date("2026-02-03T15:00:00Z") } });
  await db.pagoReintegro.updateMany({ where: { devolucionId },
    data: { fecha: new Date("2026-02-04T15:00:00Z") } });
  const filtros = { productoId: e.producto.id, varianteId: e.variante.id,
    proveedorId: proveedor.id, pagina: 1, limite: 2 };
  const enero = await informeComprasVentas({ ...filtros, desde: "2026-01-01", hasta: "2026-01-31" });
  assert.equal(enero.resumen.compras, "150.00");
  assert.equal(enero.resumen.importeVentaAtribuido, "400.00");
  assert.equal(enero.resumen.costoVendidoConocido, "100.00");
  assert.equal(enero.resumen.margenBruto, "300.00");
  assert.equal(enero.resumen.importeReintegrado, "0.00");
  const febrero = await informeComprasVentas({ ...filtros, desde: "2026-02-01", hasta: "2026-02-28" });
  assert.equal(febrero.resumen.compras, "0.00");
  assert.equal(febrero.resumen.importeVentaAtribuido, "0.00");
  assert.equal(febrero.resumen.importeReintegrado, "200.00");
  assert.equal(febrero.resumen.costoRevertido, "50.00");
  assert.equal(febrero.resumen.margenBruto, "-150.00");
  const acumulado = await informeComprasVentas({ ...filtros, desde: "2026-01-01", hasta: "2026-02-28" });
  const paginaDos = await informeComprasVentas({ ...filtros, desde: "2026-01-01", hasta: "2026-02-28", pagina: 2 });
  assert.equal(acumulado.resumen.margenBruto, "150.00");
  assert.deepEqual(paginaDos.resumen, acumulado.resumen);
  assert.equal(paginaDos.totalResultados, acumulado.totalResultados);
  assert.equal(acumulado.datos.length, 2);
  await db.vigenciaPrecio.createMany({ data: [
    { productoId: e.producto.id, clase: "regular", importe: "200.00",
      inicio: new Date("2026-01-01T03:00:00Z"), fin: new Date("2026-02-01T03:00:00Z"), origen: "prueba" },
    { productoId: e.producto.id, clase: "regular", importe: "220.00",
      inicio: new Date("2026-02-01T03:00:00Z"), origen: "prueba" },
  ] });
  const historia = await historialProducto(e.producto.id,
    { desde: "2026-01-01", hasta: "2026-02-28", pagina: 1, limite: 2 });
  assert.deepEqual(historia.precios.map((p) => p.importe), ["200", "220"]);
  assert.equal(historia.promocionEnPeriodo, false);
});

test("informe con costo conocido parcial identifica la unidad desconocida y no inventa margen", {
  skip: process.env.PANDO_TEST_SPECIAL !== "1",
}, async () => {
  const e = await crearEscenario({ stock: 1, precio: "200.00" });
  const db = e.prisma;
  const actor = e.usuarios[0].id;
  const corte = await db.estadoCorteInventario.findUnique({ where: { id: 1 } });
  assert.equal(corte.estado, "activo");
  const estado = await db.estadoCorteVariante.create({ data: {
    varianteId: e.variante.id, corteId: corte.id, estado: "conciliado",
    origen: "inicial", saldoCapturado: 1, comprometido: 0, diferencia: 0,
    conciliadoEn: new Date(), conciliadoPorId: actor,
  } });
  const partida = await db.partidaInventario.create({ data: {
    varianteId: e.variante.id, origen: "existencia_inicial",
    cantidadOriginal: 1, costoUnitario: null, confirmadaEn: new Date(),
  } });
  const movimiento = await db.movimientoInventario.create({ data: {
    varianteId: e.variante.id, partidaId: partida.id, tipo: "existencia_inicial",
    cantidad: 1, motivo: "Costo histórico desconocido", actorUsuarioId: actor,
  } });
  await db.existenciaInicial.create({ data: {
    varianteId: e.variante.id, estadoVarianteId: estado.id,
    partidaId: partida.id, movimientoId: movimiento.id, saldoFisico: 1,
    costoUnitario: null, capturadoEn: new Date(), actorUsuarioId: actor,
  } });
  await ajustarInventario({ varianteId: e.variante.id, tipo: "positivo",
    cantidad: 1, costoUnitario: "50.00", motivo: "Costo conocido de prueba",
    actorUsuarioId: actor });
  await e.carrito(e.usuarios[0], [2]);
  const resumen = await resumenCheckout(actor, { tipoEntrega: "retiro" });
  const { orden } = await confirmarCheckout(actor, { tipoEntrega: "retiro",
    huellaResumen: resumen.huellaResumen, claveConfirmacion: randomUUID(),
    aceptaPrecioVigente: true });
  assert.equal((await confirmarPagoAdmin(orden.id, actor)).status, 200);
  const informe = await informeComprasVentas({ desde: "2026-10-01", hasta: "2026-10-31",
    productoId: e.producto.id, varianteId: e.variante.id, pagina: 1, limite: 20 });
  assert.equal(informe.resumen.importeVentaAtribuido, "400.00");
  assert.equal(informe.resumen.costoVendidoConocido, "50.00");
  assert.equal(informe.resumen.unidadesCostoDesconocido, 1);
  assert.equal(informe.resumen.margenBruto, null);
  assert.match(informe.resumen.advertenciaCobertura, /costo histórico conocido/);
});
