import { horaBaseDatos } from "./inventario.js";

/** Registra solo precios regulares publicados desde la activación del historial. */
export async function registrarPrecioInicial(tx, producto) {
  if (!producto.activo || !producto.web) return;
  await tx.vigenciaPrecio.create({ data: {
    productoId: producto.id, clase: "regular", importe: producto.precio,
    inicio: await horaBaseDatos(tx), origen: "alta_producto",
  } });
}

/** Requiere que el llamador mantenga bloqueada la fila de Producto. */
export async function actualizarVigenciaPrecio(tx, anterior, nuevo) {
  const abierta = await tx.vigenciaPrecio.findFirst({
    where: { productoId: anterior.id, clase: "regular", fin: null },
    orderBy: { id: "desc" },
  });
  const publicada = nuevo.activo && nuevo.web;
  const precioCambio = !anterior.precio.equals(nuevo.precio);
  const divergente = abierta && !abierta.importe.equals(nuevo.precio);
  if (!abierta && !publicada) return;
  if (abierta && publicada && !precioCambio && !divergente) return;

  const hora = await horaBaseDatos(tx);
  const instante = abierta && hora <= abierta.inicio
    ? new Date(abierta.inicio.getTime() + 1) : hora;
  if (abierta) {
    await tx.vigenciaPrecio.update({ where: { id: abierta.id }, data: { fin: instante } });
  }
  if (publicada) {
    await tx.vigenciaPrecio.create({ data: {
      productoId: anterior.id, clase: "regular", importe: nuevo.precio,
      inicio: instante, origen: abierta ? "cambio_producto" : "publicacion_producto",
    } });
  }
}
