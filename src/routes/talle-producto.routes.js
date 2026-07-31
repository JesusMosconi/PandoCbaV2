import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";

const router = Router();
const requiredFields = {
  stock: "number",
  estado: "string",
  productoId: "number",
  talleId: "number",
  colorId: "number",
};

router.get("/talle-producto", asyncHandler(async (req, res) => {
  const { productoId } = req.query;
  res.json(await prisma.talleProducto.findMany({
    where: { productoId: productoId ? Number(productoId) : undefined },
    include: { talle: true, color: true },
    orderBy: { id: "asc" },
  }));
}));

router.post("/talle-producto", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields);
  if (error) return res.status(400).json({ message: error });
  res.json(await prisma.talleProducto.create({
    data: req.body,
    include: { talle: true, color: true },
  }));
}));

router.put("/talle-producto/:id", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields);
  if (error) return res.status(400).json({ message: error });
  res.json(await prisma.talleProducto.update({
    where: { id: Number(req.params.id) },
    data: req.body,
    include: { talle: true, color: true },
  }));
}));

// Se desactiva la variante en lugar de borrarla porque puede estar referenciada por ItemCarrito.
router.delete("/talle-producto/:id", asyncHandler(async (req, res) => {
  res.json(await prisma.talleProducto.update({
    where: { id: Number(req.params.id) },
    data: { stock: 0, estado: "inactivo" },
    include: { talle: true, color: true },
  }));
}));

export default router;
