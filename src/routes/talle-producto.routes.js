import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";

const router = Router();
const requiredFields = {
  stock: "number",
  estado: "string",
  productoId: "number",
  talleId: "number",
  colorId: "number",
};

router.get("/talle-producto", asyncHandler(async (req, res) => {
  res.json(await prisma.talleProducto.findMany());
}));

router.post("/talle-producto", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields);
  if (error) return res.status(400).json({ message: error });
  res.json(await prisma.talleProducto.create({ data: req.body }));
}));

router.put("/talle-producto/:id", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields);
  if (error) return res.status(400).json({ message: error });
  res.json(await prisma.talleProducto.update({ where: { id: Number(req.params.id) }, data: req.body }));
}));

export default router;
