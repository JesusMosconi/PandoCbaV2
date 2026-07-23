import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";

const router = Router();
const requiredFields = { nombre: "string", hex: "string" };

router.get("/colors", asyncHandler(async (req, res) => {
  res.json(await prisma.color.findMany());
}));

router.get("/colors/:id", asyncHandler(async (req, res) => {
  const color = await prisma.color.findUnique({ where: { id: Number(req.params.id) } });
  if (!color) return res.status(404).json({ message: "Color no encontrado" });
  res.json(color);
}));

router.post("/colors", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields);
  if (error) return res.status(400).json({ message: error });
  const color = await prisma.color.create({ data: req.body });
  res.json({ message: "Color creado", color });
}));

router.delete("/colors/:id", asyncHandler(async (req, res, next) => {
  try {
    const color = await prisma.color.delete({ where: { id: Number(req.params.id) } });
    res.json(color);
  } catch (error) {
    if (error.code === "P2003") {
      return res.status(409).json({ message: "No se puede eliminar: está en uso por productos existentes" });
    }
    next(error);
  }
}));

router.put("/colors/:id", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields);
  if (error) return res.status(400).json({ message: error });
  res.json(await prisma.color.update({ where: { id: Number(req.params.id) }, data: req.body }));
}));

export default router;
