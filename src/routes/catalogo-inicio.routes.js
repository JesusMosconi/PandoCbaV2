import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";
import { verificarToken } from "../middleware/auth.js";
import { esAdmin } from "../middleware/es-admin.js";
import { whereProductoPublicado } from "../utils/visibilidad-producto.js";
import { presentarVariantesConDisponibilidad } from "../services/inventario.js";
import {
  ErrorCatalogoInicio,
  agregarSeleccion,
  editarSeleccion,
  listarSeleccionAdministrativa,
  quitarSeleccion,
  reemplazarSeleccion,
} from "../services/catalogo-inicio.js";

const router = Router();
const requerirAdmin = [verificarToken, esAdmin];
const requiredFields = { orden: "number", productoId: "number" };

function administrar(operacion) {
  return asyncHandler(async (req, res) => {
    try {
      await operacion(req, res);
    } catch (error) {
      if (error instanceof ErrorCatalogoInicio) {
        return res.status(error.status).json({ message: error.message });
      }
      throw error;
    }
  });
}

function idRuta(req, res) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ message: "Identificador inválido" });
    return null;
  }
  return id;
}

// La ruta administrativa debe preceder a /:id.
router.get("/catalogo-inicio/seleccion", ...requerirAdmin, administrar(async (_req, res) => {
  res.json(await listarSeleccionAdministrativa());
}));

router.put("/catalogo-inicio/seleccion", ...requerirAdmin, administrar(async (req, res) => {
  const error = validateBody(req.body, {});
  if (error) return res.status(400).json({ message: error });
  res.json(await reemplazarSeleccion(req.body.productoIds));
}));

router.get("/catalogo-inicio", asyncHandler(async (_req, res) => {
  const catalogo = await prisma.catalogoInicio.findMany({
    where: { activo: true, producto: { is: whereProductoPublicado } },
    orderBy: [{ orden: "asc" }, { id: "asc" }],
    include: {
      producto: {
        select: {
          id: true, nombre: true, precio: true, descripcion: true,
          imagenes: { orderBy: { orden: "asc" }, take: 1 },
          talles: { include: { talle: true, color: true } },
        },
      },
    },
  });
  const variantes = catalogo.flatMap((item) => item.producto.talles);
  const porId = new Map((await presentarVariantesConDisponibilidad(prisma, variantes))
    .map((variante) => [variante.id, variante]));
  res.json(catalogo.map((item) => ({
    ...item,
    producto: {
      ...item.producto,
      talles: item.producto.talles.map((variante) => porId.get(variante.id))
        .filter((variante) => variante.estado !== "inactivo" && variante.stockDisponible > 0),
    },
  })));
}));

router.get("/catalogo-inicio/:id", asyncHandler(async (req, res) => {
  const id = idRuta(req, res);
  if (id === null) return;
  const item = await prisma.catalogoInicio.findFirst({
    where: { id, activo: true, producto: { is: whereProductoPublicado } },
    include: {
      producto: {
        select: {
          id: true, nombre: true, precio: true, descripcion: true,
          imagenes: { orderBy: { orden: "asc" }, take: 1 },
          talles: { include: { talle: true, color: true } },
        },
      },
    },
  });
  if (!item) return res.status(404).json({ message: "Elemento de catálogo no encontrado" });
  const talles = (await presentarVariantesConDisponibilidad(prisma, item.producto.talles))
    .filter((variante) => variante.estado !== "inactivo" && variante.stockDisponible > 0);
  res.json({ ...item, producto: { ...item.producto, talles } });
}));

router.post("/catalogo-inicio", ...requerirAdmin, administrar(async (req, res) => {
  const error = validateBody(req.body, requiredFields);
  if (error) return res.status(400).json({ message: error });
  const { orden, productoId } = req.body;
  res.json(await agregarSeleccion({ orden, productoId }));
}));

router.put("/catalogo-inicio/:id", ...requerirAdmin, administrar(async (req, res) => {
  const id = idRuta(req, res);
  if (id === null) return;
  const error = validateBody(req.body, requiredFields);
  if (error) return res.status(400).json({ message: error });
  const { orden, productoId } = req.body;
  res.json(await editarSeleccion(id, { orden, productoId }));
}));

router.delete("/catalogo-inicio/:id", ...requerirAdmin, administrar(async (req, res) => {
  const id = idRuta(req, res);
  if (id === null) return;
  res.json(await quitarSeleccion(id));
}));

export default router;
