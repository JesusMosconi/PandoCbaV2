import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";
import { upload } from "../utils/upload.js";

const router = Router();

router.post("/img-producto/upload", upload.array("imagenes", 10), asyncHandler(async (req, res) => {
  const productoId = Number(req.body.productoId);
  if (!productoId) return res.status(400).json({ message: "El campo \"productoId\" es obligatorio" });
  if (!req.files?.length) return res.status(400).json({ message: "No se recibió ninguna imagen" });

  const producto = await prisma.producto.findUnique({ where: { id: productoId } });
  if (!producto) return res.status(404).json({ message: "Producto no encontrado" });

  const ultimo = await prisma.imgProducto.findFirst({
    where: { productoId },
    orderBy: { orden: "desc" },
  });
  let orden = (ultimo?.orden ?? 0) + 1;

  const creadas = [];
  for (const file of req.files) {
    creadas.push(
      await prisma.imgProducto.create({
        data: { url: file.path, orden: orden++, productoId },
      })
    );
  }

  res.status(201).json(creadas);
}));

router.get("/img-producto/:productoId", asyncHandler(async (req, res) => {
  const imagenes = await prisma.imgProducto.findMany({
    where: { productoId: Number(req.params.productoId) },
    orderBy: { orden: "asc" },
  });
  res.json(imagenes);
}));

router.post("/img-producto", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, { url: "string", orden: "number", productoId: "number" });
  if (error) return res.status(400).json({ message: error });
  res.json(await prisma.imgProducto.create({ data: req.body }));
}));

router.put("/img-producto/:id", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, { url: "string", orden: "number" });
  if (error) return res.status(400).json({ message: error });
  res.json(await prisma.imgProducto.update({
    where: { id: Number(req.params.id) },
    data: { url: req.body.url, orden: req.body.orden },
  }));
}));

router.delete("/img-producto/:id", asyncHandler(async (req, res) => {
  await prisma.imgProducto.delete({ where: { id: Number(req.params.id) } });
  res.json({ message: "ImgProducto eliminado" });
}));

export default router;
