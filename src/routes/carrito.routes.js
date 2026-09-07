import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";
import { verificarToken } from "../middleware/auth.js";

const router = Router();
const incluirItems = {
  items: {
    include: {
      talleProducto: {
        include: {
          talle: true,
          color: true,
          producto: { include: { imagenes: { orderBy: { orden: "asc" }, take: 1 } } },
        },
      },
      productoImprovisado: true,
    },
    orderBy: { id: "asc" },
  },
};

function conSubtotal(carrito) {
  return {
    ...carrito,
    subtotal: carrito.items.reduce(
      (total, item) => total + item.cantidad * Number(item.precioUnitario),
      0,
    ),
  };
}

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

async function devolverCarritoActualizado(carritoId) {
  const carrito = await prisma.carrito.findUnique({ where: { id: carritoId }, include: incluirItems });
  return conSubtotal(carrito);
}

router.get("/carrito", verificarToken, asyncHandler(async (req, res) => {
  res.json(conSubtotal(await obtenerOCrearCarrito(req.usuario.id)));
}));

router.post("/carrito/items", verificarToken, asyncHandler(async (req, res) => {
  const error = validateBody(req.body, { talleProductoId: "number", cantidad: "number" });
  if (error) return res.status(400).json({ message: error });

  const { talleProductoId, cantidad } = req.body;
  if (!Number.isInteger(talleProductoId) || !Number.isInteger(cantidad) || cantidad <= 0) {
    return res.status(400).json({ message: "La variante y la cantidad deben ser números enteros positivos" });
  }

  const carrito = await obtenerOCrearCarrito(req.usuario.id);
  const talleProducto = await prisma.talleProducto.findUnique({
    where: { id: talleProductoId },
    include: { producto: true },
  });
  if (!talleProducto || talleProducto.estado === "inactivo") {
    return res.status(400).json({ message: "La variante no está disponible" });
  }

  const itemExistente = carrito.items.find((item) => item.talleProductoId === talleProductoId);
  const cantidadFinal = (itemExistente?.cantidad ?? 0) + cantidad;
  if (cantidadFinal > talleProducto.stock) {
    return res.status(400).json({ message: "Stock insuficiente" });
  }

  if (itemExistente) {
    await prisma.itemCarrito.update({ where: { id: itemExistente.id }, data: { cantidad: cantidadFinal } });
  } else {
    await prisma.itemCarrito.create({
      data: { carritoId: carrito.id, talleProductoId, cantidad, precioUnitario: talleProducto.producto.precio },
    });
  }

  res.json(await devolverCarritoActualizado(carrito.id));
}));

router.put("/carrito/items/:id", verificarToken, asyncHandler(async (req, res) => {
  const error = validateBody(req.body, { cantidad: "number" });
  if (error) return res.status(400).json({ message: error });
  const cantidad = req.body.cantidad;
  if (!Number.isInteger(cantidad) || cantidad <= 0) {
    return res.status(400).json({ message: "La cantidad debe ser un número entero positivo" });
  }

  const item = await prisma.itemCarrito.findUnique({
    where: { id: Number(req.params.id) },
    include: { carrito: true, talleProducto: true },
  });
  if (!item || item.carrito.usuarioId !== req.usuario.id) {
    return res.status(404).json({ message: "Item de carrito no encontrado" });
  }
  if (item.talleProducto && (item.talleProducto.estado === "inactivo" || cantidad > item.talleProducto.stock)) {
    return res.status(400).json({ message: "Stock insuficiente" });
  }

  await prisma.itemCarrito.update({ where: { id: item.id }, data: { cantidad } });
  res.json(await devolverCarritoActualizado(item.carritoId));
}));

router.delete("/carrito/items/:id", verificarToken, asyncHandler(async (req, res) => {
  const item = await prisma.itemCarrito.findUnique({ where: { id: Number(req.params.id) }, include: { carrito: true } });
  if (!item || item.carrito.usuarioId !== req.usuario.id) {
    return res.status(404).json({ message: "Item de carrito no encontrado" });
  }

  await prisma.itemCarrito.delete({ where: { id: item.id } });
  res.json(await devolverCarritoActualizado(item.carritoId));
}));

router.delete("/carrito", verificarToken, asyncHandler(async (req, res) => {
  const carrito = await obtenerOCrearCarrito(req.usuario.id);
  await prisma.itemCarrito.deleteMany({ where: { carritoId: carrito.id } });
  res.json(await devolverCarritoActualizado(carrito.id));
}));

export default router;