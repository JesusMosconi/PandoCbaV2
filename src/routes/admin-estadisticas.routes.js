import { Router } from "express";
import { verificarToken } from "../middleware/auth.js";
import { esAdmin } from "../middleware/es-admin.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validarIdentificador } from "../utils/validate-compras.js";
import {
  ErrorEstadistica, estadisticasProducto, filtrosEstadisticas, pendientesInicio, rankingProductos, resumenInicio,
} from "../services/estadisticas.js";

const router = Router();
router.use("/admin/estadisticas", verificarToken, esAdmin);

router.get("/admin/estadisticas/inicio", asyncHandler(async (req, res) => {
  const resultado = await resumenInicio(filtrosEstadisticas(req.query, { canal: false }));
  res.set("Cache-Control", "no-store").json(resultado);
}));

router.get("/admin/estadisticas/pendientes", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store").json(await pendientesInicio());
}));

router.get("/admin/estadisticas/ranking", asyncHandler(async (req, res) => {
  const resultado = await rankingProductos(filtrosEstadisticas(req.query, { ranking: true }));
  res.set("Cache-Control", "no-store").json(resultado);
}));

router.get("/admin/estadisticas/productos/:id", asyncHandler(async (req, res) => {
  if (validarIdentificador(req.params.id)) {
    throw new ErrorEstadistica(400, "FILTROS_INVALIDOS", "Producto inválido");
  }
  const resultado = await estadisticasProducto(Number(req.params.id), filtrosEstadisticas(req.query));
  res.set("Cache-Control", "no-store").json(resultado);
}));

router.use((error, req, res, next) => {
  if (!(error instanceof ErrorEstadistica)) return next(error);
  return res.status(error.status).set("Cache-Control", "no-store")
    .json({ codigo: error.codigo, message: error.message });
});

export default router;
