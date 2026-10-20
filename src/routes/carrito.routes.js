import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";
import { incluirItems, marcarCarritoActualizado, obtenerOCrearCarrito } from "../utils/carrito.js";
import { verificarToken } from "../middleware/auth.js";
import { esProductoVisible } from "../utils/visibilidad-producto.js";
import { bloquearVariantes, disponibilidadVariantes } from "../services/inventario.js";

const router = Router();

async function presentarCarrito(carrito, tx = prisma) {
  const variantes = carrito.items.map((item) => item.talleProducto).filter(Boolean);
  const disponibles = await disponibilidadVariantes(tx, variantes);
  return {
    ...carrito,
    items: carrito.items.map((item) => ({
      ...item,
      talleProducto: item.talleProducto
        ? { ...item.talleProducto, stockDisponible: disponibles.get(item.talleProductoId) ?? 0 }
        : null,
      disponible: item.talleProducto
        ? esProductoVisible(item.talleProducto.producto)
          && item.talleProducto.estado !== "inactivo"
          && (disponibles.get(item.talleProductoId) ?? 0) >= item.cantidad
        : Boolean(item.productoImprovisado),
    })),
    subtotal: carrito.items.reduce(
      (total, item) => total + item.cantidad * Number(item.precioUnitario),
      0,
    ),
  };
}

async function devolverCarritoActualizado(carritoId) {
  await marcarCarritoActualizado(prisma, carritoId);
  const carrito = await prisma.carrito.findUnique({ where: { id: carritoId }, include: incluirItems });
  return conSubtotal(carrito);
}

router.get("/carrito", verificarToken, asyncHandler(async (req, res) => {
  res.json(conSubtotal(await obtenerOCrearCarrito(prisma, req.usuario.id)));
async function obtenerOCrearCarrito(usuarioId) {
  const carrito = await prisma.carrito.findFirst({
    where: { usuarioId, estado: "activo" },
    include: incluirItems,
    orderBy: { id: "desc" },
  });

  if (carrito) return carrito;

  return prisma.carrito.create({
    data: { usuarioId, estado: "activo", canal: "web" },
    include: incluirItems,
  });
}

async function devolverCarritoActualizado(carritoId, tx = prisma) {
  const carrito = await tx.carrito.findUnique({ where: { id: carritoId }, include: incluirItems });
  return presentarCarrito(carrito, tx);
}

async function bloquearCarritoActivo(tx, carritoId, usuarioId) {
  await tx.$queryRaw`SELECT "id" FROM "Carrito" WHERE "id" = ${carritoId} FOR UPDATE`;
  return tx.carrito.findFirst({ where: { id: carritoId, usuarioId, estado: "activo" }, include: incluirItems });
}

router.get("/carrito", verificarToken, asyncHandler(async (req, res) => {
  res.json(await presentarCarrito(await obtenerOCrearCarrito(req.usuario.id)));
}));

router.post("/carrito/items", verificarToken, asyncHandler(async (req, res) => {
  const error = validateBody(req.body, { talleProductoId: "number", cantidad: "number" });
  if (error) return res.status(400).json({ message: error });

  const { talleProductoId, cantidad } = req.body;
  if (!Number.isInteger(talleProductoId) || !Number.isInteger(cantidad) || cantidad <= 0) {
    return res.status(400).json({ message: "La variante y la cantidad deben ser números enteros positivos" });
  }

  const carritoExistente = await prisma.carrito.findFirst({
    where: { usuarioId: req.usuario.id, estado: "activo" },
    include: incluirItems,
    orderBy: { id: "desc" },
  });
  const carrito = carritoExistente ?? await prisma.carrito.create({
    data: { usuarioId: req.usuario.id, estado: "activo", canal: "web" },
    include: incluirItems,
  });

  const resultado = await prisma.$transaction(async (tx) => {
    const activo = await bloquearCarritoActivo(tx, carrito.id, req.usuario.id);
    if (!activo) return { status: 409, message: "El carrito ya fue convertido; actualizá la página" };
    await bloquearVariantes(tx, [talleProductoId]);
    const variante = await tx.talleProducto.findUnique({
      where: { id: talleProductoId }, include: { producto: true },
    });
    if (!variante || variante.estado === "inactivo" || !esProductoVisible(variante.producto)) {
      return { status: 400, message: "La variante no está disponible" };
    }
    const disponible = (await disponibilidadVariantes(tx, [variante])).get(talleProductoId) ?? 0;
    const cantidadActual = activo.items.filter((item) => item.talleProductoId === talleProductoId)
      .reduce((total, item) => total + item.cantidad, 0);
    if (cantidadActual + cantidad > disponible) {
      return { status: 400, message: "Stock insuficiente" };
    }
    const itemExistente = activo.items.find((item) => item.talleProductoId === talleProductoId);
    if (itemExistente) {
      await tx.itemCarrito.update({ where: { id: itemExistente.id }, data: { cantidad: itemExistente.cantidad + cantidad } });
    } else {
      await tx.itemCarrito.create({
        data: { carritoId: activo.id, talleProductoId, cantidad, precioUnitario: variante.producto.precio },
      });
    }
    return { valor: await devolverCarritoActualizado(activo.id, tx) };
  });
  if (resultado.status) return res.status(resultado.status).json({ message: resultado.message });
  res.json(resultado.valor);
}));

router.put("/carrito/items/:id", verificarToken, asyncHandler(async (req, res) => {
  const error = validateBody(req.body, { cantidad: "number" });
  if (error) return res.status(400).json({ message: error });
  const cantidad = req.body.cantidad;
  if (!Number.isInteger(cantidad) || cantidad <= 0) {
    return res.status(400).json({ message: "La cantidad debe ser un número entero positivo" });
  }

  const carritoActual = await obtenerOCrearCarrito(prisma, req.usuario.id);
  const item = await prisma.itemCarrito.findUnique({
    where: { id: Number(req.params.id) },
    include: { carrito: true, talleProducto: true },
  });
  if (!item || item.carrito.usuarioId !== req.usuario.id || item.carritoId !== carritoActual.id) {
    return res.status(404).json({ message: "Item de carrito no encontrado" });
  }
  const resultado = await prisma.$transaction(async (tx) => {
    const activo = await bloquearCarritoActivo(tx, item.carritoId, req.usuario.id);
    if (!activo) return { status: 409, message: "El carrito ya fue convertido; actualizá la página" };
    const actual = activo.items.find((linea) => linea.id === item.id);
    if (!actual) return { status: 404, message: "Item de carrito no encontrado" };
    if (actual.talleProductoId) {
      await bloquearVariantes(tx, [actual.talleProductoId]);
      const variante = await tx.talleProducto.findUnique({
        where: { id: actual.talleProductoId }, include: { producto: true },
      });
      if (cantidad > actual.cantidad && (!variante || variante.estado === "inactivo"
        || !esProductoVisible(variante.producto))) {
        return { status: 400, message: "La variante no está disponible" };
      }
      if (variante) {
        const disponible = (await disponibilidadVariantes(tx, [variante])).get(variante.id) ?? 0;
        const otras = activo.items.filter((linea) => linea.id !== actual.id && linea.talleProductoId === variante.id)
          .reduce((total, linea) => total + linea.cantidad, 0);
        if (cantidad + otras > disponible && cantidad > actual.cantidad) {
          return { status: 400, message: "Stock insuficiente" };
        }
      }
    }
    await tx.itemCarrito.update({ where: { id: actual.id }, data: { cantidad } });
    return { valor: await devolverCarritoActualizado(activo.id, tx) };
  });
  if (resultado.status) return res.status(resultado.status).json({ message: resultado.message });
  res.json(resultado.valor);
}));

router.delete("/carrito/items/:id", verificarToken, asyncHandler(async (req, res) => {
  const carritoActual = await obtenerOCrearCarrito(prisma, req.usuario.id);
  const item = await prisma.itemCarrito.findUnique({ where: { id: Number(req.params.id) }, include: { carrito: true } });
  if (!item || item.carrito.usuarioId !== req.usuario.id || item.carritoId !== carritoActual.id) {
    return res.status(404).json({ message: "Item de carrito no encontrado" });
  }

  const resultado = await prisma.$transaction(async (tx) => {
    const activo = await bloquearCarritoActivo(tx, item.carritoId, req.usuario.id);
    if (!activo) return { status: 409, message: "El carrito ya fue convertido; actualizá la página" };
    const actual = activo.items.find((linea) => linea.id === item.id);
    if (!actual) return { status: 404, message: "Item de carrito no encontrado" };
    await tx.itemCarrito.delete({ where: { id: actual.id } });
    return { valor: await devolverCarritoActualizado(activo.id, tx) };
  });
  if (resultado.status) return res.status(resultado.status).json({ message: resultado.message });
  res.json(resultado.valor);
}));

router.delete("/carrito", verificarToken, asyncHandler(async (req, res) => {
  const carrito = await obtenerOCrearCarrito(prisma, req.usuario.id);
  await prisma.itemCarrito.deleteMany({ where: { carritoId: carrito.id } });
  res.json(await devolverCarritoActualizado(carrito.id));
  const carrito = await obtenerOCrearCarrito(req.usuario.id);
  const resultado = await prisma.$transaction(async (tx) => {
    const activo = await bloquearCarritoActivo(tx, carrito.id, req.usuario.id);
    if (!activo) return { status: 409, message: "El carrito ya fue convertido; actualizá la página" };
    await tx.itemCarrito.deleteMany({ where: { carritoId: activo.id } });
    return { valor: await devolverCarritoActualizado(activo.id, tx) };
  });
  if (resultado.status) return res.status(resultado.status).json({ message: resultado.message });
  res.json(resultado.valor);
}));

export default router;
