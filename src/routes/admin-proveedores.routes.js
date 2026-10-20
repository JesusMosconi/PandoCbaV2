import { Router } from "express";
import { verificarToken } from "../middleware/auth.js";
import { esAdmin } from "../middleware/es-admin.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validarCamposPermitidos, validarIdentificador, validarMotivo } from "../utils/validate-compras.js";
import {
  cambiarEstadoProveedor,
  crearProveedor,
  editarProveedor,
  listarProveedores,
  obtenerProveedor,
} from "../services/proveedores.js";

const router = Router();
router.use("/admin/proveedores", verificarToken, esAdmin);

function idParametro(valor) {
  return validarIdentificador(valor) ? null : Number(valor);
}

function paginacion(query) {
  const pagina = query.pagina === undefined ? 1 : idParametro(query.pagina);
  const limite = query.limite === undefined ? 20 : idParametro(query.limite);
  return pagina && limite && limite <= 100 ? { pagina, limite } : null;
}

function datosProveedor(body, parcial = false) {
  const error = validarCamposPermitidos(body, parcial ? [] : ["nombre"], ["nombre", "contacto", "observaciones"]);
  if (error) return error;
  if (parcial && Object.keys(body).length === 0) return "Indicá al menos un campo para actualizar";
  if (body.nombre !== undefined && (typeof body.nombre !== "string" || !body.nombre.trim() || body.nombre.trim().length > 200)) {
    return "El nombre debe contener entre 1 y 200 caracteres";
  }
  for (const campo of ["contacto", "observaciones"]) {
    if (body[campo] !== undefined && body[campo] !== null
      && (typeof body[campo] !== "string" || body[campo].length > 1000)) {
      return `El campo "${campo}" debe ser texto de hasta 1000 caracteres`;
    }
  }
  return null;
}

router.get("/admin/proveedores", asyncHandler(async (req, res) => {
  const pagina = paginacion(req.query);
  if (!pagina) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: "Paginación inválida" });
  const { buscar, activo } = req.query;
  if (buscar !== undefined && (typeof buscar !== "string" || buscar.length > 200)) {
    return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: "Filtro de búsqueda inválido" });
  }
  if (activo !== undefined && activo !== "true" && activo !== "false") {
    return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: "Filtro de actividad inválido" });
  }
  res.set("Cache-Control", "no-store").json(await listarProveedores({
    buscar: buscar?.trim(),
    activo: activo === undefined ? undefined : activo === "true",
    ...pagina,
  }));
}));

router.post("/admin/proveedores", asyncHandler(async (req, res) => {
  const error = datosProveedor(req.body);
  if (error) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: error });
  const { nombre, contacto, observaciones } = req.body;
  const proveedor = await crearProveedor({ nombre, contacto, observaciones }, req.usuario.id);
  res.status(201).set("Cache-Control", "no-store").json(proveedor);
}));

router.get("/admin/proveedores/:id", asyncHandler(async (req, res) => {
  const id = idParametro(req.params.id);
  const pagina = paginacion(req.query);
  if (!id || !pagina) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: "Identificador o paginación inválidos" });
  const proveedor = await obtenerProveedor(id, pagina.pagina, pagina.limite);
  if (!proveedor) return res.status(404).json({ codigo: "PROVEEDOR_NO_ENCONTRADO", message: "Proveedor no encontrado" });
  res.set("Cache-Control", "no-store").json(proveedor);
}));

router.put("/admin/proveedores/:id", asyncHandler(async (req, res) => {
  const id = idParametro(req.params.id);
  if (!id) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: "Identificador inválido" });
  const error = datosProveedor(req.body, true);
  if (error) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: error });
  const { nombre, contacto, observaciones } = req.body;
  const proveedor = await editarProveedor(id, { nombre, contacto, observaciones }, req.usuario.id);
  if (!proveedor) return res.status(404).json({ codigo: "PROVEEDOR_NO_ENCONTRADO", message: "Proveedor no encontrado" });
  res.set("Cache-Control", "no-store").json(proveedor);
}));

for (const [accion, activo] of [["desactivacion", false], ["reactivacion", true]]) {
  router.post(`/admin/proveedores/:id/${accion}`, asyncHandler(async (req, res) => {
    const id = idParametro(req.params.id);
    if (!id) return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: "Identificador inválido" });
    const error = validarCamposPermitidos(req.body, ["motivo"]);
    if (error || validarMotivo(req.body?.motivo)) {
      return res.status(400).json({ codigo: "ENTRADA_INVALIDA", message: error ?? validarMotivo(req.body?.motivo) });
    }
    const resultado = await cambiarEstadoProveedor(id, activo, req.body.motivo, req.usuario.id);
    res.status(resultado.status).set("Cache-Control", "no-store").json(
      resultado.proveedor ?? { codigo: resultado.status === 404 ? "PROVEEDOR_NO_ENCONTRADO" : "ESTADO_EN_CONFLICTO", message: resultado.message },
    );
  }));
}

export default router;
