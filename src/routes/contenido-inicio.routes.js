import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";
import { upload } from "../utils/upload.js";
import { crearUrlImagen, eliminarImagenLocal } from "../utils/imagen-local.js";

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

router.post("/contenido-inicio/:id/imagen", upload.single("imagen"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const contenido = await prisma.contenidoInicio.findUnique({ where: { id } });

  if (!contenido) {
    if (req.file) await eliminarImagenLocal(req.file.path);
    return res.status(404).json({ message: "Contenido de inicio no encontrado" });
  }
  if (!req.file) return res.status(400).json({ message: "No se recibió ninguna imagen" });

  const imagenUrl = crearUrlImagen(req, req.file);

  try {
    const actualizado = await prisma.contenidoInicio.update({
      where: { id },
      data: { imagenUrl },
    });
    await eliminarImagenLocal(contenido.imagenUrl);
    res.json(actualizado);
  } catch (error) {
    await eliminarImagenLocal(imagenUrl);
    throw error;
  }
}));

router.delete("/contenido-inicio/:id/imagen", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const contenido = await prisma.contenidoInicio.findUnique({ where: { id } });
  if (!contenido) return res.status(404).json({ message: "Contenido de inicio no encontrado" });

  const actualizado = await prisma.contenidoInicio.update({
    where: { id },
    data: { imagenUrl: null },
  });
  await eliminarImagenLocal(contenido.imagenUrl);
  res.json(actualizado);
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
