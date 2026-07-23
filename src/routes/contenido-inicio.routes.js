import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";

const router = Router();
const requiredFields = { seccionNombre: "string" };
const optionalFields = {
  imagenUrl: "string",
  titulo: "string",
  textoPrincipal: "string",
  textBoton: "string",
  alineacionTexto: "string",
};

router.get("/contenido-inicio", asyncHandler(async (req, res) => {
  res.json(await prisma.contenidoInicio.findMany());
}));

router.get("/contenido-inicio/:id", asyncHandler(async (req, res) => {
  const contenido = await prisma.contenidoInicio.findUnique({ where: { id: Number(req.params.id) } });
  if (!contenido) return res.status(404).json({ message: "Contenido de inicio no encontrado" });
  res.json(contenido);
}));

router.post("/contenido-inicio", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields, optionalFields);
  if (error) return res.status(400).json({ message: error });
  res.json(await prisma.contenidoInicio.create({ data: req.body }));
}));

router.put("/contenido-inicio/:id", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields, optionalFields);
  if (error) return res.status(400).json({ message: error });
  res.json(await prisma.contenidoInicio.update({ where: { id: Number(req.params.id) }, data: req.body }));
}));

router.delete("/contenido-inicio/:id", asyncHandler(async (req, res) => {
  res.json(await prisma.contenidoInicio.delete({ where: { id: Number(req.params.id) } }));
}));

export default router;
