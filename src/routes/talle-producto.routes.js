import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";
import { verificarToken } from "../middleware/auth.js";
import { esAdmin } from "../middleware/es-admin.js";
import {
  bloquearVariantes,
  compromisosEfectivos,
  horaBaseDatos,
  presentarVariantesConDisponibilidad,
} from "../services/inventario.js";

const router = Router();
const requerirAdmin = [verificarToken, esAdmin];
const requiredFields = {
  stock: "number",
  estado: "string",
  productoId: "number",
  talleId: "number",
  colorId: "number",
};

router.get("/talle-producto", asyncHandler(async (req, res) => {
  const { productoId } = req.query;
  const variantes = await prisma.talleProducto.findMany({
    where: { productoId: productoId ? Number(productoId) : undefined },
    include: { talle: true, color: true },
    orderBy: { id: "asc" },
  });
  res.json(await presentarVariantesConDisponibilidad(prisma, variantes));
}));

router.post("/talle-producto", ...requerirAdmin, asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields);
  if (error) return res.status(400).json({ message: error });
  const { stock, estado, productoId, talleId, colorId } = req.body;
  if (!Number.isInteger(stock) || stock < 0 || ![productoId, talleId, colorId].every(Number.isInteger)) {
    return res.status(400).json({ message: "Stock e identificadores deben ser enteros válidos" });
  }
  res.json(await prisma.talleProducto.create({
    data: { stock, estado, productoId, talleId, colorId },
    include: { talle: true, color: true },
  }));
}));

router.put("/talle-producto/:id", ...requerirAdmin, asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields);
  if (error) return res.status(400).json({ message: error });
  const id = Number(req.params.id);
  const { stock, estado, productoId, talleId, colorId } = req.body;
  if (!Number.isInteger(id) || !Number.isInteger(stock) || stock < 0
    || ![productoId, talleId, colorId].every(Number.isInteger)) {
    return res.status(400).json({ message: "Stock e identificadores deben ser enteros válidos" });
  }
  const resultado = await prisma.$transaction(async (tx) => {
    await bloquearVariantes(tx, [id]);
    const variante = await tx.talleProducto.findUnique({ where: { id } });
    if (!variante) return { status: 404, message: "Variante no encontrada" };
    const compromisos = await compromisosEfectivos(tx, [id], await horaBaseDatos(tx));
    if (stock < (compromisos.get(id) ?? 0)) {
      return { status: 409, message: "El stock físico no puede ser menor que las reservas vigentes" };
    }
    return { valor: await tx.talleProducto.update({
      where: { id }, data: { stock, estado, productoId, talleId, colorId },
      include: { talle: true, color: true },
    }) };
  });
  if (resultado.status) return res.status(resultado.status).json({ message: resultado.message });
  res.json((await presentarVariantesConDisponibilidad(prisma, [resultado.valor]))[0]);
}));

// Se desactiva la variante en lugar de borrarla porque puede estar referenciada por ItemCarrito.
router.delete("/talle-producto/:id", ...requerirAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
  const resultado = await prisma.$transaction(async (tx) => {
    await bloquearVariantes(tx, [id]);
    const variante = await tx.talleProducto.findUnique({ where: { id } });
    if (!variante) return { status: 404, message: "Variante no encontrada" };
    const compromisos = await compromisosEfectivos(tx, [id], await horaBaseDatos(tx));
    if ((compromisos.get(id) ?? 0) > 0) {
      return { status: 409, message: "La variante tiene reservas vigentes" };
    }
    return { valor: await tx.talleProducto.update({
      where: { id }, data: { stock: 0, estado: "inactivo" },
      include: { talle: true, color: true },
    }) };
  });
  if (resultado.status) return res.status(resultado.status).json({ message: resultado.message });
  res.json((await presentarVariantesConDisponibilidad(prisma, [resultado.valor]))[0]);
}));

export default router;
