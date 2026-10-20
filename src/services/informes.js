import prisma from "../db.js";
import { atribuirCentavos, centavos, importeDecimal } from "./importes.js";

export class ErrorInforme extends Error {
  constructor(status, codigo, message) {
    super(message);
    this.status = status;
    this.codigo = codigo;
  }
}

const cero = "0.00";
const camposMonetarios = ["compras", "gastosAdicionales", "importeVentaAtribuido",
  "costoVendidoConocido", "costoRevertido", "importeReintegrado", "importeReintegroPendiente",
  "diferenciaCorrecciones", "diferenciaCompras", "devolucionesProveedor"];

function centavosConSigno(valor) {
  return valor.startsWith("-") ? -centavos(valor.slice(1)) : centavos(valor);
}

function limites(desde, hasta) {
  const inicio = new Date(`${desde}T00:00:00-03:00`);
  const fin = new Date(`${hasta}T00:00:00-03:00`);
  fin.setUTCDate(fin.getUTCDate() + 1);
  return { inicio, fin };
}

function enPeriodo(fecha, inicio, fin) {
  return fecha && fecha >= inicio && fecha < fin;
}

function coincide(filtros, { productoId, varianteId, proveedorId }) {
  return (!filtros.productoId || filtros.productoId === productoId)
    && (!filtros.varianteId || filtros.varianteId === varianteId)
    && (!filtros.proveedorId || filtros.proveedorId === proveedorId);
}

function centavosSeguro(valor) {
  return valor === null || valor === undefined ? null : centavos(valor.toFixed(2));
}

function nuevoEvento(tipo, id, fecha, origen, datos = {}) {
  const fechaVisible = ["compra", "gasto_compra"].includes(tipo)
    ? fecha.toISOString().slice(0, 10) : fecha.toISOString();
  return { id: `${tipo}:${id}`, tipo, fecha: fechaVisible,
    productoId: origen.productoId ?? null, varianteId: origen.varianteId ?? null,
    proveedorId: origen.proveedorId ?? null, ...datos };
}

function parteOrigen(asignacion, proveedoresOrigen) {
  return { productoId: asignacion.variante.productoId,
    varianteId: asignacion.varianteId,
    proveedorId: proveedoresOrigen.get(asignacion.partidaId) ?? null };
}

function columnasCero() {
  return Object.fromEntries(camposMonetarios.map((campo) => [campo, 0n]));
}

function resumir(eventos) {
  const sumas = columnasCero();
  let unidadesCostoDesconocido = 0;
  let coberturaDesconocida = false;
  for (const evento of eventos) {
    for (const campo of camposMonetarios) sumas[campo] += centavosConSigno(evento[campo] ?? cero);
    unidadesCostoDesconocido += evento.unidadesCostoDesconocido ?? 0;
    if (evento.costoDesconocido) coberturaDesconocida = true;
  }
  const margen = sumas.importeVentaAtribuido - sumas.costoVendidoConocido
    - sumas.importeReintegrado + sumas.costoRevertido - sumas.diferenciaCorrecciones;
  return { ...Object.fromEntries(camposMonetarios.map((campo) =>
    [campo, importeDecimal(sumas[campo])])),
  unidadesCostoDesconocido,
  margenBruto: coberturaDesconocida ? null : importeDecimal(margen),
  advertenciaCobertura: coberturaDesconocida ? "Hay unidades sin costo histórico conocido" : null };
}

/** Todos los hechos se fechan por su propio evento; no reescribe ventas de períodos anteriores. */
export async function informeComprasVentas(filtros) {
  const { inicio, fin } = limites(filtros.desde, filtros.hasta);
  const fechaCompra = { gte: new Date(`${filtros.desde}T00:00:00.000Z`),
    lte: new Date(`${filtros.hasta}T00:00:00.000Z`) };
  const [ingresos, ordenes, devoluciones, pagos, correcciones, proveedorDevuelto, movimientos,
    proveedoresRaiz,
    saldosDevoluciones] = await Promise.all([
    prisma.ingreso.findMany({ where: { estado: { in: ["confirmado", "anulado"] },
      fechaRecepcion: fechaCompra }, include: {
      lineas: { include: { variante: { select: { productoId: true } } } },
      gastosAdicionales: true,
    } }),
    prisma.orden.findMany({ where: { pagoConfirmadoEn: { gte: inicio, lt: fin } }, include: {
      detalles: { orderBy: { posicion: "asc" }, include: { asignacionesPartida: {
        where: { estado: { in: ["vendida", "revertida"] } },
        include: { partida: { include: { ingreso: { select: { proveedorId: true } } } },
          variante: { select: { productoId: true } } }, orderBy: { id: "asc" },
      } } },
    } }),
    prisma.devolucionCliente.findMany({ where: { aceptadaEn: { gte: inicio, lt: fin } }, include: {
      asignaciones: { include: { asignacion: { include: {
        partida: { include: { ingreso: { select: { proveedorId: true } } } },
        variante: { select: { productoId: true } },
      } } }, orderBy: { asignacionId: "asc" } },
    } }),
    prisma.pagoReintegro.findMany({ where: { fecha: { lt: fin } }, include: {
      devolucion: { include: { asignaciones: { include: { asignacion: { include: {
        partida: { include: { ingreso: { select: { proveedorId: true } } } },
        variante: { select: { productoId: true } },
      } } }, orderBy: { asignacionId: "asc" } } } },
    }, orderBy: [{ fecha: "asc" }, { id: "asc" }] }),
    prisma.correccionIngreso.findMany({ where: { fecha: { lt: fin } },
      include: { partida: { include: { ingreso: { select: { proveedorId: true,
        lineas: { select: { varianteId: true, cantidad: true, costoUnitario: true } } } },
        variante: { select: { productoId: true } } } } },
      orderBy: [{ fecha: "asc" }, { id: "asc" }] }),
    prisma.devolucionProveedor.findMany({ where: { fecha: { gte: inicio, lt: fin } },
      include: { partida: { include: { ingreso: { select: { proveedorId: true } },
        variante: { select: { productoId: true } } } } } }),
    prisma.movimientoInventario.findMany({ where: { fecha: { gte: inicio, lt: fin } },
      include: { variante: { select: { productoId: true } },
        partida: { include: { ingreso: { select: { proveedorId: true } } } } } }),
    prisma.$queryRaw`WITH RECURSIVE cadena AS (
      SELECT p."id" AS "partidaId", p."id" AS "actualId", p."ingresoId", p."asignacionOrigenId",
        ARRAY[p."id"] AS camino FROM "PartidaInventario" p
      UNION ALL
      SELECT c."partidaId", padre."id", padre."ingresoId", padre."asignacionOrigenId",
        c.camino || padre."id"
      FROM cadena c
      JOIN "AsignacionPartida" a ON a."id" = c."asignacionOrigenId"
      JOIN "PartidaInventario" padre ON padre."id" = a."partidaId"
      WHERE c."ingresoId" IS NULL AND NOT padre."id" = ANY(c.camino)
    )
    SELECT c."partidaId", i."proveedorId" FROM cadena c
    JOIN "Ingreso" i ON i."id" = c."ingresoId"`,
    prisma.devolucionCliente.findMany({ where: { aceptadaEn: { lt: fin } }, include: {
      pagos: { where: { fecha: { lt: fin } }, orderBy: [{ fecha: "asc" }, { id: "asc" }] },
      asignaciones: { include: { asignacion: { include: {
        partida: { include: { ingreso: { select: { proveedorId: true } } } },
        variante: { select: { productoId: true } },
      } } }, orderBy: { asignacionId: "asc" } },
    } }),
  ]);
  const proveedoresOrigen = new Map(proveedoresRaiz.map((fila) => [fila.partidaId, fila.proveedorId]));
  const eventos = [];
  let origenDesconocido = 0n;
  function agregar(evento, origen) {
    if (coincide(filtros, origen)) eventos.push(evento);
    if (evento.tipo === "venta" && origen.proveedorId === null
      && coincide({ ...filtros, proveedorId: undefined }, origen)) {
      origenDesconocido += centavos(evento.importeVentaAtribuido);
    }
  }
  for (const ingreso of ingresos) {
    for (const linea of ingreso.lineas.filter((item) => item.activo)) {
      const origen = { productoId: linea.variante.productoId,
        varianteId: linea.varianteId, proveedorId: ingreso.proveedorId };
      agregar(nuevoEvento("compra", `${ingreso.id}:${linea.id}`, ingreso.fechaRecepcion, origen, {
        ingresoId: ingreso.id, fechaCompra: ingreso.fechaCompra.toISOString().slice(0, 10),
        cantidad: linea.cantidad,
        compras: importeDecimal(centavosSeguro(linea.costoUnitario) * BigInt(linea.cantidad)),
      }), origen);
    }
    if (!filtros.productoId && !filtros.varianteId) {
      for (const gasto of ingreso.gastosAdicionales.filter((item) => item.activo)) {
        const origen = { proveedorId: ingreso.proveedorId };
        agregar(nuevoEvento("gasto_compra", `${ingreso.id}:${gasto.id}`, ingreso.fechaRecepcion,
          origen, { ingresoId: ingreso.id, concepto: gasto.concepto,
            gastosAdicionales: gasto.importe.toFixed(2) }), origen);
      }
    }
  }
  for (const orden of ordenes) {
    if (orden.detalles.length === 0) {
      const origen = { productoId: null, varianteId: null, proveedorId: null };
      agregar(nuevoEvento("venta", `sin-detalle:${orden.id}`, orden.pagoConfirmadoEn, origen, {
        ordenId: orden.id, cantidad: 0, importeVentaAtribuido: orden.subtotal.toFixed(2),
        costoVendidoConocido: cero, unidadesCostoDesconocido: 0, costoDesconocido: true,
      }), origen);
      continue;
    }
    const pesosLineas = orden.detalles.map((detalle) => centavos(detalle.importeLinea.toFixed(2)));
    const cuotas = atribuirCentavos(orden.subtotal.toFixed(2),
      pesosLineas.some((peso) => peso > 0n) ? pesosLineas
        : orden.detalles.map((detalle) => BigInt(detalle.cantidad)));
    for (const [indice, detalle] of orden.detalles.entries()) {
      let atribuido = 0n;
      let asignadas = 0;
      for (const asignacion of detalle.asignacionesPartida) {
        if (asignacion.importeEfectivo === null) continue;
        const origen = parteOrigen(asignacion, proveedoresOrigen);
        const importe = asignacion.importeEfectivo.toFixed(2);
        const costo = asignacion.costoUnitarioAlPago === null ? null
          : importeDecimal(centavosSeguro(asignacion.costoUnitarioAlPago) * BigInt(asignacion.cantidad));
        agregar(nuevoEvento("venta", asignacion.id, orden.pagoConfirmadoEn, origen, {
          ordenId: orden.id, cantidad: asignacion.cantidad,
          importeVentaAtribuido: importe, costoVendidoConocido: costo ?? cero,
          unidadesCostoDesconocido: costo === null ? asignacion.cantidad : 0,
          costoDesconocido: costo === null,
        }), origen);
        atribuido += centavos(importe);
        asignadas += asignacion.cantidad;
      }
      const faltante = centavos(cuotas[indice]) - atribuido;
      if (faltante < 0n) throw new ErrorInforme(409, "VENTA_INCONCILIABLE", "La venta supera su importe efectivo");
      if (faltante > 0n || asignadas < detalle.cantidad) {
        const origen = { productoId: detalle.productoId, varianteId: detalle.talleProductoId,
          proveedorId: null };
        agregar(nuevoEvento("venta", `sin-origen:${detalle.id}`, orden.pagoConfirmadoEn, origen, {
          ordenId: orden.id, cantidad: detalle.cantidad - asignadas,
          importeVentaAtribuido: importeDecimal(faltante), costoVendidoConocido: cero,
          unidadesCostoDesconocido: detalle.cantidad - asignadas, costoDesconocido: true,
        }), origen);
      }
    }
  }
  for (const devolucion of devoluciones) {
    for (const parte of devolucion.asignaciones) {
      const origen = parteOrigen(parte.asignacion, proveedoresOrigen);
      agregar(nuevoEvento("devolucion_cliente", parte.id, devolucion.aceptadaEn, origen, {
        devolucionId: devolucion.id, cantidad: parte.cantidad,
        costoRevertido: parte.costoRevertido?.toFixed(2) ?? cero,
        importeReintegroPendiente: parte.importeEfectivo.toFixed(2),
        unidadesCostoDesconocido: parte.costoRevertido === null ? -parte.cantidad : 0,
        costoDesconocido: parte.costoRevertido === null,
      }), origen);
    }
  }
  const pagosAcumulados = new Map();
  for (const pago of pagos) {
    const partes = pago.devolucion.asignaciones;
    const pesos = partes.map((parte) => centavos(parte.importeEfectivo.toFixed(2)));
    const anterior = pagosAcumulados.get(pago.devolucionId) ?? 0n;
    const actual = anterior + centavos(pago.importeEfectivo.toFixed(2));
    pagosAcumulados.set(pago.devolucionId, actual);
    if (!enPeriodo(pago.fecha, inicio, fin)) continue;
    const cuotasAnteriores = atribuirCentavos(importeDecimal(anterior), pesos);
    const cuotasActuales = atribuirCentavos(importeDecimal(actual), pesos);
    for (const [indice, parte] of partes.entries()) {
      const origen = parteOrigen(parte.asignacion, proveedoresOrigen);
      const cuota = importeDecimal(centavos(cuotasActuales[indice]) - centavos(cuotasAnteriores[indice]));
      agregar(nuevoEvento("reintegro", `${pago.id}:${parte.id}`, pago.fecha, origen, {
        devolucionId: pago.devolucionId, importeReintegrado: cuota,
        importeReintegroPendiente: importeDecimal(-centavos(cuota)),
      }), origen);
    }
  }
  const estadoPartidas = new Map();
  for (const correccion of correcciones) {
    let estado = estadoPartidas.get(correccion.partidaId);
    if (!estado) {
      const linea = correccion.partida.ingreso?.lineas.find((item) =>
        item.varianteId === correccion.partida.varianteId);
      if (!linea) throw new ErrorInforme(409, "CORRECCION_INCONCILIABLE", "La partida corregida no tiene línea original");
      estado = { cantidad: linea.cantidad, costo: centavos(linea.costoUnitario.toFixed(2)) };
      estadoPartidas.set(correccion.partidaId, estado);
    }
    let diferenciaCompra = 0n;
    if (correccion.campo === "cantidad") {
      const nuevo = Number(correccion.valorNuevo);
      if (!Number.isSafeInteger(nuevo) || nuevo < 0) {
        throw new ErrorInforme(409, "CORRECCION_INCONCILIABLE", "Cantidad corregida inválida");
      }
      diferenciaCompra = BigInt(nuevo - estado.cantidad) * estado.costo;
      estado.cantidad = nuevo;
    } else if (correccion.campo === "costoUnitario") {
      const nuevo = centavos(String(correccion.valorNuevo));
      diferenciaCompra = (nuevo - estado.costo) * BigInt(estado.cantidad);
      estado.costo = nuevo;
    } else if (correccion.campo === "estado" && correccion.valorNuevo === "anulado") {
      diferenciaCompra = -estado.costo * BigInt(estado.cantidad);
      estado.cantidad = 0;
    }
    if (!enPeriodo(correccion.fecha, inicio, fin)) continue;
    const origen = { productoId: correccion.partida.variante.productoId,
      varianteId: correccion.partida.varianteId,
      proveedorId: correccion.partida.ingreso?.proveedorId ?? null };
    agregar(nuevoEvento("correccion_ingreso", correccion.id, correccion.fecha, origen, {
      ingresoId: correccion.ingresoId, partidaId: correccion.partidaId,
      campo: correccion.campo, diferenciaCompras: importeDecimal(diferenciaCompra),
      diferenciaCorrecciones: correccion.campo === "costoUnitario"
        ? correccion.diferenciaCosto?.toFixed(2) ?? cero : cero,
    }), origen);
  }
  for (const devolucion of proveedorDevuelto) {
    const origen = { productoId: devolucion.partida.variante.productoId,
      varianteId: devolucion.partida.varianteId,
      proveedorId: devolucion.partida.ingreso?.proveedorId ?? null };
    agregar(nuevoEvento("devolucion_proveedor", devolucion.id, devolucion.fecha, origen, {
      ingresoId: devolucion.ingresoId, partidaId: devolucion.partidaId,
      cantidad: devolucion.cantidad, devolucionesProveedor: devolucion.importeRevertido.toFixed(2),
    }), origen);
  }
  for (const movimiento of movimientos) {
    const origen = { productoId: movimiento.variante.productoId,
      varianteId: movimiento.varianteId,
      proveedorId: proveedoresOrigen.get(movimiento.partidaId) ?? null };
    agregar(nuevoEvento("movimiento_inventario", movimiento.id, movimiento.fecha, origen, {
      partidaId: movimiento.partidaId, movimientoTipo: movimiento.tipo,
      cantidad: movimiento.cantidad, motivo: movimiento.motivo,
    }), origen);
  }
  eventos.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.id.localeCompare(b.id));
  const totalResultados = eventos.length;
  const pagina = filtros.pagina ?? 1;
  const limite = filtros.limite ?? 20;
  let obligacionPendiente = 0n;
  for (const devolucion of saldosDevoluciones) {
    if (devolucion.cerradoEn && devolucion.cerradoEn < fin) continue;
    const partes = devolucion.asignaciones;
    const pesos = partes.map((parte) => centavos(parte.importeEfectivo.toFixed(2)));
    const pagado = devolucion.pagos.reduce((total, pago) =>
      total + centavos(pago.importeEfectivo.toFixed(2)), 0n);
    const pagosPorParte = atribuirCentavos(importeDecimal(pagado), pesos).map(centavos);
    for (const [indice, parte] of partes.entries()) {
      if (!coincide(filtros, parteOrigen(parte.asignacion, proveedoresOrigen))) continue;
      obligacionPendiente += pesos[indice] - pagosPorParte[indice];
    }
  }
  const resumen = { ...resumir(eventos), importeReintegroPendiente: importeDecimal(obligacionPendiente) };
  return { filtros, resumen, origenDesconocido: importeDecimal(origenDesconocido),
    totalResultados, pagina, limite, paginas: Math.ceil(totalResultados / limite),
    datos: eventos.slice((pagina - 1) * limite, pagina * limite) };
}

export async function historialProducto(productoId, filtros) {
  const producto = await prisma.producto.findUnique({ where: { id: productoId },
    include: { talles: { select: { id: true, stock: true } } } });
  if (!producto) throw new ErrorInforme(404, "PRODUCTO_NO_ENCONTRADO", "Producto no encontrado");
  const [informe, precios] = await Promise.all([
    informeComprasVentas({ ...filtros, productoId }),
    prisma.vigenciaPrecio.findMany({ where: { productoId,
      inicio: { lt: limites(filtros.desde, filtros.hasta).fin },
      OR: [{ fin: null }, { fin: { gt: limites(filtros.desde, filtros.hasta).inicio } }],
    }, orderBy: [{ inicio: "asc" }, { id: "asc" }] }),
  ]);
  return { ...informe, producto: { id: producto.id, nombre: producto.nombre,
    stockFisicoActual: producto.talles.reduce((total, variante) => total + variante.stock, 0) },
  precios: precios.map((precio) => ({ clase: precio.clase, importe: precio.importe.toString(),
    inicio: precio.inicio.toISOString(), fin: precio.fin?.toISOString() ?? null, origen: precio.origen })),
  promocionEnPeriodo: precios.some((precio) => precio.clase === "promocional") };
}
