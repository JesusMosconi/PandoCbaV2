import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";

const router = Router();

router.get("/colecciones", asyncHandler(async (req, res) => {
  res.json(await prisma.coleccion.findMany());
}));

router.get("/colecciones/:id", asyncHandler(async (req, res) => {
  const coleccion = await prisma.coleccion.findUnique({ where: { id: Number(req.params.id) } });
  if (!coleccion) return res.status(404).json({ message: "Colección no encontrada" });
  res.json(coleccion);
}));

//POST

router.post("/colecciones", asyncHandler(async (req, res) => {
  const { nombre, imagenUrl } = req.body;
  const coleccion = await prisma.coleccion.create({
    data: {
      nombre,
      imagenUrl,
    },
  });
  res.status(201).json(coleccion);
}));

//PUT

router.put("/colecciones/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { nombre, imagenUrl } = req.body;
  const coleccion = await prisma.coleccion.update({
    where: { id: parseInt(id) },
    data: { nombre, imagenUrl },
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
