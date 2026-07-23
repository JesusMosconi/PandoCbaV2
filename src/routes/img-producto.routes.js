import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";

const router = Router();

router.get("/img-producto/:productoId", asyncHandler(async (req, res) => {
  const imagenes = await prisma.imgProducto.findMany({
    where: { productoId: Number(req.params.productoId) },
    orderBy: { orden: "asc" },
  });
  res.json(imagenes);
}));

router.post("/img-producto", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, { url: "string", orden: "number", productoId: "number" });
  if (error) return res.status(400).json({ message: error });
  res.json(await prisma.imgProducto.create({ data: req.body }));
}));

router.put("/img-producto/:id", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, { url: "string", orden: "number" });
  if (error) return res.status(400).json({ message: error });
  res.json(await prisma.imgProducto.update({
    where: { id: Number(req.params.id) },
    data: { url: req.body.url, orden: req.body.orden },
  }));
}));

router.delete("/img-producto/:id", asyncHandler(async (req, res) => {
  await prisma.imgProducto.delete({ where: { id: Number(req.params.id) } });
  res.json({ message: "ImgProducto eliminado" });
}));

export default router;
