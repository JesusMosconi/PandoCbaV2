import { Router } from "express";
import { verificarToken } from "../middleware/auth.js";
import { esCliente } from "../middleware/es-cliente.js";
import { asyncHandler } from "../utils/async-handler.js";
import { cancelarOrdenCliente, listarOrdenesCliente, obtenerOrdenCliente } from "../services/ordenes.js";

const router = Router();
router.use("/ordenes", verificarToken, esCliente);

function idOrden(valor) {
  const id = Number(valor);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

router.get("/ordenes", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store").json(await listarOrdenesCliente(req.usuario.id));
}));

router.get("/ordenes/:id", asyncHandler(async (req, res) => {
  const id = idOrden(req.params.id);
  if (!id) return res.status(400).json({ message: "ID de orden inválido", codigo: "ID_INVALIDO" });
  const orden = await obtenerOrdenCliente(req.usuario.id, id);
  if (!orden) return res.status(404).json({ message: "Orden no encontrada", codigo: "ORDEN_NO_ENCONTRADA" });
  res.set("Cache-Control", "no-store").json(orden);
}));

router.post("/ordenes/:id/cancelacion", asyncHandler(async (req, res) => {
  const id = idOrden(req.params.id);
  if (!id) return res.status(400).json({ message: "ID de orden inválido", codigo: "ID_INVALIDO" });
  const resultado = await cancelarOrdenCliente(req.usuario.id, id);
  res.status(resultado.status).set("Cache-Control", "no-store").json(
    resultado.status === 200 ? resultado.orden : {
      message: resultado.message,
      codigo: resultado.status === 404 ? "ORDEN_NO_ENCONTRADA" : "CANCELACION_NO_PERMITIDA",
      estadoActual: resultado.orden?.estado ?? null,
      orden: resultado.orden ?? null,
    },
  );
}));

export default router;
