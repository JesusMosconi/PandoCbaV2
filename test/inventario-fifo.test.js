import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { crearEscenario } from "./soporte/escenario.js";
import { crearProveedor } from "../src/services/proveedores.js";
import { confirmarIngreso, crearBorradorIngreso } from "../src/services/compras.js";
import { confirmarCheckout, resumenCheckout } from "../src/services/checkout.js";
import { cancelarOrdenCliente } from "../src/services/ordenes.js";
import { cambiarEstadoAdmin, confirmarPagoAdmin, obtenerOrdenAdmin } from "../src/services/ordenes.js";
import { informeComprasVentas } from "../src/services/informes.js";

async function conInventario(prueba, { clientes = 1, nuevo = true, stock = 0 } = {}) {
  const escenario = await crearEscenario({ clientes, stock, precio: "200.00" });
  if (nuevo) await escenario.prisma.talleProducto.update({
    where: { id: escenario.variante.id }, data: { inicioInventarioCero: true },
  });
  const proveedorIds = [];
  const contexto = {
    ...escenario,
    async recibir(cantidad, costoUnitario, fechaRecepcion) {
      const actor = escenario.usuarios[0].id;
      const proveedor = await crearProveedor({ nombre: `Proveedor ${randomUUID()}` }, actor);
      proveedorIds.push(proveedor.id);
      const ingreso = await crearBorradorIngreso({
        proveedorId: proveedor.id,
        fechaCompra: "2026-10-15", fechaRecepcion,
        lineas: [{ varianteId: escenario.variante.id, cantidad, costoUnitario }],
      });
      await confirmarIngreso(ingreso.id, {
        claveOperacion: randomUUID(), resumenAceptado: ingreso.huellaResumen,
      }, actor);
      return proveedor;
    },
    async reservar(usuario, cantidad) {
      await escenario.carrito(usuario, [cantidad]);
      const resumen = await resumenCheckout(usuario.id, { tipoEntrega: "retiro" });
      const { orden } = await confirmarCheckout(usuario.id, {
        tipoEntrega: "retiro", huellaResumen: resumen.huellaResumen,
        claveConfirmacion: randomUUID(), aceptaPrecioVigente: true,
      });
      return orden;
    },
  };
  try {
    await prueba(contexto);
  } finally {
    const ordenes = await escenario.prisma.orden.findMany({
      where: { carritoId: { in: escenario.ids.carritos } }, select: { id: true },
    });
    const ordenIds = ordenes.map(({ id }) => id);
    await escenario.prisma.asignacionPartida.deleteMany({ where: { detalleOrden: { ordenId: { in: ordenIds } } } });
    await escenario.prisma.movimientoInventario.deleteMany({ where: { varianteId: escenario.variante.id } });
    await escenario.prisma.partidaInventario.deleteMany({ where: { varianteId: escenario.variante.id } });
    const ingresos = await escenario.prisma.ingreso.findMany({
      where: { proveedorId: { in: proveedorIds } }, select: { id: true },
    });
    const ingresoIds = ingresos.map(({ id }) => id);
    await escenario.prisma.lineaIngreso.deleteMany({ where: { ingresoId: { in: ingresoIds } } });
    await escenario.prisma.gastoAdicionalCompra.deleteMany({ where: { ingresoId: { in: ingresoIds } } });
    await escenario.prisma.ingreso.deleteMany({ where: { id: { in: ingresoIds } } });
    await escenario.prisma.eventoProveedor.deleteMany({ where: { proveedorId: { in: proveedorIds } } });
    await escenario.prisma.proveedor.deleteMany({ where: { id: { in: proveedorIds } } });
    await escenario.limpiar();
  }
}

test("reserva tres unidades 2+1, reconoce costo al pago y no repite venta al consumir", async () => {
  await conInventario(async (escenario) => {
    await escenario.recibir(2, "100.00", "2026-10-17");
    await escenario.recibir(2, "150.00", "2026-10-18");
    const orden = await escenario.reservar(escenario.usuarios[0], 3);
    const antes = await escenario.prisma.asignacionPartida.findMany({
      where: { detalleOrden: { ordenId: orden.id } }, orderBy: { id: "asc" },
    });
    assert.deepEqual(antes.map(({ cantidad, estado }) => [cantidad, estado]), [[2, "reservada"], [1, "reservada"]]);
    assert.equal(antes.every(({ importeEfectivo }) => importeEfectivo === null), true);
    assert.equal((await escenario.prisma.talleProducto.findUnique({ where: { id: escenario.variante.id } })).stock, 4);
    const actor = escenario.usuarios[0].id;
    assert.equal((await confirmarPagoAdmin(orden.id, actor)).status, 200);
    assert.equal((await confirmarPagoAdmin(orden.id, actor)).reiterada, true);
    const admin = await obtenerOrdenAdmin(orden.id);
    assert.equal(admin.costoMercaderia.estado, "completo");
    assert.equal(admin.costoMercaderia.costoConocido, "350.00");
    assert.equal(admin.costoMercaderia.importeAtribuido, "600.00");
    assert.equal(admin.costoMercaderia.margenBruto, "250.00");
    assert.equal((await cambiarEstadoAdmin(orden.id, actor, "en_preparacion")).status, 200);
    assert.equal((await cambiarEstadoAdmin(orden.id, actor, "lista_para_retiro")).status, 200);
    assert.equal((await cambiarEstadoAdmin(orden.id, actor, "entregada")).status, 200);
    assert.equal((await escenario.prisma.talleProducto.findUnique({ where: { id: escenario.variante.id } })).stock, 1);
    assert.equal(await escenario.prisma.movimientoInventario.count({
      where: { varianteId: escenario.variante.id, tipo: "salida_venta" },
    }), 2);
    assert.equal((await obtenerOrdenAdmin(orden.id)).costoMercaderia.costoConocido, "350.00");
  });
});

test("un subtotal efectivo con centavos se atribuye a dos proveedores sin pérdida de importe", async () => {
  await conInventario(async (e) => {
    const primero = await e.recibir(2, "100.00", "2026-10-17");
    const segundo = await e.recibir(2, "150.00", "2026-10-18");
    const orden = await e.reservar(e.usuarios[0], 3);
    await e.prisma.orden.update({ where: { id: orden.id },
      data: { subtotal: "500.01", total: "500.01" } });
    assert.equal((await confirmarPagoAdmin(orden.id, e.usuarios[0].id)).status, 200);
    const filtros = { desde: "2026-10-01", hasta: "2026-10-31",
      productoId: e.producto.id, varianteId: e.variante.id, pagina: 1, limite: 20 };
    const uno = await informeComprasVentas({ ...filtros, proveedorId: primero.id });
    const dos = await informeComprasVentas({ ...filtros, proveedorId: segundo.id });
    assert.equal(uno.resumen.importeVentaAtribuido, "333.34");
    assert.equal(dos.resumen.importeVentaAtribuido, "166.67");
    assert.equal(uno.resumen.costoVendidoConocido, "200.00");
    assert.equal(dos.resumen.costoVendidoConocido, "150.00");
  });
});

test("cancelar antes del pago libera partidas y conserva el stock físico", async () => {
  await conInventario(async (escenario) => {
    await escenario.recibir(2, "100.00", "2026-10-17");
    const usuario = escenario.usuarios[0];
    const orden = await escenario.reservar(usuario, 2);
    assert.equal((await cancelarOrdenCliente(usuario.id, orden.id)).status, 200);
    const asignaciones = await escenario.prisma.asignacionPartida.findMany({
      where: { detalleOrden: { ordenId: orden.id } },
    });
    assert.equal(asignaciones.every(({ estado }) => estado === "liberada"), true);
    assert.equal((await escenario.prisma.talleProducto.findUnique({ where: { id: escenario.variante.id } })).stock, 2);
    assert.equal(await escenario.prisma.movimientoInventario.count({
      where: { varianteId: escenario.variante.id, tipo: "salida_venta" },
    }), 0);
  });
});

test("el vencimiento libera las asignaciones sin descontar stock", async () => {
  await conInventario(async (escenario) => {
    await escenario.recibir(1, "75.00", "2026-10-17");
    const orden = await escenario.reservar(escenario.usuarios[0], 1);
    await escenario.prisma.orden.update({
      where: { id: orden.id }, data: { venceEn: new Date("2026-10-18T00:00:00.000Z") },
    });
    const resultado = await confirmarPagoAdmin(orden.id, escenario.usuarios[0].id);
    assert.equal(resultado.status, 409);
    assert.equal((await escenario.prisma.orden.findUnique({ where: { id: orden.id } })).estado, "cancelada_vencimiento");
    const asignaciones = await escenario.prisma.asignacionPartida.findMany({
      where: { detalleOrden: { ordenId: orden.id } },
    });
    assert.equal(asignaciones.length, 1);
    assert.equal(asignaciones[0].estado, "liberada");
    assert.equal((await escenario.prisma.talleProducto.findUnique({ where: { id: escenario.variante.id } })).stock, 1);
  });
});

test("una recepción tardía no reasigna reservas existentes", async () => {
  await conInventario(async (escenario) => {
    await escenario.recibir(1, "100.00", "2026-10-18");
    const primera = await escenario.reservar(escenario.usuarios[0], 1);
    const [asignacionOriginal] = await escenario.prisma.asignacionPartida.findMany({
      where: { detalleOrden: { ordenId: primera.id } },
    });
    await escenario.recibir(1, "50.00", "2026-10-17");
    const segunda = await escenario.reservar(escenario.usuarios[1], 1);
    const [asignacionNueva] = await escenario.prisma.asignacionPartida.findMany({
      where: { detalleOrden: { ordenId: segunda.id } },
    });
    assert.notEqual(asignacionOriginal.partidaId, asignacionNueva.partidaId);
    assert.equal((await escenario.prisma.asignacionPartida.findUnique({ where: { id: asignacionOriginal.id } })).partidaId,
      asignacionOriginal.partidaId);
    assert.equal((await escenario.prisma.reservaStock.findFirst({ where: { ordenId: primera.id } })).cantidad,
      asignacionOriginal.cantidad);
    assert.equal((await escenario.prisma.reservaStock.findFirst({ where: { ordenId: segunda.id } })).cantidad,
      asignacionNueva.cantidad);
  }, { clientes: 2 });
});

test("dos clientes compitiendo por la última unidad generan una sola asignación", async () => {
  await conInventario(async (escenario) => {
    await escenario.recibir(1, "100.00", "2026-10-17");
    const [primero, segundo] = escenario.usuarios;
    await escenario.carrito(primero);
    await escenario.carrito(segundo);
    const [resumenA, resumenB] = await Promise.all([
      resumenCheckout(primero.id, { tipoEntrega: "retiro" }),
      resumenCheckout(segundo.id, { tipoEntrega: "retiro" }),
    ]);
    const resultados = await Promise.allSettled([primero, segundo].map((usuario, indice) => confirmarCheckout(usuario.id, {
      tipoEntrega: "retiro", huellaResumen: [resumenA, resumenB][indice].huellaResumen,
      claveConfirmacion: randomUUID(), aceptaPrecioVigente: true,
    })));
    assert.equal(resultados.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(resultados.filter(({ status }) => status === "rejected").length, 1);
    assert.equal(await escenario.prisma.asignacionPartida.count({
      where: { varianteId: escenario.variante.id, estado: "reservada" },
    }), 1);
  }, { clientes: 2 });
});

test("variante heredada conserva checkout sin asignación ni costo FIFO antes del corte", async () => {
  await conInventario(async (escenario) => {
    const orden = await escenario.reservar(escenario.usuarios[0], 1);
    assert.equal(await escenario.prisma.asignacionPartida.count({
      where: { detalleOrden: { ordenId: orden.id } },
    }), 0);
    assert.equal((await confirmarPagoAdmin(orden.id, escenario.usuarios[0].id)).status, 200);
    assert.equal((await obtenerOrdenAdmin(orden.id)).costoMercaderia.estado, "sin_fifo");
  }, { nuevo: false, stock: 1 });
});
