import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";

const router = Router();

router.get("/categorias", asyncHandler(async (req, res) => {
  res.json(await prisma.categoria.findMany());
}));

//Post

router.post("/categorias", asyncHandler(async (req, res) => {
  const { nombre } = req.body;
  const categoria = await prisma.categoria.create({
    data: {
      nombre,
    },
  });
  res.status(201).json(categoria);
}));

//PUT

router.put("/categorias/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { nombre } = req.body;
  const categoria = await prisma.categoria.update({
    where: { id: parseInt(id) },
    data: { nombre },
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
