import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";
import { normalizarEmail } from "../utils/email.js";
import { tokenBajaDisponible, verificarTokenBaja } from "../utils/token-baja.js";
import { verificarToken } from "../middleware/auth.js";
import { esAdmin } from "../middleware/es-admin.js";
import { darDeBaja, ErrorSuscripcionActiva, suscribir } from "../services/suscripciones.js";
import { notificarSuscripcion } from "../services/notificaciones.js";

const router = Router();
const requerirAdmin = [verificarToken, esAdmin];

router.get("/suscripciones", ...requerirAdmin, asyncHandler(async (req, res) => {
  res.json(await prisma.suscripcion.findMany());
}));

router.post("/suscripciones", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, { email: "string" });
  if (error) return res.status(400).json({ message: error });

  const email = normalizarEmail(req.body.email);
  if (!email) return res.status(400).json({ message: "Ingresá un correo electrónico válido" });

  let resultado;
  try {
    resultado = await suscribir(email);
  } catch (errorSuscripcion) {
    if (errorSuscripcion instanceof ErrorSuscripcionActiva) {
      return res.status(409).json({ message: errorSuscripcion.message });
    }
    throw errorSuscripcion;
  }

  res.json(resultado.suscripcion);
  void notificarSuscripcion(resultado.suscripcion);
}));

// Pública a propósito: el token firmado del correo autoriza la baja de una sola suscripción.
router.post("/suscripciones/baja", asyncHandler(async (req, res) => {
  const error = validateBody(req.body, { token: "string" });
  if (error) return res.status(400).json({ message: error });

  if (!tokenBajaDisponible()) {
    return res.status(503).json({ message: "La baja no está disponible en este momento" });
  }
  const id = verificarTokenBaja(req.body.token);
  if (!id) return res.status(400).json({ message: "El enlace de baja no es válido" });

  await darDeBaja(id);
  res.json({ message: "Tu suscripción fue dada de baja" });
}));

router.delete("/suscripciones/:id", ...requerirAdmin, asyncHandler(async (req, res) => {
  const suscripcion = await prisma.suscripcion.update({
    where: { id: Number(req.params.id) },
    data: { activo: false },
  });
  res.json(suscripcion);
}));

export default router;
