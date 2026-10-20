import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { confirmarCheckout, resumenCheckout } from "../src/services/checkout.js";
import { cancelarOrdenCliente, listarOrdenesCliente, obtenerOrdenCliente } from "../src/services/ordenes.js";
import { esCliente } from "../src/middleware/es-cliente.js";
import { crearEscenario } from "./soporte/escenario.js";

async function crearOrden(escenario, usuario) {
  await escenario.carrito(usuario);
  const resumen = await resumenCheckout(usuario.id, { tipoEntrega: "retiro" });
  const { orden } = await confirmarCheckout(usuario.id, {
    tipoEntrega: "retiro", huellaResumen: resumen.huellaResumen,
    claveConfirmacion: randomUUID(), aceptaPrecioVigente: true,
  });
  return orden;
}

test("historial y detalle son privados y conservan la instantánea histórica", async () => {
  const escenario = await crearEscenario({ clientes: 2 });
  try {
    const [dueno, ajeno] = escenario.usuarios;
    const orden = await crearOrden(escenario, dueno);
    const listaPropia = await listarOrdenesCliente(dueno.id);
    const listaAjena = await listarOrdenesCliente(ajeno.id);
    assert.deepEqual(listaPropia.map(({ id }) => id), [orden.id]);
    assert.deepEqual(listaAjena, []);
    assert.equal(await obtenerOrdenCliente(ajeno.id, orden.id), null);
    assert.equal(await obtenerOrdenCliente(dueno.id, 2_000_000_000), null);
    await escenario.prisma.producto.update({ where: { id: escenario.producto.id }, data: {
      nombre: "Nombre cambiado después", precio: "999.00", web: false,
    } });
    const detalle = await obtenerOrdenCliente(dueno.id, orden.id);
    assert.equal(detalle.detalles[0].nombreProducto, escenario.producto.nombre);
    assert.equal(detalle.detalles[0].precioUnitario, "120.5");
    assert.equal(detalle.subtotalProductos, "120.5");
  } finally { await escenario.limpiar(); }
});

test("solo el dueño cancela su pendiente y el reintento no duplica stock ni evento", async () => {
  const escenario = await crearEscenario({ clientes: 2, stock: 2 });
  try {
    const [dueno, ajeno] = escenario.usuarios;
    const orden = await crearOrden(escenario, dueno);
    const ajena = await cancelarOrdenCliente(ajeno.id, orden.id);
    const inexistente = await cancelarOrdenCliente(dueno.id, 2_000_000_000);
    assert.equal(ajena.status, 404);
    assert.equal(inexistente.status, 404);
    const primera = await cancelarOrdenCliente(dueno.id, orden.id);
    const reiterada = await cancelarOrdenCliente(dueno.id, orden.id);
    assert.equal(primera.status, 200);
    assert.equal(reiterada.status, 200);
    assert.equal(reiterada.orden.estado, "cancelada_cliente");
    const reserva = await escenario.prisma.reservaStock.findFirst({ where: { ordenId: orden.id } });
    assert.equal(reserva.estado, "liberada");
    assert.equal(await escenario.prisma.eventoOrden.count({ where: { ordenId: orden.id } }), 2);
    assert.equal((await escenario.prisma.talleProducto.findUnique({ where: { id: escenario.variante.id } })).stock, 2);
  } finally { await escenario.limpiar(); }
});

test("cancelación al vencer materializa el vencimiento una sola vez", async () => {
  const escenario = await crearEscenario();
  try {
    const usuario = escenario.usuarios[0];
    const orden = await crearOrden(escenario, usuario);
    await escenario.prisma.orden.update({ where: { id: orden.id }, data: {
      venceEn: new Date(Date.now() - 1000),
    } });
    const resultados = await Promise.all([
      cancelarOrdenCliente(usuario.id, orden.id),
      cancelarOrdenCliente(usuario.id, orden.id),
    ]);
    assert.deepEqual(resultados.map(({ status }) => status), [409, 409]);
    const actual = await escenario.prisma.orden.findUnique({ where: { id: orden.id } });
    assert.equal(actual.estado, "cancelada_vencimiento");
    assert.equal(await escenario.prisma.eventoOrden.count({ where: { ordenId: orden.id } }), 2);
    assert.equal((await escenario.prisma.reservaStock.findFirst({ where: { ordenId: orden.id } })).estado, "liberada");
  } finally { await escenario.limpiar(); }
});

test("el middleware consulta el rol vigente antes de mostrar órdenes del cliente", async () => {
  const escenario = await crearEscenario();
  try {
    const usuario = escenario.usuarios[0];
    await escenario.prisma.usuario.update({ where: { id: usuario.id }, data: { rol: "admin" } });
    let estado = null;
    await esCliente({ usuario: { id: usuario.id } }, {
      status(valor) { estado = valor; return this; }, json() { return this; },
    }, () => { throw new Error("El admin no debe entrar al historial cliente"); });
    assert.equal(estado, 403);
  } finally { await escenario.limpiar(); }
});
