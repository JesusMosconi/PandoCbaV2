import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";
import { verificarToken } from "../middleware/auth.js";
import { esAdmin } from "../middleware/es-admin.js";
import { whereProductoVisible } from "../utils/visibilidad-producto.js";
import { presentarVariantesConDisponibilidad } from "../services/inventario.js";

const router = Router();
const requerirAdmin = [verificarToken, esAdmin];
const requiredFields = { orden: "number", productoId: "number" };

router.get("/catalogo-inicio", asyncHandler(async (req, res) => {
  const catalogo = await prisma.catalogoInicio.findMany({
    where: { producto: { is: whereProductoVisible } },
    orderBy: { orden: "asc" },
    include: {
      producto: {
        select: {
          id: true,
          nombre: true,
          precio: true,
          descripcion: true,
          imagenes: { orderBy: { orden: "asc" }, take: 1 },
          talles: { include: { talle: true, color: true } },
        },
      },
    },
  });
  const variantes = catalogo.flatMap((item) => item.producto.talles);
  const porId = new Map((await presentarVariantesConDisponibilidad(prisma, variantes))
    .map((variante) => [variante.id, variante]));
  res.json(catalogo.map((item) => ({
    ...item,
    producto: {
      ...item.producto,
      talles: item.producto.talles.map((variante) => porId.get(variante.id))
        .filter((variante) => variante.estado !== "inactivo" && variante.stockDisponible > 0),
    },
  })));
}));

router.get("/catalogo-inicio/:id", asyncHandler(async (req, res) => {
  const item = await prisma.catalogoInicio.findFirst({
    where: { id: Number(req.params.id), producto: { is: whereProductoVisible } },
    include: {
      producto: {
        select: {
          id: true,
          nombre: true,
          precio: true,
          descripcion: true,
          imagenes: { orderBy: { orden: "asc" }, take: 1 },
          talles: { include: { talle: true, color: true } },
        },
      },
    },
  });
  if (!item) return res.status(404).json({ message: "Elemento de catálogo no encontrado" });
  const talles = (await presentarVariantesConDisponibilidad(prisma, item.producto.talles))
    .filter((variante) => variante.estado !== "inactivo" && variante.stockDisponible > 0);
  res.json({ ...item, producto: { ...item.producto, talles } });
}));

router.post("/catalogo-inicio", ...requerirAdmin, asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields);
  if (error) return res.status(400).json({ message: error });
  const { orden, productoId } = req.body;
  const item = await prisma.catalogoInicio.create({ data: { orden, productoId } });
  res.json(item);
}));

router.put("/catalogo-inicio/:id", ...requerirAdmin, asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields);
  if (error) return res.status(400).json({ message: error });
  const { orden, productoId } = req.body;
  const item = await prisma.catalogoInicio.update({ where: { id: Number(req.params.id) }, data: { orden, productoId } });
  res.json(item);
}));

router.delete("/catalogo-inicio/:id", ...requerirAdmin, asyncHandler(async (req, res) => {
  const item = await prisma.catalogoInicio.delete({ where: { id: Number(req.params.id) } });
  res.json(item);
}));

export default router;
