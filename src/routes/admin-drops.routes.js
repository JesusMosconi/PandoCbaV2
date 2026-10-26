import { Router } from "express";
import prisma from "../db.js";
import { verificarToken } from "../middleware/auth.js";
import { esAdmin } from "../middleware/es-admin.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validarCamposPermitidos, validarIdentificador } from "../utils/validate-compras.js";
import { upload } from "../utils/upload.js";
import { crearUrlImagen, eliminarImagenLocal } from "../utils/imagen-local.js";
import { contextoDrops, estadoDrop } from "../services/drops.js";

const router = Router();
router.use("/admin/drops", verificarToken, esAdmin);

const campos = ["nombre", "numeroDrop", "fechaLanzamiento", "fechaFinalizacion", "tituloInicio", "textoBotonInicio"];

function fechaConZonaValida(valor) {
  if (typeof valor !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(valor)) return false;
  const fecha = new Date(valor);
  if (Number.isNaN(fecha.getTime())) return false;
  const zona = valor.endsWith("Z") ? 0 : (() => {
    const [, signo, horas, minutos] = /([+-])(\d{2}):(\d{2})$/.exec(valor);
    if (Number(horas) > 23 || Number(minutos) > 59) return NaN;
    return (signo === "+" ? 1 : -1) * (Number(horas) * 60 + Number(minutos));
  })();
  return Number.isFinite(zona) && new Date(fecha.getTime() + zona * 60_000).toISOString().slice(0, 19) === valor.slice(0, 19);
}

export function validarDatos(body, crear = false) {
  const error = validarCamposPermitidos(body, crear ? ["nombre"] : [], campos);
  if (error) return error;
  if (!crear && !Object.keys(body).length) return "Indicá al menos un campo";
  if (body.nombre !== undefined && (typeof body.nombre !== "string" || !body.nombre.trim() || body.nombre.trim().length > 200)) return "Nombre inválido";
  if (body.numeroDrop !== undefined && body.numeroDrop !== null && (!Number.isSafeInteger(body.numeroDrop) || body.numeroDrop <= 0)) return "Número de drop inválido";
  for (const campo of ["tituloInicio", "textoBotonInicio"]) {
    if (body[campo] !== undefined && body[campo] !== null && (typeof body[campo] !== "string" || body[campo].trim().length > 200)) return `${campo} inválido`;
  }
  for (const campo of ["fechaLanzamiento", "fechaFinalizacion"]) {
    if (body[campo] !== undefined && body[campo] !== null && !fechaConZonaValida(body[campo])) return `${campo} debe ser una fecha y hora válida con zona horaria`;
  }
  return null;
}

export function datosDrop(body) {
  const data = {};
  for (const campo of campos) if (Object.hasOwn(body, campo)) {
    data[campo] = ["nombre", "tituloInicio", "textoBotonInicio"].includes(campo) && body[campo] !== null
      ? body[campo].trim() : ["fechaLanzamiento", "fechaFinalizacion"].includes(campo) && body[campo]
        ? new Date(body[campo]) : body[campo];
  }
  return data;
}

export function validarProgramacion(data) {
  if (data.fechaFinalizacion && (!data.fechaLanzamiento || data.fechaFinalizacion <= data.fechaLanzamiento)) return "La fecha de finalización debe ser posterior al lanzamiento";
  if (data.fechaLanzamiento && (!data.imagenUrl || !data.tituloInicio || !data.textoBotonInicio)) return "Para programar el drop cargá portada, título y texto del botón";
  return null;
}

async function buscar(req, res) {
  if (validarIdentificador(req.params.id)) {
    res.status(400).json({ message: "Identificador inválido" });
    return null;
  }
  const drop = await prisma.coleccion.findUnique({ where: { id: Number(req.params.id) } });
  if (!drop) res.status(404).json({ message: "Drop no encontrado" });
  return drop;
}

router.get("/admin/drops", asyncHandler(async (req, res) => {
  const { drops, cantidades, ahora } = await contextoDrops();
  const ordenados = drops.sort((a, b) => (b.fechaLanzamiento?.getTime() ?? -Infinity)
    - (a.fechaLanzamiento?.getTime() ?? -Infinity) || b.id - a.id);
  res.set("Cache-Control", "no-store").json(ordenados.map((drop) => ({
    ...drop, ...estadoDrop(drop, ahora, cantidades.get(drop.id)), productosDisponibles: cantidades.get(drop.id) ?? 0,
  })));
}));

router.post("/admin/drops", asyncHandler(async (req, res) => {
  const error = validarDatos(req.body, true);
  if (error) return res.status(400).json({ message: error });
  const data = datosDrop(req.body);
  const conflicto = validarProgramacion(data);
  if (conflicto) return res.status(400).json({ codigo: "FECHA_INVALIDA", message: conflicto });
  res.status(201).json(await prisma.coleccion.create({ data }));
}));

router.put("/admin/drops/:id", asyncHandler(async (req, res) => {
  if (req.params.id === "marca") return guardarMarca(req, res);
  const actual = await buscar(req, res);
  if (!actual) return;
  if (!actual.activo || actual.fechaCierre || (actual.fechaFinalizacion && actual.fechaFinalizacion <= new Date())) return res.status(409).json({ codigo: "DROP_FINALIZADO", message: "El drop ya fue retirado o finalizado" });
  const error = validarDatos(req.body);
  if (error) return res.status(400).json({ message: error });
  const data = datosDrop(req.body);
  const conflicto = validarProgramacion({ ...actual, ...data });
  if (conflicto) return res.status(400).json({ codigo: "FECHA_INVALIDA", message: conflicto });
  if (actual.fechaActivacion && Object.hasOwn(data, "fechaLanzamiento") && data.fechaLanzamiento?.getTime() !== actual.fechaLanzamiento?.getTime()) return res.status(409).json({ message: "No se puede cambiar el lanzamiento de un drop ya activado" });
  res.json(await prisma.coleccion.update({ where: { id: actual.id }, data }));
}));

router.post("/admin/drops/:id/finalizar", asyncHandler(async (req, res) => {
  const actual = await buscar(req, res);
  if (!actual) return;
  if (!actual.activo || !actual.fechaLanzamiento || actual.fechaLanzamiento > new Date()) return res.status(409).json({ message: "Solo se puede finalizar un drop ya lanzado" });
  if (actual.fechaCierre) return res.json(actual);
  res.json(await prisma.coleccion.update({ where: { id: actual.id }, data: { fechaCierre: new Date(), motivoCierre: "manual" } }));
}));

router.delete("/admin/drops/:id", asyncHandler(async (req, res) => {
  const actual = await buscar(req, res);
  if (!actual) return;
  res.json(actual.activo ? await prisma.coleccion.update({ where: { id: actual.id }, data: { activo: false } }) : actual);
}));

router.post("/admin/drops/:id/imagen", upload.single("imagen"), asyncHandler(async (req, res) => {
  if (req.params.id === "marca") return guardarImagenMarca(req, res);
  const actual = await buscar(req, res);
  if (!actual) { if (req.file) await eliminarImagenLocal(req.file.path); return; }
  if (!req.file) return res.status(400).json({ message: "No se recibió ninguna imagen" });
  const imagenUrl = crearUrlImagen(req, req.file);
  try {
    const nuevo = await prisma.coleccion.update({ where: { id: actual.id }, data: { imagenUrl } });
    await eliminarImagenLocal(actual.imagenUrl);
    res.json(nuevo);
  } catch (error) { await eliminarImagenLocal(imagenUrl); throw error; }
}));

router.delete("/admin/drops/:id/imagen", asyncHandler(async (req, res) => {
  if (req.params.id === "marca") return eliminarImagenMarca(req, res);
  const actual = await buscar(req, res);
  if (!actual) return;
  if (actual.fechaLanzamiento) return res.status(409).json({ message: "No se puede dejar sin portada un drop programado" });
  const nuevo = await prisma.coleccion.update({ where: { id: actual.id }, data: { imagenUrl: null } });
  await eliminarImagenLocal(actual.imagenUrl);
  res.json(nuevo);
}));

async function marcaActual() {
  return prisma.configuracionPortadaInicio.findUnique({ where: { id: 1 } });
}

function presentarMarca(marca) {
  return { titulo: marca?.titulo ?? null, imagenUrl: marca?.imagenUrl ?? null,
    completo: Boolean(marca?.imagenUrl) };
}

router.get("/admin/drops/marca", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store").json(presentarMarca(await marcaActual()));
}));

async function guardarMarca(req, res) {
  const error = validarCamposPermitidos(req.body, ["titulo"]);
  if (error || typeof req.body.titulo !== "string" || req.body.titulo.trim().length > 200) return res.status(400).json({ message: error ?? "Título inválido" });
  const actual = await marcaActual();
  const titulo = req.body.titulo.trim() || null;
  const fechaCompletada = actual?.fechaCompletada ?? (actual?.imagenUrl ? new Date() : null);
  const marca = await prisma.configuracionPortadaInicio.upsert({ where: { id: 1 },
    create: { id: 1, titulo, fechaCompletada }, update: { titulo, fechaCompletada } });
  res.json(presentarMarca(marca));
}

async function guardarImagenMarca(req, res) {
  if (!req.file) return res.status(400).json({ message: "No se recibió ninguna imagen" });
  const actual = await marcaActual();
  const imagenUrl = crearUrlImagen(req, req.file);
  try {
    const fechaCompletada = actual?.fechaCompletada ?? new Date();
    const marca = await prisma.configuracionPortadaInicio.upsert({ where: { id: 1 },
      create: { id: 1, imagenUrl, fechaCompletada }, update: { imagenUrl, fechaCompletada } });
    await eliminarImagenLocal(actual?.imagenUrl);
    res.json(presentarMarca(marca));
  } catch (error) { await eliminarImagenLocal(imagenUrl); throw error; }
}

async function eliminarImagenMarca(req, res) {
  const actual = await marcaActual();
  if (actual?.fechaCompletada) return res.status(409).json({ message: "La portada de marca debe conservar una imagen" });
  if (!actual) return res.json(presentarMarca(null));
  const marca = await prisma.configuracionPortadaInicio.update({ where: { id: 1 }, data: { imagenUrl: null } });
  await eliminarImagenLocal(actual.imagenUrl);
  res.json(presentarMarca(marca));
}

export default router;
