import { Router } from "express";
import prisma from "../db.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../utils/validate.js";
import { verificarToken } from "../middleware/auth.js";
import { esAdmin } from "../middleware/es-admin.js";
import { whereProductoVisible } from "../utils/visibilidad-producto.js";
import { presentarVariantesConDisponibilidad } from "../services/inventario.js";
import { actualizarVigenciaPrecio, registrarPrecioInicial } from "../services/precios.js";

const router = Router();
const requerirAdmin = [verificarToken, esAdmin];
const requiredFields = { nombre: "string", precio: "number", categoriaId: "number" };
const optionalFields = { descripcion: "string", activo: "boolean", web: "boolean", coleccionId: "number" };

router.get("/productos", (req, res, next) => {
  if (req.query.admin !== "true") return next();
  return verificarToken(req, res, () => esAdmin(req, res, next));
}, asyncHandler(async (req, res) => {
  const { categoriaId, web, talle, orden, coleccionId, admin } = req.query;
  const esAdmin = admin === "true";
  const productos = await prisma.producto.findMany({
    where: {
      ...(esAdmin ? {} : whereProductoVisible),
      categoriaId: categoriaId ? Number(categoriaId) : undefined,
      coleccionId: coleccionId ? Number(coleccionId) : undefined,
      ...(esAdmin && web === "true" ? { web: true } : {}),
      talles: talle ? { some: { talle: { valor: talle } } } : undefined,
    },
    orderBy: orden === "asc" || orden === "desc" ? { precio: orden } : undefined,
    include: {
      categoria: true,
      coleccion: true,
      imagenes: { orderBy: { id: "asc" }, take: 1 },
      talles: {
        include: { talle: true, color: true },
      },
    },
  });
  const variantes = productos.flatMap((producto) => producto.talles);
  const disponibles = await presentarVariantesConDisponibilidad(prisma, variantes);
  const porId = new Map(disponibles.map((variante) => [variante.id, variante]));
  res.json(productos.map((producto) => ({
    ...producto,
    talles: producto.talles.map((variante) => porId.get(variante.id))
      .filter((variante) => esAdmin || (variante.estado !== "inactivo" && variante.stockDisponible > 0))
  })).filter((producto) => esAdmin || !talle
    || producto.talles.some((variante) => variante.talle.valor === talle)));
}));

router.get("/productos/:id", asyncHandler(async (req, res) => {
  const producto = await prisma.producto.findFirst({
    where: { id: Number(req.params.id), ...whereProductoVisible },
    include: {
      categoria: true,
      coleccion: true,
      imagenes: { orderBy: { orden: "asc" } },
      talles: { include: { talle: true, color: true } },
    },
  });
  if (!producto) return res.status(404).json({ message: "Producto no encontrado" });
  const talles = (await presentarVariantesConDisponibilidad(prisma, producto.talles))
    .filter((variante) => variante.estado !== "inactivo" && variante.stockDisponible > 0);
  res.json({ ...producto, talles });
}));

router.post("/productos", ...requerirAdmin, asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields, optionalFields);
  if (error) return res.status(400).json({ message: error });
  const { nombre, precio, categoriaId, descripcion, activo, web, coleccionId } = req.body;
  const producto = await prisma.$transaction(async (tx) => {
    const creado = await tx.producto.create({ data: {
      nombre, precio, categoriaId, descripcion, activo, web, coleccionId,
    } });
    await registrarPrecioInicial(tx, creado);
    return creado;
  });
  res.json(producto);
}));

router.put("/productos/:id", ...requerirAdmin, asyncHandler(async (req, res) => {
  const error = validateBody(req.body, requiredFields, optionalFields);
  if (error) return res.status(400).json({ message: error });
  const { nombre, precio, categoriaId, descripcion, activo, web, coleccionId } = req.body;
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: "Identificador inválido" });
  const resultado = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Producto" WHERE "id" = ${id} FOR UPDATE`;
    const actual = await tx.producto.findUnique({ where: { id } });
    if (!actual) return { status: 404, message: "Producto no encontrado" };
    if (actual.creadoDesdeCompras && web === true && !actual.web) {
      const ingresosConfirmados = await tx.partidaInventario.count({
        where: { variante: { productoId: id }, ingreso: { estado: "confirmado" } },
      });
      if (ingresosConfirmados === 0) {
        return { status: 409, message: "Confirmá un ingreso de alguna variante antes de publicar el producto" };
      }
    }
    const nuevo = await tx.producto.update({
      where: { id },
      data: { nombre, precio, categoriaId, descripcion, activo, web, coleccionId },
    });
    await actualizarVigenciaPrecio(tx, actual, nuevo);
    return { valor: nuevo };
  });
  if (resultado.status) return res.status(resultado.status).json({ message: resultado.message });
  res.json(resultado.valor);
}));

router.delete("/productos/:id", ...requerirAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: "Identificador inválido" });
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Producto" WHERE "id" = ${id} FOR UPDATE`;
    const anterior = await tx.producto.findUnique({ where: { id } });
    if (!anterior) return;
    const nuevo = await tx.producto.update({ where: { id }, data: { activo: false } });
    await actualizarVigenciaPrecio(tx, anterior, nuevo);
  });
  res.json({ message: "Producto desactivado" });
}));

export default router;
