import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { ErrorDatosCheckout, normalizarEntrega, resumenCheckout } from "../src/services/checkout.js";
import { confirmarCheckout, ErrorConfirmacionCheckout } from "../src/services/checkout.js";
import { esCliente } from "../src/middleware/es-cliente.js";
import { crearEscenario } from "./soporte/escenario.js";

test("normaliza los cinco datos de envío y rechaza campos inválidos", () => {
  assert.deepEqual(normalizarEntrega({ tipoEntrega: "envio", datosEnvio: {
    direccion: "  Calle   123  ", ciudad: " Córdoba ", codPostal: " x 5 0 0 0 ",
    telefono: "+54 (351) 123-4567", email: "  Cliente@Ejemplo.COM  ",
  } }), { tipoEntrega: "envio", datosEnvio: {
    direccion: "Calle 123", ciudad: "Córdoba", codPostal: "X5000",
    telefono: "+543511234567", email: "cliente@ejemplo.com",
  } });

  assert.throws(() => normalizarEntrega({ tipoEntrega: "envio", datosEnvio: {
    direccion: "a", ciudad: "b", codPostal: "abcd", telefono: "12", email: "sin-arroba",
  } }), (error) => error instanceof ErrorDatosCheckout
    && new Set(error.camposInvalidos.map(({ campo }) => campo)).size === 5);
});

test("el resumen suma líneas de la misma variante antes de comparar disponibilidad", async () => {
  const variante = {
    id: 9, stock: 3, estado: "activo", productoId: 2,
    producto: { nombre: "Remera", precio: new Prisma.Decimal("10.50"), activo: true, web: true },
    talle: { valor: "M" }, color: { nombre: "Negro" },
  };
  const carrito = { id: 4, items: [1, 2].map((id) => ({
    id, cantidad: 2, talleProductoId: 9, talleProducto: variante,
    productoImprovisadoId: null, precioUnitario: new Prisma.Decimal("10.50"),
  })) };
  const tx = { $queryRaw: async () => [{ ahora: new Date() }], reservaStock: { findMany: async () => [] } };
  const resumen = await resumenCheckout(7, { tipoEntrega: "retiro" }, tx, carrito);
  assert.equal(resumen.puedeConfirmar, false);
  assert.equal(resumen.subtotalProductos, "42");
  assert.deepEqual(resumen.lineas.map(({ motivosBloqueo }) => motivosBloqueo),
    [["stock_insuficiente"], ["stock_insuficiente"]]);
});

test("el resumen cambia de huella al variar precio o reservas vigentes", async () => {
  const producto = { nombre: "Remera", precio: new Prisma.Decimal("10.50"), activo: true, web: true };
  const variante = { id: 12, stock: 2, estado: "activo", producto,
    talle: { valor: "M" }, color: { nombre: "Negro" } };
  const carrito = { id: 8, items: [{ id: 20, cantidad: 1, talleProductoId: 12,
    talleProducto: variante, productoImprovisadoId: null,
    precioUnitario: new Prisma.Decimal("10.50") }] };
  let reservas = [];
  const tx = { $queryRaw: async () => [{ ahora: new Date() }],
    reservaStock: { findMany: async () => reservas } };
  const inicial = await resumenCheckout(7, { tipoEntrega: "retiro" }, tx, carrito);
  producto.precio = new Prisma.Decimal("12.00");
  const nuevoPrecio = await resumenCheckout(7, { tipoEntrega: "retiro" }, tx, carrito);
  assert.notEqual(inicial.huellaResumen, nuevoPrecio.huellaResumen);
  assert.equal(nuevoPrecio.lineas[0].cambioPrecio, true);
  reservas = [{ talleProductoId: 12, cantidad: 2 }];
  const sinStock = await resumenCheckout(7, { tipoEntrega: "retiro" }, tx, carrito);
  assert.notEqual(nuevoPrecio.huellaResumen, sinStock.huellaResumen);
  assert.equal(sinStock.puedeConfirmar, false);
  assert.deepEqual(sinStock.lineas[0].motivosBloqueo, ["stock_insuficiente"]);
});

const solicitud = (resumen, claveConfirmacion) => ({
  tipoEntrega: "retiro", huellaResumen: resumen.huellaResumen,
  claveConfirmacion, aceptaPrecioVigente: true,
});

test("dos clientes que compran la última unidad producen una sola orden y reserva", async () => {
  const escenario = await crearEscenario({ clientes: 2, stock: 1 });
  try {
    const [a, b] = escenario.usuarios;
    await escenario.carrito(a);
    await escenario.carrito(b);
    const [resumenA, resumenB] = await Promise.all([
      resumenCheckout(a.id, { tipoEntrega: "retiro" }),
      resumenCheckout(b.id, { tipoEntrega: "retiro" }),
    ]);
    const resultados = await Promise.allSettled([
      confirmarCheckout(a.id, solicitud(resumenA, `ultima-${a.id}`)),
      confirmarCheckout(b.id, solicitud(resumenB, `ultima-${b.id}`)),
    ]);
    assert.equal(resultados.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(resultados.filter(({ status }) => status === "rejected").length, 1);
    const ordenes = await escenario.prisma.orden.findMany({
      where: { usuarioId: { in: [a.id, b.id] } }, include: { reservas: true, detalles: true },
    });
    assert.equal(ordenes.length, 1);
    assert.equal(ordenes[0].reservas.length, 1);
    assert.equal(ordenes[0].reservas[0].cantidad, 1);
    assert.equal(ordenes[0].detalles.length, 1);
  } finally { await escenario.limpiar(); }
});

test("dos líneas de la misma variante se rechazan juntas sin crear orden", async () => {
  const escenario = await crearEscenario({ stock: 3 });
  try {
    const usuario = escenario.usuarios[0];
    await escenario.carrito(usuario, [2, 2]);
    const resumen = await resumenCheckout(usuario.id, { tipoEntrega: "retiro" });
    assert.deepEqual(resumen.lineas.map(({ motivosBloqueo }) => motivosBloqueo), [
      ["stock_insuficiente"], ["stock_insuficiente"],
    ]);
    await assert.rejects(
      confirmarCheckout(usuario.id, solicitud(resumen, `agrupada-${usuario.id}`)),
      (error) => error instanceof ErrorConfirmacionCheckout && error.codigo === "ITEMS_NO_DISPONIBLES"
        && error.itemsAfectados.length === 2,
    );
    assert.equal(await escenario.prisma.orden.count({ where: { usuarioId: usuario.id } }), 0);
  } finally { await escenario.limpiar(); }
});

test("reintento igual recupera una orden; intención distinta y resumen viejo no la duplican", async () => {
  const escenario = await crearEscenario();
  try {
    const usuario = escenario.usuarios[0];
    await escenario.carrito(usuario);
    const resumen = await resumenCheckout(usuario.id, { tipoEntrega: "retiro" });
    const entrada = solicitud(resumen, `reintento-${usuario.id}`);
    const [primera, segunda] = await Promise.all([
      confirmarCheckout(usuario.id, entrada), confirmarCheckout(usuario.id, entrada),
    ]);
    assert.equal(primera.orden.id, segunda.orden.id);
    const tercera = await confirmarCheckout(usuario.id, entrada);
    assert.equal(tercera.orden.id, primera.orden.id);
    await assert.rejects(
      confirmarCheckout(usuario.id, { ...entrada, huellaResumen: "a".repeat(64) }),
      (error) => error.codigo === "INTENCION_EN_CONFLICTO",
    );
    await assert.rejects(
      confirmarCheckout(usuario.id, { ...entrada, claveConfirmacion: `otra-${usuario.id}` }),
      (error) => error.codigo === "INTENCION_EN_CONFLICTO",
    );
    assert.equal(await escenario.prisma.orden.count({ where: { usuarioId: usuario.id } }), 1);
    assert.equal(await escenario.prisma.eventoOrden.count({ where: { ordenId: primera.orden.id } }), 1);
  } finally { await escenario.limpiar(); }
});

test("precio o disponibilidad modificados después del resumen impiden confirmar", async () => {
  const escenario = await crearEscenario();
  try {
    const usuario = escenario.usuarios[0];
    await escenario.carrito(usuario);
    const viejo = await resumenCheckout(usuario.id, { tipoEntrega: "retiro" });
    await escenario.prisma.producto.update({ where: { id: escenario.producto.id }, data: { precio: "130.00" } });
    await assert.rejects(
      confirmarCheckout(usuario.id, solicitud(viejo, `precio-${usuario.id}`)),
      (error) => error.codigo === "RESUMEN_CAMBIO",
    );
    const vigente = await resumenCheckout(usuario.id, { tipoEntrega: "retiro" });
    await escenario.prisma.talleProducto.update({ where: { id: escenario.variante.id }, data: { estado: "inactivo" } });
    await assert.rejects(
      confirmarCheckout(usuario.id, solicitud(vigente, `inactivo-${usuario.id}`)),
      (error) => error.codigo === "ITEMS_NO_DISPONIBLES"
        && error.itemsAfectados[0].motivo === "variante_inactiva",
    );
    assert.equal(await escenario.prisma.orden.count({ where: { usuarioId: usuario.id } }), 0);
  } finally { await escenario.limpiar(); }
});

test("un rol distinto de cliente recibe 403 aun con sesión", async () => {
  const escenario = await crearEscenario();
  try {
    const usuario = escenario.usuarios[0];
    await escenario.prisma.usuario.update({ where: { id: usuario.id }, data: { rol: "admin" } });
    let codigo = null;
    await esCliente({ usuario: { id: usuario.id } }, {
      status(valor) { codigo = valor; return this; }, json() { return this; },
    }, () => { throw new Error("No debía autorizar el rol admin"); });
    assert.equal(codigo, 403);
  } finally { await escenario.limpiar(); }
});

test("envío conserva detalle, cinco datos normalizados y total final sin cotizar", async () => {
  const escenario = await crearEscenario({ precio: "120.50" });
  try {
    const usuario = escenario.usuarios[0];
    await escenario.carrito(usuario, [2]);
    const entrega = { tipoEntrega: "envio", datosEnvio: {
      direccion: "  Calle   123 ", ciudad: " Córdoba ", codPostal: " x 5 0 0 0 ",
      telefono: "+54 (351) 123-4567", email: " CLIENTE@EJEMPLO.COM ",
    } };
    const resumen = await resumenCheckout(usuario.id, entrega);
    const { orden } = await confirmarCheckout(usuario.id, {
      ...entrega, huellaResumen: resumen.huellaResumen,
      claveConfirmacion: `envio-${usuario.id}`, aceptaPrecioVigente: true,
    });
    const persistida = await escenario.prisma.orden.findUnique({
      where: { id: orden.id }, include: { detalles: true, reservas: true, datosEnvio: true, eventos: true },
    });
    assert.equal(persistida.estado, "pendiente_pago");
    assert.equal(persistida.subtotal.toString(), "241");
    assert.equal(persistida.costoEnvio, null);
    assert.equal(persistida.total, null);
    assert.equal(persistida.venceEn.getTime() - persistida.creadaEn.getTime(), 24 * 60 * 60 * 1000);
    assert.equal(persistida.datosEnvio.email, "cliente@ejemplo.com");
    assert.equal(persistida.datosEnvio.codPostal, "X5000");
    assert.equal(persistida.detalles.length, 1);
    assert.equal(persistida.detalles[0].nombreProducto, escenario.producto.nombre);
    assert.equal(persistida.detalles[0].importeLinea.toString(), "241");
    assert.equal(persistida.reservas[0].cantidad, 2);
    assert.equal(persistida.eventos.length, 1);
  } finally { await escenario.limpiar(); }
});
