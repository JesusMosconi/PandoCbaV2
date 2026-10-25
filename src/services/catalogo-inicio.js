import prisma from "../db.js";

export class ErrorCatalogoInicio extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function validarProductoIds(productoIds) {
  if (!Array.isArray(productoIds) || productoIds.length > 5
    || productoIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new ErrorCatalogoInicio(400, "Elegí entre cero y cinco productos con identificadores válidos");
  }
  if (new Set(productoIds).size !== productoIds.length) {
    throw new ErrorCatalogoInicio(409, "El mismo producto no puede estar seleccionado dos veces");
  }
  return productoIds;
}

function posicionValida(orden, maximo) {
  if (!Number.isSafeInteger(orden) || orden < 1 || orden > maximo) {
    throw new ErrorCatalogoInicio(400, `El orden debe estar entre 1 y ${maximo}`);
  }
}

function motivos(producto) {
  return [
    ...(!producto.activo ? ["inactivo"] : []),
    ...(!producto.web ? ["no_publicado"] : []),
  ];
}

async function leerAdministracion(tx) {
  const filas = await tx.catalogoInicio.findMany({
    where: { activo: true },
    orderBy: [{ orden: "asc" }, { id: "asc" }],
    include: { producto: {
      select: { id: true, nombre: true, activo: true, web: true, coleccionId: true },
    } },
  });
  return filas.map((fila) => ({ ...fila, motivosOcultamiento: motivos(fila.producto) }));
}

export function listarSeleccionAdministrativa() {
  return leerAdministracion(prisma);
}

async function conBloqueo(operacion) {
  return prisma.$transaction(async (tx) => {
    // Un bloqueo del recurso completo también protege la selección vacía.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(20261023, 4)::text AS bloqueo`;
    return operacion(tx);
  });
}

async function activos(tx) {
  return tx.catalogoInicio.findMany({
    where: { activo: true },
    orderBy: [{ orden: "asc" }, { id: "asc" }],
    select: { id: true, productoId: true, orden: true },
  });
}

async function aplicar(tx, productoIds) {
  validarProductoIds(productoIds);
  if (productoIds.length) {
    const encontrados = await tx.producto.count({ where: { id: { in: productoIds } } });
    if (encontrados !== productoIds.length) {
      throw new ErrorCatalogoInicio(404, "Uno o más productos no existen");
    }
  }
  await tx.catalogoInicio.updateMany({
    where: { activo: true, ...(productoIds.length ? { productoId: { notIn: productoIds } } : {}) },
    data: { activo: false },
  });
  for (const [indice, productoId] of productoIds.entries()) {
    await tx.catalogoInicio.upsert({
      where: { productoId },
      create: { productoId, orden: indice + 1, activo: true },
      update: { orden: indice + 1, activo: true },
    });
  }
  return leerAdministracion(tx);
}

export function reemplazarSeleccion(productoIds) {
  return conBloqueo((tx) => aplicar(tx, productoIds));
}

export function agregarSeleccion({ orden, productoId }) {
  return conBloqueo(async (tx) => {
    const filas = await activos(tx);
    posicionValida(orden, filas.length + 1);
    if (filas.some((fila) => fila.productoId === productoId)) {
      throw new ErrorCatalogoInicio(409, "El producto ya está seleccionado");
    }
    const ids = filas.map((fila) => fila.productoId);
    ids.splice(orden - 1, 0, productoId);
    const resultado = await aplicar(tx, ids);
    return resultado.find((fila) => fila.productoId === productoId);
  });
}

export function editarSeleccion(id, { orden, productoId }) {
  return conBloqueo(async (tx) => {
    const filas = await activos(tx);
    const actual = filas.find((fila) => fila.id === id);
    if (!actual) throw new ErrorCatalogoInicio(404, "Selección no encontrada");
    posicionValida(orden, filas.length);
    if (filas.some((fila) => fila.id !== id && fila.productoId === productoId)) {
      throw new ErrorCatalogoInicio(409, "El producto ya está seleccionado");
    }
    const ids = filas.filter((fila) => fila.id !== id).map((fila) => fila.productoId);
    ids.splice(orden - 1, 0, productoId);
    const resultado = await aplicar(tx, ids);
    return resultado.find((fila) => fila.productoId === productoId);
  });
}

export function quitarSeleccion(id) {
  return conBloqueo(async (tx) => {
    const filas = await activos(tx);
    const actual = filas.find((fila) => fila.id === id);
    if (!actual) throw new ErrorCatalogoInicio(404, "Selección no encontrada");
    await aplicar(tx, filas.filter((fila) => fila.id !== id).map((fila) => fila.productoId));
    return { ...actual, activo: false };
  });
}
