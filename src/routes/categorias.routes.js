import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";

const router = Router();

router.get("/categorias", asyncHandler(async (req, res) => {
  res.json(await prisma.categoria.findMany());
}));

router.get("/categorias/:id", asyncHandler(async (req, res) => {
  const categoria = await prisma.categoria.findUnique({
    where: { id: Number(req.params.id) },
  });
  if (!categoria) return res.status(404).json({ message: "Categoría no encontrada" });
  res.json(categoria);
}));

//Post

router.post("/categorias", asyncHandler(async (req, res) => {
  const { nombre, imagenUrl } = req.body;
  const categoria = await prisma.categoria.create({
    data: {
      nombre,
      imagenUrl,
    },
  });
  res.status(201).json(categoria);
}));

//PUT

router.put("/categorias/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { nombre, imagenUrl } = req.body;
  const categoria = await prisma.categoria.update({
    where: { id: parseInt(id) },
    data: { nombre, imagenUrl },
  });
  res.json(categoria);
}));

//DELETE

router.delete("/categorias/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  await prisma.categoria.delete({
    where: { id: parseInt(id) },
  });
  res.status(204).send();
}));

export default router;
