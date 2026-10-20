export const DURACION_CARRITO_MS = 24 * 60 * 60 * 1000;

export const incluirItems = {
  items: {
    include: {
      talleProducto: {
        include: {
          talle: true,
          color: true,
          producto: { include: { imagenes: { orderBy: { orden: "asc" }, take: 1 } } },
        },
      },
      productoImprovisado: true,
    },
    orderBy: { id: "asc" },
  },
};

export async function obtenerOCrearCarrito(prisma, usuarioId, ahora = new Date()) {
  const carrito = await prisma.carrito.findFirst({
    where: { usuarioId, estado: "activo" },
    include: incluirItems,
    orderBy: { id: "desc" },
  });

  if (carrito) {
    const actualizado = new Date(carrito.actualizado).getTime();
    if (Number.isFinite(actualizado) && ahora.getTime() - actualizado < DURACION_CARRITO_MS) {
      return carrito;
    }

    await prisma.$transaction(async (tx) => {
      await tx.itemCarrito.deleteMany({ where: { carritoId: carrito.id } });
      await tx.carrito.update({
        where: { id: carrito.id },
        data: { estado: "expirado" },
      });
    });
  }

  return prisma.carrito.create({
    data: { usuarioId, estado: "activo", canal: "web" },
    include: incluirItems,
  });
}

export function marcarCarritoActualizado(prisma, carritoId, actualizado = new Date()) {
  return prisma.carrito.update({
    where: { id: carritoId },
    data: { actualizado },
  });
}
