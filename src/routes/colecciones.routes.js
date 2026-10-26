import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { upload } from "../utils/upload.js";
import { crearUrlImagen, eliminarImagenLocal } from "../utils/imagen-local.js";
import { verificarToken } from "../middleware/auth.js";
import { esAdmin } from "../middleware/es-admin.js";
import { validarIdentificador } from "../utils/validate-compras.js";
import { datosDrop, validarDatos, validarProgramacion } from "./admin-drops.routes.js";

const router = Router();
const requerirAdmin = [verificarToken, esAdmin];

router.get("/colecciones", asyncHandler(async (req, res) => {
  res.json(await prisma.coleccion.findMany());
}));

router.get("/colecciones/:id", asyncHandler(async (req, res) => {
  if (validarIdentificador(req.params.id)) return res.status(400).json({ message: "Identificador inválido" });
  const coleccion = await prisma.coleccion.findUnique({ where: { id: Number(req.params.id) } });
  if (!coleccion?.fechaActivacion) return res.status(404).json({ message: "Colección no disponible" });
  res.json(coleccion);
}));

router.post("/colecciones/:id/imagen", ...requerirAdmin, upload.single("imagen"), asyncHandler(async (req, res) => {
  if (validarIdentificador(req.params.id)) {
    if (req.file) await eliminarImagenLocal(req.file.path);
    return res.status(400).json({ message: "Identificador inválido" });
  }
  const id = Number(req.params.id);
  const coleccion = await prisma.coleccion.findUnique({ where: { id } });

  if (!coleccion) {
    if (req.file) await eliminarImagenLocal(req.file.path);
    return res.status(404).json({ message: "Colección no encontrada" });
  }
  if (!coleccion.activo) {
    if (req.file) await eliminarImagenLocal(req.file.path);
    return res.status(409).json({ message: "El drop está retirado" });
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

router.delete("/colecciones/:id/imagen", ...requerirAdmin, asyncHandler(async (req, res) => {
  if (validarIdentificador(req.params.id)) return res.status(400).json({ message: "Identificador inválido" });
  const id = Number(req.params.id);
  const coleccion = await prisma.coleccion.findUnique({ where: { id } });
  if (!coleccion) return res.status(404).json({ message: "Colección no encontrada" });
  if (coleccion.fechaLanzamiento) return res.status(409).json({ message: "No se puede dejar sin portada un drop programado" });

  const actualizada = await prisma.coleccion.update({
    where: { id },
    data: { imagenUrl: null },
  });
  await eliminarImagenLocal(coleccion.imagenUrl);
  res.json(actualizada);
}));

//POST

router.post("/colecciones", ...requerirAdmin, asyncHandler(async (req, res) => {
  const error = validarDatos(req.body, true);
  if (error) return res.status(400).json({ message: error });
  const data = datosDrop(req.body);
  const conflicto = validarProgramacion(data);
  if (conflicto) return res.status(400).json({ message: conflicto });
  const coleccion = await prisma.coleccion.create({ data });
  res.status(201).json(coleccion);
}));

//PUT

router.put("/colecciones/:id", ...requerirAdmin, asyncHandler(async (req, res) => {
  if (validarIdentificador(req.params.id)) return res.status(400).json({ message: "Identificador inválido" });
  const actual = await prisma.coleccion.findUnique({ where: { id: Number(req.params.id) } });
  if (!actual) return res.status(404).json({ message: "Colección no encontrada" });
  if (!actual.activo || actual.fechaCierre || (actual.fechaFinalizacion && actual.fechaFinalizacion <= new Date())) return res.status(409).json({ message: "El drop ya fue retirado o finalizado" });
  const error = validarDatos(req.body);
  if (error) return res.status(400).json({ message: error });
  const data = datosDrop(req.body);
  const conflicto = validarProgramacion({ ...actual, ...data });
  if (conflicto) return res.status(400).json({ message: conflicto });
  if (actual.fechaActivacion && Object.hasOwn(data, "fechaLanzamiento") && data.fechaLanzamiento?.getTime() !== actual.fechaLanzamiento?.getTime()) return res.status(409).json({ message: "No se puede cambiar el lanzamiento de un drop ya activado" });
  const coleccion = await prisma.coleccion.update({
    where: { id: actual.id }, data,
  });
  res.json(coleccion);
}));

//DELETE

router.delete("/colecciones/:id", ...requerirAdmin, asyncHandler(async (req, res) => {
  if (validarIdentificador(req.params.id)) return res.status(400).json({ message: "Identificador inválido" });
  const actual = await prisma.coleccion.findUnique({ where: { id: Number(req.params.id) } });
  if (!actual) return res.status(404).json({ message: "Colección no encontrada" });
  if (actual.activo) await prisma.coleccion.update({ where: { id: actual.id }, data: { activo: false } });
  res.status(204).send();
}));

export default router;
