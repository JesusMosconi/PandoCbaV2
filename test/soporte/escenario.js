import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import prisma from "../../src/db.js";

export function exigirBasePrueba() {
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  assert.equal(url.hostname, "ep-floral-dust-acglee71-pooler.sa-east-1.aws.neon.tech");
  const base = process.env.PANDO_TEST_DATABASE ?? "neondb";
  if (base !== "neondb") assert.match(base, /^codex_003_[a-z0-9_]+$/);
  assert.equal(url.pathname, `/${base}`);
  assert.equal(process.env.PANDO_TEST_BRANCH_ID, "br-snowy-glitter-acxy36q0");
}

export async function crearEscenario({ clientes = 1, stock = 4, precio = "120.50" } = {}) {
  exigirBasePrueba();
  const sufijo = randomUUID().slice(0, 12);
  const ids = { usuarios: [], carritos: [], ordenes: [] };
  const categoria = await prisma.categoria.create({ data: { nombre: `Prueba checkout ${sufijo}` } });
  const talle = await prisma.talle.create({ data: { valor: `T-${sufijo}` } });
  const color = await prisma.color.create({ data: { nombre: `Color ${sufijo}`, hex: "#123456" } });
  const producto = await prisma.producto.create({ data: {
    nombre: `Producto de prueba ${sufijo}`, precio, categoriaId: categoria.id,
  } });
  const variante = await prisma.talleProducto.create({ data: {
    productoId: producto.id, talleId: talle.id, colorId: color.id, stock, estado: "activo",
  } });
  const usuarios = [];
  for (let indice = 0; indice < clientes; indice += 1) {
    const usuario = await prisma.usuario.create({ data: {
      nombre: "Prueba", apellido: "Checkout", email: `checkout-${sufijo}-${indice}@example.invalid`,
      password: "cuenta-descartable-sin-login", rol: "cliente",
    } });
    ids.usuarios.push(usuario.id);
    usuarios.push(usuario);
  }

  async function carrito(usuario, cantidades = [1]) {
    const creado = await prisma.carrito.create({ data: { usuarioId: usuario.id, canal: "web" } });
    ids.carritos.push(creado.id);
    for (const cantidad of cantidades) {
      await prisma.itemCarrito.create({ data: {
        carritoId: creado.id, talleProductoId: variante.id, cantidad, precioUnitario: precio,
      } });
    }
    return creado;
  }

  async function limpiar() {
    const ordenes = await prisma.orden.findMany({ where: { carritoId: { in: ids.carritos } }, select: { id: true } });
    const ordenIds = ordenes.map(({ id }) => id);
    if (ordenIds.length) {
      await prisma.eventoOrden.deleteMany({ where: { ordenId: { in: ordenIds } } });
      await prisma.reservaStock.deleteMany({ where: { ordenId: { in: ordenIds } } });
      await prisma.detalleOrden.deleteMany({ where: { ordenId: { in: ordenIds } } });
      await prisma.datosEnvio.deleteMany({ where: { ordenId: { in: ordenIds } } });
      await prisma.orden.deleteMany({ where: { id: { in: ordenIds } } });
    }
    await prisma.itemCarrito.deleteMany({ where: { carritoId: { in: ids.carritos } } });
    await prisma.carrito.deleteMany({ where: { id: { in: ids.carritos } } });
    await prisma.talleProducto.delete({ where: { id: variante.id } });
    await prisma.vigenciaPrecio.deleteMany({ where: { productoId: producto.id } });
    await prisma.producto.delete({ where: { id: producto.id } });
    await prisma.categoria.delete({ where: { id: categoria.id } });
    await prisma.talle.delete({ where: { id: talle.id } });
    await prisma.color.delete({ where: { id: color.id } });
    await prisma.usuario.deleteMany({ where: { id: { in: ids.usuarios } } });
  }

  return { prisma, usuarios, variante, producto, categoria, talle, color, carrito, limpiar, ids };
}
