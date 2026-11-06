import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import prisma from "../src/db.js";
import { cerrarCaja } from "../src/services/caja.js";
import { confirmarCheckout, resumenCheckout } from "../src/services/checkout.js";
import {
  ErrorVentaLocal, actualizarItem, agregarItem, agregarVentaRapida, confirmarVentaLocal, listarVentasLocal, normalizarCliente,
  normalizarVentaRapida, obtenerVentaEnCurso, obtenerVentaLocal, quitarItem, resumenVentaLocal,
} from "../src/services/venta-local.js";
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

async function confirmarCon(operadorId, resumen, extra = {}) {
  return confirmarVentaLocal(operadorId, {
    claveConfirmacion: randomUUID(), huellaResumen: resumen.huellaResumen,
    metodoPago: "efectivo", ...extra,
  });
}

async function ordenWeb(escenario, cliente, cantidad = 1) {
  await escenario.carrito(cliente, [cantidad]);
  const resumen = await resumenCheckout(cliente.id, { tipoEntrega: "retiro" });
  return (await confirmarCheckout(cliente.id, {
    tipoEntrega: "retiro", huellaResumen: resumen.huellaResumen,
    claveConfirmacion: randomUUID(), aceptaPrecioVigente: true,
  })).orden;
}

const diaBuenosAires = (fecha) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Argentina/Buenos_Aires",
}).format(fecha);

test("nombre y teléfono del cliente son opcionales y se normalizan", () => {
  assert.deepEqual(normalizarCliente({}), { nombreCliente: null, telefonoCliente: null });
  assert.deepEqual(normalizarCliente({ nombreCliente: "  Ana   Pérez ", telefonoCliente: "+54 (351) 555-1234" }),
    { nombreCliente: "Ana Pérez", telefonoCliente: "+543515551234" });
  assert.deepEqual(normalizarCliente({ nombreCliente: "   ", telefonoCliente: "" }),
    { nombreCliente: null, telefonoCliente: null });
  for (const entrada of [{ telefonoCliente: "12" }, { telefonoCliente: "351-abc" }, { nombreCliente: "a".repeat(101) },
    { nombreCliente: 5 }]) {
    assert.throws(() => normalizarCliente(entrada),
      (error) => error instanceof ErrorVentaLocal && error.status === 400 && error.codigo === "CLIENTE_INVALIDO");
  }
});

test("la venta rápida exige importe positivo con hasta dos decimales y usa un concepto por defecto", () => {
  const linea = normalizarVentaRapida({ importe: "3000" });
  assert.equal(linea.concepto, "Venta rápida");
  assert.equal(linea.importe.toFixed(2), "3000.00");
  assert.equal(linea.cantidad, 1);
  assert.equal(normalizarVentaRapida({ concepto: "  Pulsera  ", importe: "2500,50", cantidad: 2 }).concepto, "Pulsera");
  assert.equal(normalizarVentaRapida({ importe: 0.5 }).importe.toFixed(2), "0.50");
  for (const entrada of [{ importe: "0" }, { importe: "-10" }, { importe: "1.234" }, { importe: "abc" }, {},
    { importe: "10", concepto: "x".repeat(81) }, { importe: "10", cantidad: 0 }, { importe: "0.00" }]) {
    assert.throws(() => normalizarVentaRapida(entrada),
      (error) => error instanceof ErrorVentaLocal && error.codigo === "VENTA_RAPIDA_INVALIDA");
  }
});

test("la venta queda entregada, consume la reserva y vende sus partidas FIFO una sola vez", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    const caja = await escenario.abrir("1000");
    const [{ maximo }] = await prisma.$queryRaw`
      SELECT COALESCE(MAX("numeroComprobante"), 0)::int AS maximo FROM "Orden"`;
    const { venta, creada } = await escenario.vender([{ talleProductoId: escenario.variante.id, cantidad: 2 }],
      { nombreCliente: "Ana", telefonoCliente: "351 555-1234", metodoPago: "efectivo" });
    assert.equal(creada, true);
    assert.equal(venta.canal, "local");
    assert.equal(venta.estado, "entregada");
    assert.equal(venta.cajaId, caja.id);
    assert.equal(venta.nombreCliente, "Ana");
    assert.equal(venta.telefonoCliente, "3515551234");
    assert.equal("dniCliente" in venta, false);
    assert.equal(venta.total, "200.00");
    assert.equal(venta.numeroComprobante, Number(maximo) + 1);
    assert.deepEqual(venta.lineas.map(({ cantidad, importeLinea }) => [cantidad, importeLinea]), [[2, "200.00"]]);
    assert.equal("usuarioId" in venta, false);

    const orden = await prisma.orden.findUnique({ where: { id: venta.id }, include: {
      reservas: true, eventos: { orderBy: { id: "asc" } }, carrito: true,
      detalles: { include: { asignacionesPartida: true } },
    } });
    assert.equal(orden.tipoEntrega, "local");
    assert.equal(orden.pagoConfirmadoEn.getTime(), orden.creadaEn.getTime());
    assert.equal(orden.carrito.canal, "local");
    assert.equal(orden.carrito.estado, "convertido");
    assert.deepEqual(orden.reservas.map(({ estado, cantidad }) => [estado, cantidad]), [["consumida", 2]]);
    const asignaciones = orden.detalles.flatMap(({ asignacionesPartida }) => asignacionesPartida);
    assert.equal(asignaciones.reduce((suma, { cantidad }) => suma + cantidad, 0), 2);
    assert.equal(asignaciones.every(({ estado, importeEfectivo }) => estado === "vendida" && importeEfectivo !== null), true);
    assert.deepEqual(orden.eventos.map(({ origen, estadoAnterior, estadoNuevo }) => [origen, estadoAnterior, estadoNuevo]), [
      ["local", null, "pendiente_pago"], ["local", "pendiente_pago", "pago_confirmado"],
      ["local", "pago_confirmado", "entregada"],
    ]);
    assert.equal((await prisma.talleProducto.findUnique({ where: { id: escenario.variante.id } })).stock, 2);
    const salidas = await prisma.movimientoInventario.findMany({
      where: { varianteId: escenario.variante.id, tipo: "salida_venta" },
    });
    assert.equal(salidas.reduce((suma, { cantidad }) => suma + cantidad, 0), -2);
  }, { stock: 4, fifo: true });
});

test("se vende un producto solo local; solo web y drop no lanzado se rechazan", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    const drop = await prisma.coleccion.create({ data: { nombre: `Drop local ${randomUUID().slice(0, 8)}` } });
    try {
      const soloLocal = await escenario.crearProducto({ web: false, local: true });
      const soloWeb = await escenario.crearProducto({ web: true, local: false });
      const sinLanzar = await escenario.crearProducto({ coleccionId: drop.id });
      await escenario.abrir();
      for (const { variante } of [soloWeb, sinLanzar]) {
        await assert.rejects(agregarItem(escenario.operador.id, { talleProductoId: variante.id, cantidad: 1 }),
          (error) => error instanceof ErrorVentaLocal && error.status === 409 && error.codigo === "producto_no_local");
      }
      const { venta } = await escenario.vender([{ talleProductoId: soloLocal.variante.id, cantidad: 1 }]);
      assert.equal(venta.estado, "entregada");

      // Si el producto pasa a un drop no lanzado con la venta armada, el resumen lo bloquea.
      await agregarItem(escenario.operador.id, { talleProductoId: soloLocal.variante.id, cantidad: 1 });
      await prisma.producto.update({ where: { id: soloLocal.producto.id }, data: { coleccionId: drop.id } });
      const resumen = await resumenVentaLocal(prisma, escenario.operador.id);
      assert.equal(resumen.puedeConfirmar, false);
      assert.deepEqual(resumen.lineas[0].motivosBloqueo, ["drop_no_lanzado"]);
      await assert.rejects(confirmarCon(escenario.operador.id, resumen),
        (error) => error.codigo === "ITEMS_NO_DISPONIBLES" && error.itemsAfectados[0].motivo === "drop_no_lanzado");
      await prisma.producto.update({ where: { id: soloLocal.producto.id }, data: { coleccionId: null } });
    } finally {
      await prisma.producto.updateMany({ where: { coleccionId: drop.id }, data: { coleccionId: null } });
      await prisma.coleccion.delete({ where: { id: drop.id } });
    }
  });
});

test("una reserva web vigente limita lo que se puede vender en el local", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    await ordenWeb(escenario, escenario.clientes[0], 1);
    await assert.rejects(agregarItem(escenario.operador.id, { talleProductoId: escenario.variante.id, cantidad: 2 }),
      (error) => error.codigo === "stock_insuficiente" && error.disponible === 1);
    const resumen = await agregarItem(escenario.operador.id, { talleProductoId: escenario.variante.id, cantidad: 1 });
    assert.equal(resumen.lineas[0].stockDisponible, 1);
  }, { stock: 2 });
});

test("web y local compiten por la última unidad y solo una venta se concreta (SC-002)", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    const cliente = escenario.clientes[0];
    await escenario.abrir();
    await escenario.carrito(cliente, [1]);
    const resumenLocal = await agregarItem(escenario.operador.id, { talleProductoId: escenario.variante.id, cantidad: 1 });
    const resumenWeb = await resumenCheckout(cliente.id, { tipoEntrega: "retiro" });
    const resultados = await Promise.allSettled([
      confirmarCheckout(cliente.id, { tipoEntrega: "retiro", huellaResumen: resumenWeb.huellaResumen,
        claveConfirmacion: randomUUID(), aceptaPrecioVigente: true }),
      confirmarCon(escenario.operador.id, resumenLocal),
    ]);
    assert.equal(resultados.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(resultados.find(({ status }) => status === "rejected").reason.codigo, "ITEMS_NO_DISPONIBLES");
    const reservas = await prisma.reservaStock.findMany({
      where: { talleProductoId: escenario.variante.id, estado: { in: ["activa", "consumida"] } },
    });
    assert.equal(reservas.reduce((suma, { cantidad }) => suma + cantidad, 0), 1);
  }, { stock: 1 });
});

test("la misma clave confirmada dos veces produce una sola venta (SC-003)", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    await escenario.abrir();
    const resumen = await agregarItem(escenario.operador.id, { talleProductoId: escenario.variante.id, cantidad: 1 });
    const entrada = { claveConfirmacion: randomUUID(), huellaResumen: resumen.huellaResumen,
      telefonoCliente: "3515551234", metodoPago: "debito" };
    const [primera, segunda] = await Promise.all([
      confirmarVentaLocal(escenario.operador.id, entrada), confirmarVentaLocal(escenario.operador.id, entrada),
    ]);
    assert.equal(primera.venta.id, segunda.venta.id);
    assert.equal(primera.venta.numeroComprobante, segunda.venta.numeroComprobante);
    assert.deepEqual([primera.creada, segunda.creada].sort(), [false, true]);
    const tercera = await confirmarVentaLocal(escenario.operador.id, entrada);
    assert.equal(tercera.creada, false);
    for (const distinta of [{ metodoPago: "credito" }, { telefonoCliente: "3515550000" }]) {
      await assert.rejects(confirmarVentaLocal(escenario.operador.id, { ...entrada, ...distinta }),
        (error) => error.status === 409 && error.codigo === "INTENCION_EN_CONFLICTO");
    }
    assert.equal(await prisma.orden.count({ where: { usuarioId: escenario.operador.id, canal: "local" } }), 1);
    assert.equal((await prisma.talleProducto.findUnique({ where: { id: escenario.variante.id } })).stock, 3);
  });
});

test("un cambio de precio después del resumen exige reconfirmar con el total nuevo", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    await escenario.abrir();
    const viejo = await agregarItem(escenario.operador.id, { talleProductoId: escenario.variante.id, cantidad: 2 });
    await prisma.producto.update({ where: { id: escenario.producto.id }, data: { precio: "130.00" } });
    let nuevo = null;
    await assert.rejects(confirmarCon(escenario.operador.id, viejo), (error) => {
      nuevo = error.resumen;
      return error.status === 409 && error.codigo === "RESUMEN_CAMBIO";
    });
    assert.equal(nuevo.total, "260.00");
    assert.equal(nuevo.lineas[0].cambioPrecio, true);
    const { venta } = await confirmarCon(escenario.operador.id, nuevo);
    assert.equal(venta.total, "260.00");
    assert.equal(venta.lineas[0].precioUnitario, "130.00");
  });
});

test("teléfono o medio inválidos, venta vacía y caja cerrada no crean ventas", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    const operador = escenario.operador.id;
    const vacia = await obtenerVentaEnCurso(operador);
    await assert.rejects(confirmarCon(operador, vacia),
      (error) => error.status === 400 && error.codigo === "VENTA_VACIA");
    const resumen = await agregarItem(operador, { talleProductoId: escenario.variante.id, cantidad: 1 });
    assert.equal(resumen.puedeConfirmar, false);
    assert.equal(resumen.caja, null);
    await assert.rejects(confirmarCon(operador, resumen, { telefonoCliente: "12" }),
      (error) => error.status === 400 && error.codigo === "CLIENTE_INVALIDO" && error.campo === "telefonoCliente");
    await assert.rejects(confirmarCon(operador, resumen, { metodoPago: "cheque" }),
      (error) => error.status === 400 && error.codigo === "MEDIO_PAGO_INVALIDO");
    await assert.rejects(confirmarCon(operador, resumen, { huellaResumen: "x" }),
      (error) => error.status === 400 && error.codigo === "CONFIRMACION_INVALIDA");
    await assert.rejects(confirmarCon(operador, resumen),
      (error) => error.status === 409 && error.codigo === "CAJA_NO_ABIERTA");
    assert.equal(await prisma.orden.count({ where: { usuarioId: operador } }), 0);
  });
});

test("con el inventario suspendido la venta local se rechaza", {
  ...opciones, skip: process.env.PANDO_TEST_SPECIAL !== "1",
}, async (t) => {
  // La suspensión solo existe durante el corte: con el corte activo la base la rechaza.
  const corte = await prisma.estadoCorteInventario.findUnique({ where: { id: 1 }, select: { estado: true } });
  if (corte?.estado === "activo") {
    t.skip("Con el corte activo el inventario no puede suspenderse");
    return;
  }
  await conLocal(t, async (escenario) => {
    await escenario.abrir();
    const resumen = await agregarItem(escenario.operador.id, { talleProductoId: escenario.variante.id, cantidad: 1 });
    const previo = await prisma.estadoCorteInventario.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    try {
      await prisma.estadoCorteInventario.update({ where: { id: 1 }, data: { suspendido: true } });
      await assert.rejects(confirmarCon(escenario.operador.id, resumen),
        (error) => error instanceof ErrorVentaLocal && error.status === 409 && error.codigo === "INVENTARIO_SUSPENDIDO");
    } finally {
      await prisma.estadoCorteInventario.update({ where: { id: 1 }, data: { suspendido: previo.suspendido } });
    }
    assert.equal(await prisma.orden.count({ where: { usuarioId: escenario.operador.id } }), 0);
  });
});

test("una venta simultánea con el cierre queda dentro de la caja o se rechaza", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    const caja = await escenario.abrir("0");
    const resumen = await agregarItem(escenario.operador.id, { talleProductoId: escenario.variante.id, cantidad: 1 });
    const [venta, cierre] = await Promise.allSettled([
      confirmarCon(escenario.operador.id, resumen),
      cerrarCaja(escenario.operador.id, caja.id, { efectivoDeclarado: "0" }),
    ]);
    assert.equal(cierre.status, "fulfilled");
    const cerrada = cierre.value.caja;
    if (venta.status === "fulfilled") {
      assert.equal(venta.value.venta.cajaId, caja.id);
      assert.equal(cerrada.cantidadVentas, 1);
      assert.equal(cerrada.totalVentas, "100.00");
    } else {
      assert.equal(venta.reason.codigo, "CAJA_NO_ABIERTA");
      assert.equal(cerrada.cantidadVentas, 0);
      assert.equal(await prisma.orden.count({ where: { usuarioId: escenario.operador.id } }), 0);
    }
    assert.equal(await prisma.orden.count({ where: { cajaId: caja.id } }), cerrada.cantidadVentas);
  });
});

test("el comprobante sigue siendo correlativo después de una confirmación rechazada", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    await escenario.abrir();
    const primera = await escenario.vender();
    const viejo = await agregarItem(escenario.operador.id, { talleProductoId: escenario.variante.id, cantidad: 1 });
    await prisma.producto.update({ where: { id: escenario.producto.id }, data: { precio: "110.00" } });
    await assert.rejects(confirmarCon(escenario.operador.id, viejo), (error) => error.codigo === "RESUMEN_CAMBIO");
    const segunda = await confirmarCon(escenario.operador.id, await resumenVentaLocal(prisma, escenario.operador.id));
    assert.equal(segunda.venta.numeroComprobante, primera.venta.numeroComprobante + 1);
  });
});

test("el carrito web del admin no se mezcla con la venta en curso del local", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    const operador = escenario.operador;
    const otro = await escenario.crearProducto();
    await escenario.carrito(operador, [1]);
    await escenario.abrir();
    const enCurso = await agregarItem(operador.id, { talleProductoId: otro.variante.id, cantidad: 1 });
    assert.deepEqual(enCurso.lineas.map(({ talleProductoId }) => talleProductoId), [otro.variante.id]);
    const web = await resumenCheckout(operador.id, { tipoEntrega: "retiro" });
    assert.deepEqual(web.lineas.map(({ nombreProducto }) => nombreProducto), [escenario.producto.nombre]);

    await confirmarCon(operador.id, enCurso);
    const carritoWeb = await prisma.carrito.findFirst({
      where: { usuarioId: operador.id, canal: "web" }, include: { items: true },
    });
    assert.equal(carritoWeb.estado, "activo");
    assert.deepEqual(carritoWeb.items.map(({ talleProductoId }) => talleProductoId), [escenario.variante.id]);
    assert.deepEqual((await obtenerVentaEnCurso(operador.id)).lineas, []);
  });
});

test("el historial lista solo ventas locales y el detalle repite la confirmación", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    const web = await ordenWeb(escenario, escenario.clientes[0]);
    await escenario.abrir();
    const sufijo = randomUUID().replace(/\D/g, "").padEnd(12, "7").slice(0, 12);
    const telefono = `9${sufijo}`;
    const nombre = `Cliente ${randomUUID().slice(0, 8)}`;
    const { venta } = await escenario.vender(undefined,
      { nombreCliente: nombre, telefonoCliente: telefono, metodoPago: "transferencia" });

    const porTelefono = await listarVentasLocal({ buscar: telefono.slice(2) });
    assert.deepEqual(porTelefono.ventas.map(({ id }) => id), [venta.id]);
    const porNombre = await listarVentasLocal({ buscar: nombre.toUpperCase() });
    assert.deepEqual(porNombre.ventas.map(({ id }) => id), [venta.id]);
    const porNumero = await listarVentasLocal({ buscar: String(venta.numeroComprobante) });
    assert.equal(porNumero.ventas.some(({ id }) => id === venta.id), true);
    const todas = await listarVentasLocal({ limite: 50 });
    assert.equal(todas.ventas.every(({ canal }) => canal === "local"), true);
    assert.equal(todas.ventas.some(({ id }) => id === web.id), false);

    const hoy = diaBuenosAires(venta.fecha);
    assert.equal((await listarVentasLocal({ desde: hoy, hasta: hoy, buscar: telefono })).total, 1);
    const manana = diaBuenosAires(new Date(venta.fecha.getTime() + 24 * 60 * 60 * 1000));
    assert.equal((await listarVentasLocal({ desde: manana, buscar: telefono })).total, 0);

    assert.deepEqual(await obtenerVentaLocal(venta.id), venta);
    assert.equal(await obtenerVentaLocal(web.id), null);
  });
});

test("una venta mixta suma la venta rápida sin mover su stock y el comprobante la muestra al final", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    const operador = escenario.operador.id;
    const caja = await escenario.abrir("0");
    await agregarItem(operador, { talleProductoId: escenario.variante.id, cantidad: 1 });
    const conRapida = await agregarVentaRapida(operador, { concepto: "Pulsera", importe: "3000", cantidad: 2 });
    const rapida = conRapida.lineas.find(({ ventaRapida }) => ventaRapida);
    assert.deepEqual([rapida.nombreProducto, rapida.precioVigente, rapida.importeLinea, rapida.talle, rapida.disponible],
      ["Pulsera", "3000.00", "6000.00", null, true]);
    assert.equal(conRapida.total, "6100.00");
    assert.equal(conRapida.puedeConfirmar, true);

    const { venta } = await confirmarCon(operador, conRapida, { metodoPago: "debito" });
    assert.equal(venta.total, "6100.00");
    assert.deepEqual(venta.lineas.map(({ nombreProducto, ventaRapida, talle, importeLinea }) =>
      [nombreProducto, ventaRapida, talle, importeLinea]), [
      [escenario.producto.nombre, false, escenario.talle.valor, "100.00"], ["Pulsera", true, null, "6000.00"],
    ]);
    assert.deepEqual(await obtenerVentaLocal(venta.id), venta);
    const reservas = await prisma.reservaStock.findMany({ where: { ordenId: venta.id } });
    assert.deepEqual(reservas.map(({ talleProductoId, cantidad }) => [talleProductoId, cantidad]), [[escenario.variante.id, 1]]);
    assert.equal((await prisma.talleProducto.findUnique({ where: { id: escenario.variante.id } })).stock, 3);

    const { caja: cerrada } = await cerrarCaja(operador, caja.id, { efectivoDeclarado: "0" });
    assert.deepEqual(cerrada.totalesPorMedio, { debito: "6100.00" });
  });
});

test("una venta solo de líneas rápidas se confirma sin inventario y la línea se edita como las demás", opciones, async (t) => {
  await conLocal(t, async (escenario) => {
    const operador = escenario.operador.id;
    await escenario.abrir();
    await assert.rejects(agregarVentaRapida(operador, { importe: "0" }),
      (error) => error.status === 400 && error.codigo === "VENTA_RAPIDA_INVALIDA");
    const primera = await agregarVentaRapida(operador, { importe: 1500 });
    const linea = primera.lineas[0];
    assert.equal(linea.nombreProducto, "Venta rápida");
    assert.equal((await actualizarItem(operador, linea.itemCarritoId, 3)).total, "4500.00");
    await agregarVentaRapida(operador, { concepto: "Aros", importe: "2000.50" });
    const sinPrimera = await quitarItem(operador, linea.itemCarritoId);
    assert.deepEqual(sinPrimera.lineas.map(({ nombreProducto }) => nombreProducto), ["Aros"]);

    const { venta } = await confirmarCon(operador, sinPrimera, { metodoPago: "transferencia" });
    assert.equal(venta.total, "2000.50");
    assert.equal(venta.estado, "entregada");
    assert.equal(await prisma.reservaStock.count({ where: { ordenId: venta.id } }), 0);
    assert.equal(await prisma.eventoOrden.count({ where: { ordenId: venta.id } }), 3);
    const detalle = await prisma.detalleOrden.findFirst({ where: { ordenId: venta.id } });
    assert.deepEqual([detalle.productoId, detalle.talleProductoId, detalle.talle], [null, null, ""]);
  });
});
