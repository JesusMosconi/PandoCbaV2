import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { upload } from "../utils/upload.js";
import { crearUrlImagen, eliminarImagenLocal } from "../utils/imagen-local.js";

const router = Router();

router.get("/imagenes-nosotros", asyncHandler(async (req, res) => {
  res.json(await prisma.imagenNosotros.findMany({ orderBy: { orden: "asc" } }));
}));

router.post("/imagenes-nosotros/:id/imagen", upload.single("imagen"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const imagen = await prisma.imagenNosotros.findUnique({ where: { id } });

  if (!imagen) {
    if (req.file) await eliminarImagenLocal(`/uploads/${req.file.filename}`);
    return res.status(404).json({ message: "Imagen de Nosotros no encontrada" });
  }
  if (!req.file) return res.status(400).json({ message: "No se recibió ninguna imagen" });

  const imagenUrl = crearUrlImagen(req, req.file.filename);

  try {
    const actualizada = await prisma.imagenNosotros.update({
      where: { id },
      data: { imagenUrl },
    });
    await eliminarImagenLocal(imagen.imagenUrl);
    res.json(actualizada);
  } catch (error) {
    await eliminarImagenLocal(imagenUrl);
    throw error;
  }
}));

router.delete("/imagenes-nosotros/:id/imagen", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const imagen = await prisma.imagenNosotros.findUnique({ where: { id } });
  if (!imagen) return res.status(404).json({ message: "Imagen de Nosotros no encontrada" });

  const actualizada = await prisma.imagenNosotros.update({
    where: { id },
    data: { imagenUrl: null },
  });
  await eliminarImagenLocal(imagen.imagenUrl);
  res.json(actualizada);
}));

export default router;
