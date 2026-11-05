import { Router } from "express";
import { verificarToken } from "../middleware/auth.js";
import { esCliente } from "../middleware/es-cliente.js";
import { esAdmin } from "../middleware/es-admin.js";
import { revisarDomicilio, decidirReintegroEnvio, iniciarReintegroSimulado, completarReintegroSimulado, resolverIncidenciaSimulada } from "../services/administracion-pagos.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";
import prisma from "../db.js";
import { iniciarPago, estadoPagoOrden, conciliarIntento, ErrorPago } from "../services/pagos.js";
import { ErrorMercadoPago } from "../services/mercado-pago.js";

const router = Router();
router.use(["/ordenes/:id/pagos", "/ordenes/:id/pago"], verificarToken, esCliente);
const idPositivo = (valor) => /^\d+$/.test(valor) && Number.isSafeInteger(Number(valor)) && Number(valor) > 0 ? Number(valor) : null;
router.post("/ordenes/:id/pagos", asyncHandler(async (req, res) => {
  const id = idPositivo(req.params.id);
  if (!id) return res.status(400).json({ codigo: "ID_INVALIDO", message: "ID de orden inválido" });
  const entradaInvalida = validateBody(req.body ?? {}, {});
  if (entradaInvalida || Object.keys(req.body ?? {}).length) {
    return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: "El inicio de pago no acepta importes del navegador" });
  }
  res.set("Cache-Control", "no-store").json(await iniciarPago(req.usuario.id, id));
}));
router.get("/ordenes/:id/pago", asyncHandler(async (req, res) => {
  const id = idPositivo(req.params.id);
  if (!id) return res.status(400).json({ codigo: "ID_INVALIDO", message: "ID de orden inválido" });
  const actual = await estadoPagoOrden(req.usuario.id, id);
  if (actual.esDemostracion && actual.estadoPago === "pendiente") {
    const intento = await prisma.intentoPago.findFirst({ where: { ordenId: id }, orderBy: { id: "desc" } });
    if (intento && (!intento.ultimoChequeoEn || Date.now() - intento.ultimoChequeoEn.getTime() > 15000)) {
      try { await conciliarIntento(intento.id); } catch (causa) {
        if (!(causa instanceof ErrorPago) && !(causa instanceof ErrorMercadoPago)) throw causa;
      }
    }
  }
  res.set("Cache-Control", "no-store").json(await estadoPagoOrden(req.usuario.id, id));
}));
router.use(["/admin/ordenes/:id/revision-domicilio", "/admin/ordenes/:id/reintegro-envio",
  "/admin/ordenes/:id/reintegros-pago/:reintegroId", "/admin/ordenes/:id/reintegros-pago/:reintegroId/inicio",
  "/admin/ordenes/:id/incidencias/:incidenciaId/resolucion"], verificarToken, esAdmin);
router.post("/admin/ordenes/:id/revision-domicilio", asyncHandler(async (req, res) => {
  const id = idPositivo(req.params.id);
  if (!id) return res.status(400).json({ message: "ID inválido" });
  res.set("Cache-Control", "no-store").json(await revisarDomicilio(id, req.usuario.id));
}));
router.post("/admin/ordenes/:id/reintegro-envio", asyncHandler(async (req, res) => {
  const id = idPositivo(req.params.id);
  const error = validateBody(req.body, { motivo: "string" });
  if (!id || error) return res.status(400).json({ message: error ?? "ID inválido" });
  res.set("Cache-Control", "no-store").json(await decidirReintegroEnvio(id, req.usuario.id, req.body.motivo));
}));
router.post("/admin/ordenes/:id/reintegros-pago/:reintegroId/inicio", asyncHandler(async (req, res) => {
  const id = idPositivo(req.params.id), reintegroId = idPositivo(req.params.reintegroId);
  const error = validateBody(req.body ?? {}, {});
  if (!id || !reintegroId || error || Object.keys(req.body ?? {}).length) return res.status(400).json({ message: error ?? "Entrada inválida" });
  res.set("Cache-Control", "no-store").json(await iniciarReintegroSimulado(id, reintegroId, req.usuario.id));
}));
router.post("/admin/ordenes/:id/reintegros-pago/:reintegroId", asyncHandler(async (req, res) => {
  const id = idPositivo(req.params.id), reintegroId = idPositivo(req.params.reintegroId);
  const error = validateBody(req.body, { referenciaExterna: "string", resultado: "string" });
  if (!id || !reintegroId || error) return res.status(400).json({ message: error ?? "ID inválido" });
  res.set("Cache-Control", "no-store").json(await completarReintegroSimulado(id, reintegroId, req.usuario.id, req.body.referenciaExterna, req.body.resultado));
}));
router.post("/admin/ordenes/:id/incidencias/:incidenciaId/resolucion", asyncHandler(async (req, res) => {
  const id = idPositivo(req.params.id), incidenciaId = idPositivo(req.params.incidenciaId);
  const error = validateBody(req.body, { motivo: "string", constancia: "string" });
  if (!id || !incidenciaId || error) return res.status(400).json({ message: error ?? "ID inválido" });
  res.set("Cache-Control", "no-store").json(await resolverIncidenciaSimulada(id, incidenciaId, req.usuario.id, req.body.motivo, req.body.constancia));
}));
router.use((causa, req, res, next) => {
  if (!(causa instanceof ErrorPago) && !(causa instanceof ErrorMercadoPago)) return next(causa);
  res.status(causa.status).set("Cache-Control", "no-store").json({ codigo: causa.codigo, message: causa.message });
});
export default router;
