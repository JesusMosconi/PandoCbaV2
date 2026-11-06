import { Router } from "express";
import { verificarToken } from "../middleware/auth.js";
import { esAdmin } from "../middleware/es-admin.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validarFecha, validarIdentificador } from "../utils/validate-compras.js";
import { ErrorCaja, cerrarCaja, listarCajas } from "../services/caja.js";
import { CANALES, METODOS_PAGO, listarVentas, resumenPorCanal } from "../services/ventas-canal.js";

const router = Router();
router.use(["/admin/ventas", "/admin/cajas"], verificarToken, esAdmin);

class ErrorFiltro extends Error {
  constructor(message) {
    super(message);
    this.codigo = "FILTROS_INVALIDOS";
  }
}

const sinCache = (res) => res.set("Cache-Control", "no-store");

function periodo(query, obligatorio) {
  const { desde, hasta } = query;
  if (!obligatorio && !desde && !hasta) return {};
  for (const [valor, campo] of [[desde, "desde"], [hasta, "hasta"]]) {
    if ((obligatorio || valor) && validarFecha(valor, campo)) throw new ErrorFiltro(validarFecha(valor, campo));
  }
  if (desde && hasta && desde > hasta) throw new ErrorFiltro("Indicá un período válido");
  return { desde: desde || undefined, hasta: hasta || undefined };
}

function paginacion(query, limiteMaximo = 100) {
  const resultado = {};
  for (const campo of ["pagina", "limite"]) {
    if (query[campo] === undefined) continue;
    if (validarIdentificador(query[campo], campo)) throw new ErrorFiltro(`El filtro ${campo} debe ser positivo`);
    resultado[campo] = Number(query[campo]);
  }
  if (resultado.limite > limiteMaximo) throw new ErrorFiltro(`El límite máximo es ${limiteMaximo}`);
  return resultado;
}

function opcion(valor, permitidos, campo) {
  if (valor === undefined || valor === "") return undefined;
  if (!permitidos.includes(valor)) throw new ErrorFiltro(`El filtro ${campo} no es válido`);
  return valor;
}

router.get("/admin/ventas/resumen", asyncHandler(async (req, res) => {
  const { desde, hasta } = periodo(req.query, true);
  sinCache(res).json(await resumenPorCanal(desde, hasta));
}));

router.get("/admin/ventas", asyncHandler(async (req, res) => {
  sinCache(res).json(await listarVentas({
    ...periodo(req.query, false),
    ...paginacion(req.query),
    canal: opcion(req.query.canal, CANALES, "canal"),
    metodoPago: opcion(req.query.metodoPago, METODOS_PAGO, "metodoPago"),
  }));
}));

router.get("/admin/cajas", asyncHandler(async (req, res) => {
  sinCache(res).json(await listarCajas(paginacion(req.query, 50)));
}));

// Cierre de respaldo: mismo contrato que el del vendedor.
router.post("/admin/cajas/:id/cierre", asyncHandler(async (req, res) => {
  if (validarIdentificador(req.params.id)) throw new ErrorCaja(400, "CAJA_INVALIDA", "Caja inválida");
  const { efectivoDeclarado, observacion } = req.body ?? {};
  sinCache(res).json(await cerrarCaja(req.usuario.id, Number(req.params.id), { efectivoDeclarado, observacion }));
}));

router.use((error, req, res, next) => {
  if (error instanceof ErrorFiltro) {
    return sinCache(res).status(400).json({ codigo: error.codigo, message: error.message });
  }
  if (!(error instanceof ErrorCaja)) return next(error);
  const { status, codigo, message, name, stack, ...detalles } = error;
  return sinCache(res).status(status).json({ message, codigo, ...detalles });
});

export default router;
