import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";

const router = Router();
const requiredFields = { orden: "number", productoId: "number" };

router.get("/catalogo-inicio", asyncHandler(async (req, res) => {
  const catalogo = await prisma.catalogoInicio.findMany({
    orderBy: { orden: "asc" },
    include: {
      producto: {
        select: {
          nombre: true,
          precio: true,
          imagenes: { orderBy: { orden: "asc" }, take: 1 },
        },
      },
    },
  });
  res.json(catalogo);
}));

router.get("/catalogo-inicio/:id", asyncHandler(async (req, res) => {
  const item = await prisma.catalogoInicio.findUnique({
    where: { id: Number(req.params.id) },
    include: { producto: { select: { nombre: true, precio: true, imagenes: { orderBy: { orden: "asc" }, take: 1 } } } },
  });
  if (!item) return res.status(404).json({ message: "Elemento de catálogo no encontrado" });
  res.json(item);
}));

router.post("/catalogo-inicio", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields);
  if (error) return res.status(400).json({ message: error });
  const item = await prisma.catalogoInicio.create({ data: req.body });
  res.json(item);
}));

router.put("/catalogo-inicio/:id", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields);
  if (error) return res.status(400).json({ message: error });
  const item = await prisma.catalogoInicio.update({ where: { id: Number(req.params.id) }, data: req.body });
  res.json(item);
}));

router.delete("/catalogo-inicio/:id", asyncHandler(async (req, res) => {
  const item = await prisma.catalogoInicio.delete({ where: { id: Number(req.params.id) } });
  res.json(item);
}));

export default router;
