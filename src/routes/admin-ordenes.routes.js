import { Router } from "express";
import { verificarToken } from "../middleware/auth.js";
import { esAdmin } from "../middleware/es-admin.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";
import {
  cancelarOrdenAdmin,
  cambiarEstadoAdmin,
  confirmarPagoAdmin,
  listarOrdenesAdmin,
  obtenerOrdenAdmin,
} from "../services/ordenes.js";

const router = Router();
router.use("/admin/ordenes", verificarToken, esAdmin);

const estados = new Set([
  "pendiente_pago", "pago_confirmado", "en_preparacion", "lista_para_retiro",
  "enviada", "entregada", "cancelada_cliente", "cancelada_admin", "cancelada_vencimiento",
]);
const destinos = new Set(["en_preparacion", "lista_para_retiro", "enviada", "entregada"]);
const idPositivo = (valor) => {
  const id = Number(valor);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

function responder(resultado, res) {
  return res.status(resultado.status).set("Cache-Control", "no-store").json(
    resultado.status === 200 ? resultado.orden : {
      message: resultado.message,
      codigo: resultado.status === 404 ? "ORDEN_NO_ENCONTRADA"
        : resultado.status === 400 ? "ENTRADA_INVALIDA" : "TRANSICION_NO_PERMITIDA",
      estadoActual: resultado.orden?.estado ?? null,
      orden: resultado.orden ?? null,
    },
  );
}

router.get("/admin/ordenes", asyncHandler(async (req, res) => {
  const { estado, tipoEntrega } = req.query;
  if (estado && (typeof estado !== "string" || !estados.has(estado))) {
    return res.status(400).json({ message: "Filtro de estado inválido" });
  }
  if (tipoEntrega && !["retiro", "envio"].includes(tipoEntrega)) {
    return res.status(400).json({ message: "Filtro de entrega inválido" });
  }
  const pagina = req.query.pagina === undefined ? 1 : idPositivo(req.query.pagina);
  const limite = req.query.limite === undefined ? 20 : idPositivo(req.query.limite);
  if (!pagina || !limite || limite > 100) {
    return res.status(400).json({ message: "Paginación inválida" });
  }
  res.set("Cache-Control", "no-store").json(await listarOrdenesAdmin({ estado, tipoEntrega, pagina, limite }));
}));

router.get("/admin/ordenes/:id", asyncHandler(async (req, res) => {
  const id = idPositivo(req.params.id);
  if (!id) return res.status(400).json({ message: "ID inválido" });
  const orden = await obtenerOrdenAdmin(id);
  if (!orden) return res.status(404).json({ message: "Orden no encontrada" });
  res.set("Cache-Control", "no-store").json(orden);
}));

router.post("/admin/ordenes/:id/pago", asyncHandler(async (req, res) => {
  const id = idPositivo(req.params.id);
  if (!id) return res.status(400).json({ message: "ID inválido" });
  const error = validateBody(req.body ?? {}, {});
  if (error) return res.status(400).json({ message: error });
  return responder(await confirmarPagoAdmin(id, req.usuario.id), res);
}));

router.patch("/admin/ordenes/:id/estado", asyncHandler(async (req, res) => {
  const id = idPositivo(req.params.id);
  if (!id) return res.status(400).json({ message: "ID inválido" });
  const error = validateBody(req.body, { estado: "string" }, { envioCoordinado: "boolean" });
  if (error) return res.status(400).json({ message: error });
  if (!destinos.has(req.body.estado)) return res.status(400).json({ message: "Estado de destino inválido" });
  return responder(await cambiarEstadoAdmin(id, req.usuario.id, req.body.estado, req.body.envioCoordinado), res);
}));

router.post("/admin/ordenes/:id/cancelacion", asyncHandler(async (req, res) => {
  const id = idPositivo(req.params.id);
  if (!id) return res.status(400).json({ message: "ID inválido" });
  const error = validateBody(req.body, { motivo: "string" }, { restituirStock: "boolean" });
  if (error) return res.status(400).json({ message: error });
  return responder(await cancelarOrdenAdmin(id, req.usuario.id, req.body.motivo, req.body.restituirStock), res);
}));

export default router;
