import { Router } from "express";
import { verificarToken } from "../middleware/auth.js";
import { esAdmin } from "../middleware/es-admin.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validarFecha, validarIdentificador } from "../utils/validate-compras.js";
import { ErrorInforme, historialProducto, informeComprasVentas } from "../services/informes.js";

const router = Router();
router.use("/admin", verificarToken, esAdmin);

function filtros(req) {
  const { desde, hasta } = req.query;
  if (validarFecha(desde, "desde") || validarFecha(hasta, "hasta") || desde > hasta) {
    throw new ErrorInforme(400, "FILTROS_INVALIDOS", "Indicá un período válido");
  }
  const resultado = { desde, hasta };
  for (const campo of ["productoId", "varianteId", "proveedorId", "pagina", "limite"]) {
    if (req.query[campo] === undefined) continue;
    if (validarIdentificador(req.query[campo], campo)) {
      throw new ErrorInforme(400, "FILTROS_INVALIDOS", `El filtro ${campo} debe ser positivo`);
    }
    resultado[campo] = Number(req.query[campo]);
  }
  if (resultado.limite > 100) throw new ErrorInforme(400, "FILTROS_INVALIDOS", "El límite máximo es 100");
  return resultado;
}

router.get("/admin/informes/compras-ventas", asyncHandler(async (req, res) => {
  const resultado = await informeComprasVentas(filtros(req));
  res.set("Cache-Control", "no-store").json(resultado);
}));

router.get("/admin/productos/:id/historial", asyncHandler(async (req, res) => {
  if (validarIdentificador(req.params.id)) {
    return res.status(400).json({ codigo: "FILTROS_INVALIDOS", message: "Producto inválido" });
  }
  const resultado = await historialProducto(Number(req.params.id), filtros(req));
  res.set("Cache-Control", "no-store").json(resultado);
}));

router.use((error, req, res, next) => {
  if (!(error instanceof ErrorInforme)) return next(error);
  return res.status(error.status).set("Cache-Control", "no-store")
    .json({ codigo: error.codigo, message: error.message });
});

export default router;
