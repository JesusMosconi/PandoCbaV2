import prisma from "../db.js";
import { centavos, importeDecimal } from "./importes.js";

/** Los importes del checkout actual son solo mercadería; el envío queda aparte. */
export async function costoVentaOrden(orden, tx = prisma) {
  if (!orden.pagoConfirmadoEn) return { estado: "sin_pago", margenBruto: null, origenes: [] };
  const asignaciones = await tx.asignacionPartida.findMany({
    where: { detalleOrden: { ordenId: orden.id }, estado: { in: ["vendida", "revertida"] } },
    include: {
      partida: { include: { ingreso: { include: { proveedor: { select: { id: true, nombre: true } } } } } },
      detalleOrden: { select: { cantidad: true } },
      devolucionesCliente: { select: { cantidad: true, costoRevertido: true } },
    },
    orderBy: [{ detalleOrdenId: "asc" }, { id: "asc" }],
  });
  let importeAtribuido = 0n;
  let costoConocido = 0n;
  let descuentoAtribuido = 0n;
  let unidadesSinCosto = 0;
  let unidadesAtribuidas = 0;
  let diferenciaCorrecciones = 0n;
  const origenes = [];
  for (const asignacion of asignaciones) {
    const devueltas = asignacion.devolucionesCliente.reduce((total, item) => total + item.cantidad, 0);
    const costoDevuelto = asignacion.devolucionesCliente.some((item) => item.costoRevertido === null)
      ? null : asignacion.devolucionesCliente.reduce((total, item) =>
        total + centavos(item.costoRevertido.toFixed(2)), 0n);
    const unidadesNetas = asignacion.cantidad - devueltas;
    if (unidadesNetas < 0) throw new Error("La devolución supera la asignación FIFO original");
    const importe = asignacion.importeEfectivo === null ? null : centavos(asignacion.importeEfectivo.toFixed(2));
    const unitarioAlPago = asignacion.costoUnitarioAlPago === null
      ? null : centavos(asignacion.costoUnitarioAlPago.toFixed(2));
    const unitario = unitarioAlPago === null ? null
      : centavos((asignacion.partida.costoUnitario ?? asignacion.costoUnitarioAlPago).toFixed(2));
    const descuento = asignacion.descuentoAtribuido === null
      ? null : centavos(asignacion.descuentoAtribuido.toFixed(2));
    if (importe !== null) importeAtribuido += importe;
    if (descuento !== null) descuentoAtribuido += descuento;
    if (unitario === null) unidadesSinCosto += unidadesNetas;
    else {
      costoConocido += unitario * BigInt(unidadesNetas);
      diferenciaCorrecciones += (unitario - unitarioAlPago) * BigInt(unidadesNetas);
    }
    unidadesAtribuidas += asignacion.cantidad;
    origenes.push({
      partidaId: asignacion.partidaId,
      origen: asignacion.partida.origen,
      proveedorId: asignacion.partida.ingreso?.proveedor.id ?? null,
      proveedorNombre: asignacion.partida.ingreso?.proveedor.nombre ?? null,
      cantidad: asignacion.cantidad,
      cantidadDevuelta: devueltas,
      importeEfectivo: importe === null ? null : importeDecimal(importe),
      descuentoAtribuido: descuento === null ? null : importeDecimal(descuento),
      costoConocido: unitario === null ? null : importeDecimal(unitario * BigInt(unidadesNetas)),
      costoRevertido: costoDevuelto === null ? null : importeDecimal(costoDevuelto),
      costoAlPago: unitarioAlPago === null ? null : importeDecimal(unitarioAlPago * BigInt(asignacion.cantidad)),
      estado: asignacion.estado,
    });
  }
  const unidadesOrden = orden.detalles.reduce((suma, detalle) => suma + detalle.cantidad, 0);
  const coberturaCompleta = unidadesAtribuidas === unidadesOrden
    && importeAtribuido === centavos(orden.subtotal.toFixed(2))
    && asignaciones.every((asignacion) => asignacion.importeEfectivo !== null);
  const estado = asignaciones.length === 0 ? "sin_fifo"
    : !coberturaCompleta ? "parcial"
      : unidadesSinCosto ? "costo_desconocido" : "completo";
  return {
    estado,
    importeMercaderia: orden.subtotal.toFixed(2),
    importeAtribuido: importeDecimal(importeAtribuido),
    descuentoAtribuido: importeDecimal(descuentoAtribuido),
    costoConocido: importeDecimal(costoConocido),
    diferenciaCorrecciones: importeDecimal(diferenciaCorrecciones),
    unidadesSinCosto,
    margenBruto: estado === "completo" ? importeDecimal(importeAtribuido - costoConocido) : null,
    origenes,
  };
}
