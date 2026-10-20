import { Router } from "express";
import { verificarToken } from "../middleware/auth.js";
import { esAdmin } from "../middleware/es-admin.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validarCamposPermitidos } from "../utils/validate-compras.js";
import { ajustarInventario, ErrorInventario, historialInventarioVariante } from "../services/inventario.js";
import { ErrorPartidas } from "../services/partidas.js";

const router = Router();
router.use("/admin/inventario", verificarToken, esAdmin);

router.post("/admin/inventario/ajustes", asyncHandler(async (req, res) => {
  const error = validarCamposPermitidos(req.body, ["varianteId", "tipo", "cantidad", "motivo"],
    ["costoUnitario"]);
  if (error) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: error });
  const resultado = await ajustarInventario({
    varianteId: req.body.varianteId,
    tipo: req.body.tipo,
    cantidad: req.body.cantidad,
    motivo: req.body.motivo,
    costoUnitario: req.body.costoUnitario ?? null,
    actorUsuarioId: req.usuario.id,
  });
  return res.status(201).set("Cache-Control", "no-store").json(resultado);
}));

router.get("/admin/inventario/variantes/:id", asyncHandler(async (req, res) => {
  const varianteId = Number(req.params.id);
  const pagina = req.query.pagina === undefined ? 1 : Number(req.query.pagina);
  const limite = req.query.limite === undefined ? 20 : Number(req.query.limite);
  return res.set("Cache-Control", "no-store")
    .json(await historialInventarioVariante(varianteId, pagina, limite));
}));

router.use((error, req, res, next) => {
  if (!(error instanceof ErrorInventario) && !(error instanceof ErrorPartidas)) return next(error);
  const status = error.codigo === "ENTRADA_INVALIDA" ? 400
    : error.codigo === "VARIANTE_INVALIDA" ? 404 : 409;
  return res.status(status).set("Cache-Control", "no-store")
    .json({ codigo: error.codigo, message: error.message });
});

export default router;
