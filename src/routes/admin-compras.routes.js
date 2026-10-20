import { Router } from "express";
import prisma from "../db.js";
import { verificarToken } from "../middleware/auth.js";
import { esAdmin } from "../middleware/es-admin.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validarCamposPermitidos, validarFecha, validarIdentificador } from "../utils/validate-compras.js";
import {
  ErrorCompra, anularIngreso, corregirIngreso, confirmarIngreso, crearBorradorIngreso, editarBorradorIngreso,
  listarIngresos, obtenerIngreso, resumenIngreso,
} from "../services/compras.js";
import { devolverAProveedor, ErrorDevolucion } from "../services/devoluciones.js";

const router = Router();
router.use("/admin/compras", verificarToken, esAdmin);

const camposIngreso = [
  "proveedorId", "fechaCompra", "fechaRecepcion", "lineas", "gastosAdicionales",
  "observaciones", "comprobanteReferencia",
];
const idPositivo = (valor) => validarIdentificador(valor) ? null : Number(valor);

router.get("/admin/compras", asyncHandler(async (req, res) => {
  const pagina = req.query.pagina === undefined ? 1 : idPositivo(req.query.pagina);
  const limite = req.query.limite === undefined ? 20 : idPositivo(req.query.limite);
  const proveedorId = req.query.proveedorId === undefined ? undefined : idPositivo(req.query.proveedorId);
  const productoId = req.query.productoId === undefined ? undefined : idPositivo(req.query.productoId);
  const varianteId = req.query.varianteId === undefined ? undefined : idPositivo(req.query.varianteId);
  const desde = req.query.desde;
  const hasta = req.query.hasta;
  const estado = req.query.estado;
  if (!pagina || !limite || limite > 100 || (req.query.proveedorId !== undefined && !proveedorId)
    || (req.query.productoId !== undefined && !productoId)
    || (req.query.varianteId !== undefined && !varianteId)
    || (desde !== undefined && validarFecha(desde, "desde"))
    || (hasta !== undefined && validarFecha(hasta, "hasta"))
    || (desde && hasta && desde > hasta)
    || (estado !== undefined && !["borrador", "confirmado", "anulado"].includes(estado))) {
    return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: "Filtros o paginación inválidos" });
  }
  res.set("Cache-Control", "no-store").json(await listarIngresos({ proveedorId, productoId, varianteId, desde, hasta, estado, pagina, limite }));
}));

router.post("/admin/compras", asyncHandler(async (req, res) => {
  const error = validarCamposPermitidos(req.body, ["proveedorId", "fechaCompra", "fechaRecepcion", "lineas"], camposIngreso);
  if (error) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: error });
  const { proveedorId, fechaCompra, fechaRecepcion, lineas, gastosAdicionales, observaciones, comprobanteReferencia } = req.body;
  res.status(201).set("Cache-Control", "no-store").json(await crearBorradorIngreso({
    proveedorId, fechaCompra, fechaRecepcion, lineas, gastosAdicionales, observaciones, comprobanteReferencia,
  }));
}));

router.post("/admin/compras/productos", asyncHandler(async (req, res) => {
  const error = validarCamposPermitidos(req.body, ["nombre", "precio", "categoriaId"], [
    "descripcion", "coleccionId", "activo",
  ]);
  if (error) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: error });
  const { nombre, precio, categoriaId, descripcion, coleccionId, activo } = req.body;
  if (typeof nombre !== "string" || !nombre.trim() || nombre.length > 200
    || typeof precio !== "number" || !Number.isFinite(precio) || precio < 0
    || !Number.isSafeInteger(categoriaId) || categoriaId <= 0
    || (coleccionId !== undefined && (!Number.isSafeInteger(coleccionId) || coleccionId <= 0))
    || (descripcion !== undefined && descripcion !== null && typeof descripcion !== "string")
    || (activo !== undefined && typeof activo !== "boolean")) {
    return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: "Datos de producto inválidos" });
  }
  const producto = await prisma.producto.create({ data: {
    nombre: nombre.trim(), precio, categoriaId, descripcion,
    coleccionId, activo: activo ?? true, web: false, creadoDesdeCompras: true,
  } });
  res.status(201).set("Cache-Control", "no-store").json(producto);
}));

router.get("/admin/compras/:id", asyncHandler(async (req, res) => {
  const id = idPositivo(req.params.id);
  if (!id) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: "Identificador inválido" });
  const ingreso = await obtenerIngreso(id);
  if (!ingreso) return res.status(404).json({ codigo: "INGRESO_NO_ENCONTRADO", message: "Ingreso no encontrado" });
  res.set("Cache-Control", "no-store").json(ingreso);
}));

router.put("/admin/compras/:id", asyncHandler(async (req, res) => {
  const id = idPositivo(req.params.id);
  if (!id) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: "Identificador inválido" });
  const error = validarCamposPermitidos(req.body, ["proveedorId", "fechaCompra", "fechaRecepcion", "lineas"], camposIngreso);
  if (error) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: error });
  const { proveedorId, fechaCompra, fechaRecepcion, lineas, gastosAdicionales, observaciones, comprobanteReferencia } = req.body;
  res.set("Cache-Control", "no-store").json(await editarBorradorIngreso(id, {
    proveedorId, fechaCompra, fechaRecepcion, lineas, gastosAdicionales, observaciones, comprobanteReferencia,
  }));
}));

router.post("/admin/compras/:id/resumen", asyncHandler(async (req, res) => {
  const id = idPositivo(req.params.id);
  if (!id) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: "Identificador inválido" });
  const error = validarCamposPermitidos(req.body ?? {}, []);
  if (error) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: error });
  res.set("Cache-Control", "no-store").json(await resumenIngreso(id));
}));

router.post("/admin/compras/:id/confirmacion", asyncHandler(async (req, res) => {
  const id = idPositivo(req.params.id);
  if (!id) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: "Identificador inválido" });
  const error = validarCamposPermitidos(req.body, ["claveOperacion", "resumenAceptado"]);
  if (error) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: error });
  const { claveOperacion, resumenAceptado } = req.body;
  res.set("Cache-Control", "no-store").json(await confirmarIngreso(id, { claveOperacion, resumenAceptado }, req.usuario.id));
}));

router.post("/admin/compras/:id/correcciones", asyncHandler(async (req, res) => {
  const id = idPositivo(req.params.id);
  if (!id) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: "Identificador inválido" });
  const error = validarCamposPermitidos(req.body, ["partidaId", "campo", "valorNuevo", "motivo", "claveOperacion"]);
  if (error) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: error });
  res.set("Cache-Control", "no-store").json(await corregirIngreso(id, req.body, req.usuario.id));
}));

router.post("/admin/compras/:id/anulacion", asyncHandler(async (req, res) => {
  const id = idPositivo(req.params.id);
  if (!id) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: "Identificador inválido" });
  const error = validarCamposPermitidos(req.body, ["motivo", "claveOperacion"]);
  if (error) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: error });
  res.set("Cache-Control", "no-store").json(await anularIngreso(id, req.body, req.usuario.id));
}));

router.post("/admin/compras/:id/devoluciones-proveedor", asyncHandler(async (req, res) => {
  const id = idPositivo(req.params.id);
  if (!id) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: "Identificador inválido" });
  const error = validarCamposPermitidos(req.body, ["partidaId", "cantidad", "motivo", "claveOperacion"]);
  if (error) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: error });
  res.set("Cache-Control", "no-store").json(await devolverAProveedor(id, req.body, req.usuario.id));
}));

router.use((error, req, res, next) => {
  if (!(error instanceof ErrorCompra) && !(error instanceof ErrorDevolucion)) return next(error);
  return res.status(error.status).set("Cache-Control", "no-store").json({
    codigo: error.codigo, message: error.message, ...(error.campos.length ? { campos: error.campos } : {}),
  });
});

export default router;
