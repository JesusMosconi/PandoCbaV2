import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";

const router = Router();

router.get("/colecciones", asyncHandler(async (req, res) => {
  res.json(await prisma.coleccion.findMany());
}));

//POST

router.post("/colecciones", asyncHandler(async (req, res) => {
  const { nombre } = req.body;
  const coleccion = await prisma.coleccion.create({
    data: {
      nombre,
    },
  });
  res.status(201).json(coleccion);
}));

//PUT

router.put("/colecciones/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { nombre } = req.body;
  const coleccion = await prisma.coleccion.update({
    where: { id: parseInt(id) },
    data: { nombre },
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
