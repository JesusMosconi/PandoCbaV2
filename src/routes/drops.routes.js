import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { contextoDrops } from "../services/drops.js";

const router = Router();

router.get("/drops/inicio", asyncHandler(async (req, res) => {
  const { activo, futuro } = await contextoDrops();
  res.set("Cache-Control", "no-store");
  if (activo) return res.json({ tipo: "activo", drop: {
    id: activo.id, nombre: activo.nombre, numeroDrop: activo.numeroDrop,
    imagenUrl: activo.imagenUrl, tituloInicio: activo.tituloInicio,
    textoBotonInicio: activo.textoBotonInicio, fechaLanzamiento: activo.fechaLanzamiento,
  }, urlColeccion: `/colecciones/${activo.id}` });
  if (futuro) return res.json({ tipo: "futuro", drop: {
    id: futuro.id, nombre: futuro.nombre, numeroDrop: futuro.numeroDrop,
    imagenUrl: futuro.imagenUrl, tituloInicio: futuro.tituloInicio,
    fechaLanzamiento: futuro.fechaLanzamiento,
  } });
  const marca = await prisma.configuracionPortadaInicio.findUnique({ where: { id: 1 } });
  if (!marca?.imagenUrl) {
    return res.status(503).json({ codigo: "CONFIGURACION_INCOMPLETA", message: "Falta configurar la portada de marca" });
  }
  return res.json({ tipo: "marca", marca: { imagenUrl: marca.imagenUrl } });
}));

router.get("/drops/categorias", asyncHandler(async (req, res) => {
  const { destacado, agotado, lanzados } = await contextoDrops();
  res.set("Cache-Control", "no-store").json({
    destacado: destacado ? { id: destacado.id, nombre: destacado.nombre,
      imagenUrl: destacado.imagenUrl, urlColeccion: `/colecciones/${destacado.id}`, agotado } : null,
    colecciones: lanzados.slice(0, 3).map((drop) => ({ id: drop.id, nombre: drop.nombre,
      fechaLanzamiento: drop.fechaLanzamiento, urlColeccion: `/colecciones/${drop.id}` })),
  });
}));

export default router;
