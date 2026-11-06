import { Router } from "express";
import { verificarToken } from "../middleware/auth.js";
import { esVendedor } from "../middleware/es-vendedor.js";
import { asyncHandler } from "../utils/async-handler.js";
import { ErrorCaja, abrirCaja, cerrarCaja, obtenerCajaActual } from "../services/caja.js";
import {
  ErrorVentaLocal, actualizarItem, agregarItem, agregarVentaRapida, buscarProductosLocal, confirmarVentaLocal,
  listarVentasLocal, obtenerVentaEnCurso, obtenerVentaLocal, quitarItem, resumenVentaLocal, vaciarVenta,
} from "../services/venta-local.js";
import prisma from "../db.js";

const router = Router();
router.use("/vendedor", verificarToken, esVendedor);

const sinCache = (res) => res.set("Cache-Control", "no-store");

function enteroPositivo(valor) {
  const numero = typeof valor === "number" ? valor : Number(valor);
  return Number.isSafeInteger(numero) && numero > 0 ? numero : null;
}

function paginacion(query, limiteMaximo = 50) {
  const pagina = query.pagina === undefined ? 1 : enteroPositivo(query.pagina);
  const limite = query.limite === undefined ? 20 : enteroPositivo(query.limite);
  if (!pagina || !limite || limite > limiteMaximo) {
    throw new ErrorVentaLocal(400, "FILTROS_INVALIDOS", `Paginación inválida (límite máximo ${limiteMaximo})`);
  }
  return { pagina, limite };
}

function dia(valor, campo) {
  if (valor === undefined || valor === "") return undefined;
  if (typeof valor !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(valor) || Number.isNaN(Date.parse(`${valor}T00:00:00Z`))) {
    throw new ErrorVentaLocal(400, "FILTROS_INVALIDOS", `La fecha ${campo} debe tener formato AAAA-MM-DD`);
  }
  return valor;
}

// Catálogo
router.get("/vendedor/productos", asyncHandler(async (req, res) => {
  const { pagina, limite } = paginacion({ ...req.query, limite: req.query.limite ?? "24" });
  const categoriaId = req.query.categoria ? enteroPositivo(req.query.categoria) : null;
  if (req.query.categoria && !categoriaId) throw new ErrorVentaLocal(400, "FILTROS_INVALIDOS", "Categoría inválida");
  const buscar = typeof req.query.buscar === "string" ? req.query.buscar.slice(0, 100) : "";
  sinCache(res).json(await buscarProductosLocal({ buscar, categoriaId, pagina, limite }));
}));

// Venta en curso
router.get("/vendedor/venta", asyncHandler(async (req, res) => {
  sinCache(res).json(await obtenerVentaEnCurso(req.usuario.id));
}));

router.delete("/vendedor/venta", asyncHandler(async (req, res) => {
  sinCache(res).json(await vaciarVenta(req.usuario.id));
}));

router.post("/vendedor/venta/items", asyncHandler(async (req, res) => {
  const talleProductoId = enteroPositivo(req.body?.talleProductoId);
  const cantidad = enteroPositivo(req.body?.cantidad);
  if (!talleProductoId || !cantidad || typeof req.body.talleProductoId !== "number" || typeof req.body.cantidad !== "number") {
    throw new ErrorVentaLocal(400, "ENTRADA_INVALIDA", "La variante y la cantidad deben ser números enteros positivos");
  }
  sinCache(res).status(201).json(await agregarItem(req.usuario.id, { talleProductoId, cantidad }));
}));

router.post("/vendedor/venta/rapida", asyncHandler(async (req, res) => {
  const { concepto, importe, cantidad } = req.body ?? {};
  sinCache(res).status(201).json(await agregarVentaRapida(req.usuario.id, {
    concepto, importe, ...(cantidad === undefined ? {} : { cantidad }),
  }));
}));

router.put("/vendedor/venta/items/:id", asyncHandler(async (req, res) => {
  const id = enteroPositivo(req.params.id);
  const cantidad = typeof req.body?.cantidad === "number" ? enteroPositivo(req.body.cantidad) : null;
  if (!id || !cantidad) throw new ErrorVentaLocal(400, "ENTRADA_INVALIDA", "La cantidad debe ser un número entero positivo");
  sinCache(res).json(await actualizarItem(req.usuario.id, id, cantidad));
}));

router.delete("/vendedor/venta/items/:id", asyncHandler(async (req, res) => {
  const id = enteroPositivo(req.params.id);
  if (!id) throw new ErrorVentaLocal(400, "ENTRADA_INVALIDA", "Línea inválida");
  sinCache(res).json(await quitarItem(req.usuario.id, id));
}));

router.post("/vendedor/venta/resumen", asyncHandler(async (req, res) => {
  sinCache(res).json(await resumenVentaLocal(prisma, req.usuario.id));
}));

router.post("/vendedor/venta/confirmacion", asyncHandler(async (req, res) => {
  const { claveConfirmacion, huellaResumen, nombreCliente, telefonoCliente, metodoPago } = req.body ?? {};
  const resultado = await confirmarVentaLocal(req.usuario.id, {
    claveConfirmacion, huellaResumen, nombreCliente, telefonoCliente, metodoPago,
  });
  sinCache(res).status(resultado.creada ? 201 : 200).json({ venta: resultado.venta });
}));

// Historial y comprobante
router.get("/vendedor/ventas", asyncHandler(async (req, res) => {
  const { pagina, limite } = paginacion(req.query);
  const desde = dia(req.query.desde, "desde");
  const hasta = dia(req.query.hasta, "hasta");
  if (desde && hasta && desde > hasta) throw new ErrorVentaLocal(400, "FILTROS_INVALIDOS", "Indicá un período válido");
  const buscar = typeof req.query.buscar === "string" ? req.query.buscar.slice(0, 20) : "";
  sinCache(res).json(await listarVentasLocal({ desde, hasta, buscar, pagina, limite }));
}));

router.get("/vendedor/ventas/:id", asyncHandler(async (req, res) => {
  const id = enteroPositivo(req.params.id);
  const venta = id ? await obtenerVentaLocal(id) : null;
  if (!venta) return res.status(404).json({ message: "Venta no encontrada" });
  sinCache(res).json(venta);
}));

// Caja
router.get("/vendedor/caja", asyncHandler(async (req, res) => {
  sinCache(res).json({ caja: await obtenerCajaActual() });
}));

router.post("/vendedor/caja/apertura", asyncHandler(async (req, res) => {
  const { claveApertura, efectivoInicial } = req.body ?? {};
  const resultado = await abrirCaja(req.usuario.id, { claveApertura, efectivoInicial });
  sinCache(res).status(resultado.creada ? 201 : 200).json({ caja: resultado.caja, reiterada: !resultado.creada });
}));

router.post("/vendedor/caja/cierre", asyncHandler(async (req, res) => {
  const cajaId = enteroPositivo(req.body?.cajaId);
  if (!cajaId) throw new ErrorCaja(400, "CAJA_INVALIDA", "Caja inválida");
  const { efectivoDeclarado, observacion } = req.body;
  sinCache(res).json(await cerrarCaja(req.usuario.id, cajaId, { efectivoDeclarado, observacion }));
}));

router.use((error, req, res, next) => {
  if (!(error instanceof ErrorVentaLocal) && !(error instanceof ErrorCaja)) return next(error);
  const { status, codigo, message, name, stack, ...detalles } = error;
  return res.status(status).json({ message, codigo, ...detalles });
});

export default router;
