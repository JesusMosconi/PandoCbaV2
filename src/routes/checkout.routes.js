import { Router } from "express";
import { verificarToken } from "../middleware/auth.js";
import { esCliente } from "../middleware/es-cliente.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";
import {
  confirmarCheckout,
  ErrorConfirmacionCheckout,
  ErrorDatosCheckout,
  resumenCheckout,
} from "../services/checkout.js";

const router = Router();
router.use("/checkout", verificarToken, esCliente);

function responderErrorCheckout(error, res, next) {
  if (!(error instanceof ErrorDatosCheckout) && !(error instanceof ErrorConfirmacionCheckout)) {
    return next(error);
  }
  return res.status(error.status).json({
    message: error.message,
    codigo: error.codigo,
    ...(error.camposInvalidos ? { camposInvalidos: error.camposInvalidos } : {}),
    ...(error.itemsAfectados ? { itemsAfectados: error.itemsAfectados } : {}),
    ...(error.resumen ? { resumen: error.resumen } : {}),
  });
}

router.post("/checkout/resumen", asyncHandler(async (req, res, next) => {
  const error = validateBody(req.body, { tipoEntrega: "string" });
  if (error) return res.status(400).json({ message: error, codigo: "ENTRADA_INVALIDA" });
  try {
    res.set("Cache-Control", "no-store").json(await resumenCheckout(req.usuario.id, req.body));
  } catch (causa) {
    return responderErrorCheckout(causa, res, next);
  }
}));

router.post("/checkout/confirmacion", asyncHandler(async (req, res, next) => {
  const error = validateBody(req.body, {
    tipoEntrega: "string",
    huellaResumen: "string",
    claveConfirmacion: "string",
    aceptaPrecioVigente: "boolean",
  });
  if (error) return res.status(400).json({ message: error, codigo: "ENTRADA_INVALIDA" });
  try {
    const resultado = await confirmarCheckout(req.usuario.id, req.body);
    res.status(resultado.creada ? 201 : 200).set("Cache-Control", "no-store").json(resultado.orden);
  } catch (causa) {
    return responderErrorCheckout(causa, res, next);
  }
}));

export default router;
