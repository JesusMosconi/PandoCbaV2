import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";

const router = Router();
const requiredFields = { nombre: "string", precio: "number", categoriaId: "number" };
const optionalFields = { descripcion: "string", activo: "boolean", web: "boolean", coleccionId: "number" };

router.get("/productos", asyncHandler(async (req, res) => {
  const { categoriaId, web, talle, orden, coleccionId } = req.query;
  const productos = await prisma.producto.findMany({
    where: {
      activo: true,
      categoriaId: categoriaId ? Number(categoriaId) : undefined,
      coleccionId: coleccionId ? Number(coleccionId) : undefined,
      web: web === "true" ? true : undefined,
      talles: talle
        ? { some: { talle: { valor: talle }, stock: { gt: 0 } } }
        : undefined,
    },
    orderBy: orden === "asc" || orden === "desc" ? { precio: orden } : undefined,
    include: {
      categoria: true,
      coleccion: true,
      imagenes: { orderBy: { id: "asc" }, take: 1 },
      talles: { where: { stock: { gt: 0 } }, include: { talle: true, color: true } },
    },
  });
  res.json(productos);
}));

router.get("/productos/:id", asyncHandler(async (req, res) => {
  const producto = await prisma.producto.findUnique({
    where: { id: Number(req.params.id) },
    include: {
      categoria: true,
      coleccion: true,
      imagenes: { orderBy: { orden: "asc" } },
      talles: { include: { talle: true, color: true } },
    },
  });
  if (!producto) return res.status(404).json({ message: "Producto no encontrado" });
  res.json(producto);
}));

router.post("/productos", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields, optionalFields);
  if (error) return res.status(400).json({ message: error });
  res.json(await prisma.producto.create({ data: req.body }));
}));

router.put("/productos/:id", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields, optionalFields);
  if (error) return res.status(400).json({ message: error });
  res.json(await prisma.producto.update({ where: { id: Number(req.params.id) }, data: req.body }));
}));

router.delete("/productos/:id", asyncHandler(async (req, res) => {
  await prisma.producto.update({ where: { id: Number(req.params.id) }, data: { activo: false } });
  res.json({ message: "Producto desactivado" });
}));

export default router;
