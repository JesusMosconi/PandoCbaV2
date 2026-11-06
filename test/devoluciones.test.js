import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { crearEscenario } from "./soporte/escenario.js";
import { crearProveedor } from "../src/services/proveedores.js";
import { anularIngreso, confirmarIngreso, corregirIngreso, crearBorradorIngreso } from "../src/services/compras.js";
import { confirmarCheckout, resumenCheckout } from "../src/services/checkout.js";
import { cambiarEstadoAdmin, confirmarPagoAdmin, obtenerOrdenAdmin } from "../src/services/ordenes.js";
import { iniciarPago, conciliarIntento } from "../src/services/pagos.js";
import { revisarDomicilio, decidirReintegroEnvio, iniciarReintegroSimulado, completarReintegroSimulado } from "../src/services/administracion-pagos.js";
import {
  aceptarDevolucionCliente, devolverAProveedor, recibirDevolucionCliente, registrarReintegro,
} from "../src/services/devoluciones.js";
import { informeComprasVentas } from "../src/services/informes.js";

test("venta, devolución parcial, reintegros y corrección conservan origen e historia", {
  skip: process.env.PANDO_TEST_SPECIAL !== "1",
}, async () => {
  const escenario = await crearEscenario({ stock: 0, precio: "200.00" });
  const db = escenario.prisma;
  const actor = escenario.usuarios[0].id;
  const corte = await db.estadoCorteInventario.findUnique({ where: { id: 1 } });
  assert.equal(corte.estado, "activo");
  await db.talleProducto.update({ where: { id: escenario.variante.id },
    data: { inicioInventarioCero: true } });
  await db.estadoCorteVariante.create({ data: {
    varianteId: escenario.variante.id, corteId: corte.id, estado: "conciliado",
    origen: "nueva", saldoCapturado: 0, comprometido: 0, diferencia: 0,
    conciliadoEn: new Date(), conciliadoPorId: actor,
  } });
  const proveedor = await crearProveedor({ nombre: `Proveedor ${randomUUID()}` }, actor);
  const ingreso = await crearBorradorIngreso({ proveedorId: proveedor.id,
    fechaCompra: "2026-10-18", fechaRecepcion: "2026-10-19",
    lineas: [{ varianteId: escenario.variante.id, cantidad: 3, costoUnitario: "50.00" }] });
  await confirmarIngreso(ingreso.id, { claveOperacion: randomUUID(),
    resumenAceptado: ingreso.huellaResumen }, actor);
  const partida = await db.partidaInventario.findFirst({ where: { ingresoId: ingreso.id } });
  await escenario.carrito(escenario.usuarios[0], [2]);
  const resumen = await resumenCheckout(actor, { tipoEntrega: "retiro" });
  const { orden } = await confirmarCheckout(actor, { tipoEntrega: "retiro",
    huellaResumen: resumen.huellaResumen, claveConfirmacion: randomUUID(),
    aceptaPrecioVigente: true });
  assert.equal((await confirmarPagoAdmin(orden.id, actor)).status, 200);
  for (const estado of ["en_preparacion", "lista_para_retiro", "entregada"]) {
    assert.equal((await cambiarEstadoAdmin(orden.id, actor, estado)).status, 200);
  }
  const detalle = await db.detalleOrden.findFirst({ where: { ordenId: orden.id } });
  const clave = randomUUID();
  const solicitud = { lineas: [{ detalleOrdenId: detalle.id, cantidad: 1 }],
    motivo: "Devolución parcial de prueba", claveOperacion: clave };
  await assert.rejects(aceptarDevolucionCliente(orden.id,
    { ...solicitud, importeAReintegrar: "0.01" }, actor),
  (error) => error.codigo === "ENTRADA_INVALIDA");
  const aceptada = await aceptarDevolucionCliente(orden.id, solicitud, actor);
  assert.equal(aceptada.devoluciones[0].importeDebido.toFixed(2), "200.00");
  assert.equal(aceptada.devoluciones[0].costoRevertido.toFixed(2), "50.00");
  assert.equal((await aceptarDevolucionCliente(orden.id, solicitud, actor)).reiterada, true);
  assert.equal((await db.talleProducto.findUnique({ where: { id: escenario.variante.id } })).stock, 1);
  const devolucionId = aceptada.devoluciones[0].id;
  const pago = { importeEfectivo: "100.00", claveOperacion: randomUUID() };
  assert.equal((await registrarReintegro(orden.id, devolucionId, pago, actor)).saldoPendiente, "100.00");
  assert.equal((await registrarReintegro(orden.id, devolucionId, pago, actor)).reiterada, true);
  await assert.rejects(registrarReintegro(orden.id, devolucionId,
    { importeEfectivo: "100.01", claveOperacion: randomUUID() }, actor),
  (error) => error.codigo === "REINTEGRO_EXCEDIDO");
  assert.equal((await registrarReintegro(orden.id, devolucionId,
    { importeEfectivo: "100.00", claveOperacion: randomUUID() }, actor)).saldoPendiente, "0.00");
  const recepcion = { cantidadApta: 1, cantidadDanada: 0, claveOperacion: randomUUID() };
  assert.equal((await recibirDevolucionCliente(orden.id, devolucionId, recepcion, actor)).reiterada, false);
  assert.equal((await recibirDevolucionCliente(orden.id, devolucionId, recepcion, actor)).reiterada, true);
  assert.equal((await db.talleProducto.findUnique({ where: { id: escenario.variante.id } })).stock, 2);
  await assert.rejects(recibirDevolucionCliente(orden.id, devolucionId,
    { cantidadApta: 1, cantidadDanada: 0, claveOperacion: randomUUID() }, actor),
  (error) => error.codigo === "RECEPCION_EXCEDIDA");

  const correccion = await corregirIngreso(ingreso.id, { partidaId: partida.id,
    campo: "costoUnitario", valorNuevo: "60.00", motivo: "Costo corregido",
    claveOperacion: randomUUID() }, actor);
  assert.equal(correccion.campo, "costoUnitario");
  const costo = (await obtenerOrdenAdmin(orden.id)).costoMercaderia;
  assert.equal(costo.costoConocido, "60.00");
  const proveedorDevuelto = await devolverAProveedor(ingreso.id, { partidaId: partida.id,
    cantidad: 1, motivo: "Retiro de lote", claveOperacion: randomUUID() }, actor);
  assert.equal(proveedorDevuelto.cantidad, 1);
  await assert.rejects(anularIngreso(ingreso.id, {
    motivo: "Anulación incompatible con venta y devolución",
    claveOperacion: randomUUID(),
  }, actor), (error) => error.codigo === "INGRESO_COMPROMETIDO");
  assert.equal((await db.ingreso.findUnique({ where: { id: ingreso.id } })).estado, "confirmado");
  const informe = await informeComprasVentas({ desde: "2026-10-01", hasta: "2026-10-31",
    proveedorId: proveedor.id, pagina: 1, limite: 2 });
  assert.equal(informe.totalResultados > informe.datos.length, true);
  assert.equal(informe.resumen.importeReintegrado, "200.00");
  assert.equal(informe.resumen.costoRevertido, "50.00");
});

test("recepciones parciales aptas y dañadas no duplican stock ni exceden la devolución", {
  skip: process.env.PANDO_TEST_SPECIAL !== "1",
}, async () => {
  const e = await crearEscenario({ stock: 0, precio: "200.00" });
  const db = e.prisma;
  const actor = e.usuarios[0].id;
  const corte = await db.estadoCorteInventario.findUnique({ where: { id: 1 } });
  assert.equal(corte.estado, "activo");
  await db.talleProducto.update({ where: { id: e.variante.id }, data: { inicioInventarioCero: true } });
  await db.estadoCorteVariante.create({ data: {
    varianteId: e.variante.id, corteId: corte.id, estado: "conciliado",
    origen: "nueva", saldoCapturado: 0, comprometido: 0, diferencia: 0,
    conciliadoEn: new Date(), conciliadoPorId: actor,
  } });
  const proveedor = await crearProveedor({ nombre: `Proveedor ${randomUUID()}` }, actor);
  const ingreso = await crearBorradorIngreso({ proveedorId: proveedor.id,
    fechaCompra: "2026-10-18", fechaRecepcion: "2026-10-19",
    lineas: [{ varianteId: e.variante.id, cantidad: 2, costoUnitario: "50.00" }] });
  await confirmarIngreso(ingreso.id, { claveOperacion: randomUUID(),
    resumenAceptado: ingreso.huellaResumen }, actor);
  await e.carrito(e.usuarios[0], [2]);
  const resumen = await resumenCheckout(actor, { tipoEntrega: "retiro" });
  const { orden } = await confirmarCheckout(actor, { tipoEntrega: "retiro",
    huellaResumen: resumen.huellaResumen, claveConfirmacion: randomUUID(),
    aceptaPrecioVigente: true });
  await db.orden.update({ where: { id: orden.id },
    data: { subtotal: "333.33", total: "333.33" } });
  assert.equal((await confirmarPagoAdmin(orden.id, actor)).status, 200);
  for (const estado of ["en_preparacion", "lista_para_retiro", "entregada"]) {
    assert.equal((await cambiarEstadoAdmin(orden.id, actor, estado)).status, 200);
  }
  assert.equal((await db.talleProducto.findUnique({ where: { id: e.variante.id } })).stock, 0);
  const detalle = await db.detalleOrden.findFirst({ where: { ordenId: orden.id } });
  const aceptada = await aceptarDevolucionCliente(orden.id, {
    lineas: [{ detalleOrdenId: detalle.id, cantidad: 2 }],
    motivo: "Clasificación mixta", claveOperacion: randomUUID(),
  }, actor);
  assert.equal(aceptada.devoluciones[0].importeDebido.toFixed(2), "333.33");
  const devolucionId = aceptada.devoluciones[0].id;
  const apta = { cantidadApta: 1, cantidadDanada: 0, claveOperacion: randomUUID() };
  const danada = { cantidadApta: 0, cantidadDanada: 1, claveOperacion: randomUUID() };
  assert.equal((await recibirDevolucionCliente(orden.id, devolucionId, apta, actor)).reiterada, false);
  assert.equal((await recibirDevolucionCliente(orden.id, devolucionId, danada, actor)).reiterada, false);
  assert.equal((await recibirDevolucionCliente(orden.id, devolucionId, danada, actor)).reiterada, true);
  assert.equal((await db.talleProducto.findUnique({ where: { id: e.variante.id } })).stock, 1);
  await assert.rejects(recibirDevolucionCliente(orden.id, devolucionId,
    { cantidadApta: 1, cantidadDanada: 0, claveOperacion: randomUUID() }, actor),
  (error) => error.codigo === "RECEPCION_EXCEDIDA");
  const pagos = ["150.00", "183.33"];
  for (const importeEfectivo of pagos) {
    await registrarReintegro(orden.id, devolucionId,
      { importeEfectivo, claveOperacion: randomUUID() }, actor);
  }
  await assert.rejects(registrarReintegro(orden.id, devolucionId,
    { importeEfectivo: "0.01", claveOperacion: randomUUID() }, actor),
  (error) => error.codigo === "REINTEGRO_EXCEDIDO");
  assert.equal(await db.recepcionDevolucion.count({ where: { devolucionId } }), 2);
});

test("orden online simulada: devolución parcial tras salida y envío se reintegran una vez", {
  skip: process.env.PANDO_TEST_SPECIAL !== "1",
}, async () => {
  const e = await crearEscenario({ stock: 0, precio: "20000.01" });
  const db = e.prisma;
  const actor = e.usuarios[0].id;
  const entorno = { ...process.env };
  const transporte = globalThis.fetch;
  try {
    await db.talleProducto.update({ where: { id: e.variante.id }, data: { inicioInventarioCero: true } });
    await db.estadoCorteVariante.create({ data: {
      varianteId: e.variante.id, corteId: 1, estado: "conciliado", origen: "nueva",
      saldoCapturado: 0, comprometido: 0, diferencia: 0,
      conciliadoEn: new Date(), conciliadoPorId: actor,
    } });
    const proveedor = await crearProveedor({ nombre: `Proveedor ${randomUUID()}` }, actor);
    const ingreso = await crearBorradorIngreso({ proveedorId: proveedor.id,
      fechaCompra: "2026-10-18", fechaRecepcion: "2026-10-19",
      lineas: [{ varianteId: e.variante.id, cantidad: 2, costoUnitario: "5000.00" }] });
    await confirmarIngreso(ingreso.id, { claveOperacion: randomUUID(),
      resumenAceptado: ingreso.huellaResumen }, actor);
    Object.assign(process.env, { PAGOS_ONLINE_HABILITADOS: "true", PAGOS_ENTORNO: "prueba",
      MP_USUARIO_PRUEBA_ID: "123", MP_APLICACION_PRUEBA_ID: "456", MP_ACCESS_TOKEN_PRUEBA: "ficticia",
      MP_URL_RETORNO: "https://tesis.example.invalid/cuenta", RESEND_API_KEY: "re_ficticia" });
    let remota;
    const llamadasNoPago = [];
    globalThis.fetch = async (url, opciones) => {
      if (new URL(url).hostname !== "api.mercadopago.com") {
        llamadasNoPago.push(url);
        return Response.json({ id: "externa-ficticia" });
      }
      if (url.endsWith("/users/me")) return Response.json({ id: 123, tags: ["test_user"] });
      if (opciones.method === "POST") {
        const cuerpo = JSON.parse(opciones.body);
        remota = { id: `ORDTST${randomUUID().replaceAll("-", "")}`, user_id: "123", currency: "ARS",
          country_code: "ARG", integration_data: { application_id: "456" },
          external_reference: cuerpo.external_reference, total_amount: cuerpo.total_amount,
          total_paid_amount: "0.00", status: "created", status_detail: "created",
          created_date: new Date().toISOString(),
          checkout_url: "https://www.mercadopago.com.ar/checkout/v1/redirect" };
        return Response.json(remota);
      }
      return Response.json(remota);
    };
    await e.carrito(e.usuarios[0], [2]);
    const entrega = { tipoEntrega: "envio", datosEnvio: { ciudad: "Córdoba Capital",
      direccion: "Calle ficticia 123", codPostal: "X5000ABC", telefono: "3511234567",
      email: "tesis@example.invalid" } };
    const resumen = await resumenCheckout(actor, entrega);
    const { orden } = await confirmarCheckout(actor, { ...entrega, huellaResumen: resumen.huellaResumen,
      claveConfirmacion: randomUUID(), aceptaPrecioVigente: true });
    assert.equal(orden.total.toFixed(2), "55000.02");
    const inicio = await iniciarPago(actor, orden.id);
    remota.status = "processed"; remota.status_detail = "accredited";
    remota.total_paid_amount = "55000.02";
    await conciliarIntento(inicio.intentoId);
    const asignacionesPagadas = await db.asignacionPartida.findMany({
      where: { detalleOrden: { ordenId: orden.id } }, select: { id: true, estado: true, importeEfectivo: true },
    });
    assert.equal(asignacionesPagadas.length, 1);
    assert.equal(asignacionesPagadas[0].estado, "vendida");
    assert.equal(asignacionesPagadas[0].importeEfectivo.toFixed(2), "40000.02");
    await conciliarIntento(inicio.intentoId);
    assert.equal(await db.asignacionPartida.count({ where: { detalleOrden: { ordenId: orden.id }, estado: "vendida" } }), 1);
    assert.equal(await db.eventoOrden.count({ where: { ordenId: orden.id, origen: "proveedor" } }), 1);
    assert.equal((await cambiarEstadoAdmin(orden.id, actor, "en_preparacion")).status, 200);
    assert.equal((await cambiarEstadoAdmin(orden.id, actor, "enviada")).status, 409);
    await revisarDomicilio(orden.id, actor);
    const salidaSimulada = await cambiarEstadoAdmin(orden.id, actor, "enviada", true);
    assert.equal(salidaSimulada.status, 200);
    assert.equal(salidaSimulada.orden.esDemostracion, true);
    assert.equal(salidaSimulada.orden.envioCoordinado, false);
    assert.equal(salidaSimulada.orden.envioCoordinadoEn, null);
    const detalle = await db.detalleOrden.findFirstOrThrow({ where: { ordenId: orden.id } });
    const aceptada = await aceptarDevolucionCliente(orden.id, {
      lineas: [{ detalleOrdenId: detalle.id, cantidad: 1 }],
      motivo: "Devolución parcial de tesis", claveOperacion: randomUUID(),
    }, actor);
    const devolucion = aceptada.devoluciones[0];
    assert.equal(devolucion.importeDebido.toFixed(2), "20000.01");
    await assert.rejects(decidirReintegroEnvio(orden.id, actor, "x"), (error) => error.codigo === "MOTIVO_INVALIDO");
    await decidirReintegroEnvio(orden.id, actor, "Envío simulado reintegrado tras salida");
    await decidirReintegroEnvio(orden.id, actor, "Envío simulado reintegrado tras salida");
    let admin = await obtenerOrdenAdmin(orden.id);
    assert.equal(admin.saldoMonetarioPendiente, "35000.01");
    assert.equal(admin.reintegrosPago.length, 1);
    const pago = { importeEfectivo: "20000.01", claveOperacion: randomUUID(),
      referenciaExterna: `SIM-producto-${randomUUID()}`, constanciaExaminada: true };
    await registrarReintegro(orden.id, devolucion.id, pago, actor);
    await registrarReintegro(orden.id, devolucion.id, pago, actor);
    await iniciarReintegroSimulado(orden.id, admin.reintegrosPago[0].id, actor);
    const constanciaEnvio = (await db.reintegroPago.findUniqueOrThrow({
      where: { id: admin.reintegrosPago[0].id } })).referenciaExterna;
    await completarReintegroSimulado(orden.id, admin.reintegrosPago[0].id, actor, constanciaEnvio);
    await completarReintegroSimulado(orden.id, admin.reintegrosPago[0].id, actor, constanciaEnvio);
    admin = await obtenerOrdenAdmin(orden.id);
    assert.equal(admin.saldoMonetarioPendiente, "0.00");
    assert.equal(await db.pagoReintegro.count({ where: { devolucionId: devolucion.id } }), 1);
    assert.equal((await db.reintegroPago.findUnique({ where: { id: admin.reintegrosPago[0].id } })).importeReintegrado.toFixed(2), "15000.00");
    assert.deepEqual(llamadasNoPago, []);
  } finally {
    globalThis.fetch = transporte;
    for (const clave of Object.keys(process.env)) if (!(clave in entorno)) delete process.env[clave];
    Object.assign(process.env, entorno);
  }
});

test("dos devoluciones unitarias reparten exactamente un subtotal descontado de 333.33", {
  skip: process.env.PANDO_TEST_SPECIAL !== "1",
}, async () => {
  const e = await crearEscenario({ stock: 0, precio: "200.00" });
  const db = e.prisma;
  const actor = e.usuarios[0].id;
  const corte = await db.estadoCorteInventario.findUnique({ where: { id: 1 } });
  await db.talleProducto.update({ where: { id: e.variante.id }, data: { inicioInventarioCero: true } });
  await db.estadoCorteVariante.create({ data: {
    varianteId: e.variante.id, corteId: corte.id, estado: "conciliado",
    origen: "nueva", saldoCapturado: 0, comprometido: 0, diferencia: 0,
    conciliadoEn: new Date(), conciliadoPorId: actor,
  } });
  const proveedor = await crearProveedor({ nombre: `Proveedor ${randomUUID()}` }, actor);
  const ingreso = await crearBorradorIngreso({ proveedorId: proveedor.id,
    fechaCompra: "2026-10-18", fechaRecepcion: "2026-10-19",
    lineas: [{ varianteId: e.variante.id, cantidad: 2, costoUnitario: "50.00" }] });
  await confirmarIngreso(ingreso.id, { claveOperacion: randomUUID(),
    resumenAceptado: ingreso.huellaResumen }, actor);
  await e.carrito(e.usuarios[0], [2]);
  const resumen = await resumenCheckout(actor, { tipoEntrega: "retiro" });
  const { orden } = await confirmarCheckout(actor, { tipoEntrega: "retiro",
    huellaResumen: resumen.huellaResumen, claveConfirmacion: randomUUID(),
    aceptaPrecioVigente: true });
  await db.orden.update({ where: { id: orden.id },
    data: { subtotal: "333.33", total: "333.33" } });
  assert.equal((await confirmarPagoAdmin(orden.id, actor)).status, 200);
  for (const estado of ["en_preparacion", "lista_para_retiro", "entregada"]) {
    assert.equal((await cambiarEstadoAdmin(orden.id, actor, estado)).status, 200);
  }
  const detalle = await db.detalleOrden.findFirst({ where: { ordenId: orden.id } });
  const importes = [];
  for (let i = 0; i < 2; i += 1) {
    const aceptada = await aceptarDevolucionCliente(orden.id, {
      lineas: [{ detalleOrdenId: detalle.id, cantidad: 1 }],
      motivo: `Unidad ${i + 1}`, claveOperacion: randomUUID(),
    }, actor);
    importes.push(aceptada.devoluciones[0].importeDebido.toFixed(2));
  }
  assert.deepEqual(importes, ["166.67", "166.66"]);
  await assert.rejects(aceptarDevolucionCliente(orden.id, {
    lineas: [{ detalleOrdenId: detalle.id, cantidad: 1 }],
    motivo: "Exceso", claveOperacion: randomUUID(),
  }, actor), (error) => error.codigo === "UNIDADES_YA_DEVUELTAS");
});
