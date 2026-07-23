import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";

const router = Router();
const requiredFields = { valor: "string" };
const optionalFields = { orden: "number" };

router.get("/talles", asyncHandler(async (req, res) => {
  res.json(await prisma.talle.findMany());
}));

router.get("/talles/:id", asyncHandler(async (req, res) => {
  const talle = await prisma.talle.findUnique({ where: { id: Number(req.params.id) } });
  if (!talle) return res.status(404).json({ message: "Talle no encontrado" });
  res.json(talle);
}));

router.post("/talles", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields, optionalFields);
  if (error) return res.status(400).json({ message: error });
  const talle = await prisma.talle.create({ data: req.body });
  res.json({ message: "Talle creado", talle });
}));

router.delete("/talles/:id", asyncHandler(async (req, res, next) => {
  try {
    const talle = await prisma.talle.delete({ where: { id: Number(req.params.id) } });
    res.json(talle);
  } catch (error) {
    if (error.code === "P2003") {
      return res.status(409).json({ message: "No se puede eliminar: está en uso por productos existentes" });
    }
    next(error);
  }
}));

router.put("/talles/:id", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields, optionalFields);
  if (error) return res.status(400).json({ message: error });
  res.json(await prisma.talle.update({ where: { id: Number(req.params.id) }, data: req.body }));
}));

export default router;
