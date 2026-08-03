import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { upload } from "../utils/upload.js";
import { crearUrlImagen, eliminarImagenLocal } from "../utils/imagen-local.js";

const router = Router();

router.get("/colecciones", asyncHandler(async (req, res) => {
  res.json(await prisma.coleccion.findMany());
}));

router.get("/colecciones/:id", asyncHandler(async (req, res) => {
  const coleccion = await prisma.coleccion.findUnique({ where: { id: Number(req.params.id) } });
  if (!coleccion) return res.status(404).json({ message: "Colección no encontrada" });
  res.json(coleccion);
}));

router.post("/colecciones/:id/imagen", upload.single("imagen"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const coleccion = await prisma.coleccion.findUnique({ where: { id } });

  if (!coleccion) {
    if (req.file) await eliminarImagenLocal(req.file.path);
    return res.status(404).json({ message: "Colección no encontrada" });
  }
  if (!req.file) return res.status(400).json({ message: "No se recibió ninguna imagen" });

  const imagenUrl = crearUrlImagen(req, req.file);

  try {
    const actualizada = await prisma.coleccion.update({
      where: { id },
      data: { imagenUrl },
    });
    await eliminarImagenLocal(coleccion.imagenUrl);
    res.json(actualizada);
  } catch (error) {
    await eliminarImagenLocal(imagenUrl);
    throw error;
  }
}));

router.delete("/colecciones/:id/imagen", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const coleccion = await prisma.coleccion.findUnique({ where: { id } });
  if (!coleccion) return res.status(404).json({ message: "Colección no encontrada" });

  const actualizada = await prisma.coleccion.update({
    where: { id },
    data: { imagenUrl: null },
  });
  await eliminarImagenLocal(coleccion.imagenUrl);
  res.json(actualizada);
}));

//POST

router.post("/colecciones", asyncHandler(async (req, res) => {
  const { nombre, imagenUrl, fechaLanzamiento, numeroDrop, contadorActivo } = req.body;
  const coleccion = await prisma.coleccion.create({
    data: {
      nombre,
      imagenUrl,
      fechaLanzamiento,
      numeroDrop,
      contadorActivo,
    },
  });
  res.status(201).json(coleccion);
}));

//PUT

router.put("/colecciones/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { nombre, imagenUrl, fechaLanzamiento, numeroDrop, contadorActivo } = req.body;
  const coleccion = await prisma.coleccion.update({
    where: { id: parseInt(id) },
    data: { nombre, imagenUrl, fechaLanzamiento, numeroDrop, contadorActivo },
  });
  res.json(coleccion);
}));

//DELETE

router.delete("/colecciones/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  await prisma.coleccion.delete({
    where: { id: parseInt(id) },
  });
  res.status(204).send();
}));

export default router;
