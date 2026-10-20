import prisma from "../db.js";

export async function listarProveedores({ buscar = "", activo, pagina = 1, limite = 20 }) {
  const where = {
    ...(buscar ? { nombre: { contains: buscar, mode: "insensitive" } } : {}),
    ...(activo === undefined ? {} : { activo }),
  };
  const [total, datos] = await prisma.$transaction([
    prisma.proveedor.count({ where }),
    prisma.proveedor.findMany({
      where,
      include: { _count: { select: { ingresos: true } } },
      orderBy: [{ nombre: "asc" }, { id: "asc" }],
      skip: (pagina - 1) * limite,
      take: limite,
    }),
  ]);
  return { datos, total, pagina, limite };
}

export async function obtenerProveedor(id, pagina = 1, limite = 20) {
  const proveedor = await prisma.proveedor.findUnique({
    where: { id },
    include: {
      eventos: { orderBy: [{ fecha: "desc" }, { id: "desc" }] },
      _count: { select: { ingresos: true } },
    },
  });
  if (!proveedor) return null;
  const ingresos = await prisma.ingreso.findMany({
    where: { proveedorId: id },
    select: { id: true, fechaCompra: true, fechaRecepcion: true, estado: true, confirmadoEn: true },
    orderBy: [{ fechaRecepcion: "desc" }, { id: "desc" }],
    skip: (pagina - 1) * limite,
    take: limite,
  });
  return { ...proveedor, ingresos: { datos: ingresos, total: proveedor._count.ingresos, pagina, limite } };
}

export async function crearProveedor({ nombre, contacto, observaciones }, actorUsuarioId) {
  return prisma.proveedor.create({
    data: {
      nombre: nombre.trim(),
      contacto: contacto?.trim() || null,
      observaciones: observaciones?.trim() || null,
      eventos: { create: { tipo: "creacion", motivo: "Alta de proveedor", actorUsuarioId } },
    },
  });
}

export async function editarProveedor(id, cambios, actorUsuarioId) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Proveedor" WHERE "id" = ${id} FOR UPDATE`;
    const actual = await tx.proveedor.findUnique({ where: { id } });
    if (!actual) return null;
    const proveedor = await tx.proveedor.update({
      where: { id },
      data: {
        ...(cambios.nombre !== undefined ? { nombre: cambios.nombre.trim() } : {}),
        ...(cambios.contacto !== undefined ? { contacto: cambios.contacto?.trim() || null } : {}),
        ...(cambios.observaciones !== undefined ? { observaciones: cambios.observaciones?.trim() || null } : {}),
      },
    });
    const campos = ["nombre", "contacto", "observaciones"];
    const anteriores = Object.fromEntries(campos.map((campo) => [campo, actual[campo]]));
    const nuevos = Object.fromEntries(campos.map((campo) => [campo, proveedor[campo]]));
    await tx.eventoProveedor.create({
      data: { proveedorId: id, tipo: "edicion", motivo: "Actualización de datos", actorUsuarioId,
        valoresAnteriores: anteriores, valoresNuevos: nuevos },
    });
    return proveedor;
  });
}

export async function cambiarEstadoProveedor(id, activo, motivo, actorUsuarioId) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Proveedor" WHERE "id" = ${id} FOR UPDATE`;
    const actual = await tx.proveedor.findUnique({ where: { id } });
    if (!actual) return { status: 404, message: "Proveedor no encontrado" };
    if (actual.activo === activo) return { status: 409, message: activo ? "El proveedor ya está activo" : "El proveedor ya está inactivo" };
    const proveedor = await tx.proveedor.update({ where: { id }, data: { activo } });
    await tx.eventoProveedor.create({
      data: { proveedorId: id, tipo: activo ? "reactivacion" : "desactivacion", motivo: motivo.trim(), actorUsuarioId },
    });
    return { status: 200, proveedor };
  });
}
