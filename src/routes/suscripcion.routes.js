import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";

const router = Router();

router.get("/suscripciones", asyncHandler(async (req, res) => {
  res.json(await prisma.suscripcion.findMany());
}));

router.post("/suscripciones", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, { email: "string" });
  if (error) return res.status(400).json({ message: error });

  const existente = await prisma.suscripcion.findUnique({ where: { email: req.body.email } });
  if (existente) return res.status(409).json({ message: "Ya existe una suscripción con este email" });

  res.json(await prisma.suscripcion.create({ data: { email: req.body.email } }));
}));

router.delete("/suscripciones/:id", asyncHandler(async (req, res) => {
  const suscripcion = await prisma.suscripcion.update({
    where: { id: Number(req.params.id) },
    data: { activo: false },
  });
  res.json(suscripcion);
}));

export default router;
