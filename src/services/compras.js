import prisma from "../db.js";
import { createHash } from "node:crypto";
import { centavos, importeDecimal } from "./importes.js";
import { validarCantidad, validarFecha, validarIdentificador, validarImporte } from "../utils/validate-compras.js";
import { bloquearVariantes, ErrorInventario, estadoInventarioParaEscritura, horaBaseDatos } from "./inventario.js";
import { ErrorPartidas, saldosPartidasBloqueadas } from "./partidas.js";

export class ErrorCompra extends Error {
  constructor(status, codigo, message, campos = []) {
    super(message);
    this.status = status;
    this.codigo = codigo;
    this.campos = campos;
  }
}

function validarEntrada(entrada) {
  const campos = [];
  if (validarIdentificador(entrada.proveedorId, "proveedorId")) campos.push("proveedorId");
  if (validarFecha(entrada.fechaCompra, "fechaCompra")) campos.push("fechaCompra");
  if (validarFecha(entrada.fechaRecepcion, "fechaRecepcion")) campos.push("fechaRecepcion");
  if (!campos.includes("fechaCompra") && !campos.includes("fechaRecepcion")
    && entrada.fechaRecepcion < entrada.fechaCompra) campos.push("fechaRecepcion");
  if (!Array.isArray(entrada.lineas) || entrada.lineas.length === 0) campos.push("lineas");
  const variantes = new Set();
  for (const [indice, linea] of (Array.isArray(entrada.lineas) ? entrada.lineas : []).entries()) {
    if (!linea || typeof linea !== "object" || Array.isArray(linea)
      || Object.keys(linea).some((campo) => !["varianteId", "cantidad", "costoUnitario"].includes(campo))) {
      campos.push(`lineas.${indice}`);
      continue;
    }
    if (validarIdentificador(linea.varianteId, "varianteId")) campos.push(`lineas.${indice}.varianteId`);
    if (validarCantidad(linea.cantidad)) campos.push(`lineas.${indice}.cantidad`);
    if (validarImporte(linea.costoUnitario, "costoUnitario")) campos.push(`lineas.${indice}.costoUnitario`);
    if (variantes.has(linea.varianteId)) campos.push(`lineas.${indice}.varianteId`);
    variantes.add(linea.varianteId);
  }
  if (entrada.gastosAdicionales !== undefined && !Array.isArray(entrada.gastosAdicionales)) {
    campos.push("gastosAdicionales");
  }
  for (const [indice, gasto] of (Array.isArray(entrada.gastosAdicionales) ? entrada.gastosAdicionales : []).entries()) {
    if (!gasto || typeof gasto !== "object" || Array.isArray(gasto)
      || Object.keys(gasto).some((campo) => !["concepto", "importe"].includes(campo))) {
      campos.push(`gastosAdicionales.${indice}`);
      continue;
    }
    if (typeof gasto.concepto !== "string" || !gasto.concepto.trim() || gasto.concepto.length > 200) {
      campos.push(`gastosAdicionales.${indice}.concepto`);
    }
    if (validarImporte(gasto.importe)) campos.push(`gastosAdicionales.${indice}.importe`);
  }
  for (const campo of ["observaciones", "comprobanteReferencia"]) {
    if (entrada[campo] !== undefined && entrada[campo] !== null
      && (typeof entrada[campo] !== "string" || entrada[campo].length > 1000)) campos.push(campo);
  }
  if (campos.length) throw new ErrorCompra(400, "ENTRADA_INVALIDA", "Revisá los campos indicados", [...new Set(campos)]);
}

function importesIngreso(ingreso) {
  const mercaderia = ingreso.lineas.filter((linea) => linea.activo).reduce(
    (suma, linea) => suma + centavos(linea.costoUnitario.toString()) * BigInt(linea.cantidad), 0n,
  );
  const gastos = ingreso.gastosAdicionales.filter((gasto) => gasto.activo).reduce(
    (suma, gasto) => suma + centavos(gasto.importe.toString()), 0n,
  );
  return {
    importeMercaderia: importeDecimal(mercaderia),
    gastosAdicionales: importeDecimal(gastos),
    totalDesembolso: importeDecimal(mercaderia + gastos),
  };
}

function huellaResumenIngreso(ingreso) {
  const contenido = {
    id: ingreso.id,
    proveedorId: ingreso.proveedorId,
    fechaCompra: ingreso.fechaCompra.toISOString().slice(0, 10),
    fechaRecepcion: ingreso.fechaRecepcion.toISOString().slice(0, 10),
    lineas: ingreso.lineas.filter((linea) => linea.activo).map((linea) => ({
      varianteId: linea.varianteId, cantidad: linea.cantidad, costoUnitario: linea.costoUnitario.toFixed(2),
    })).sort((a, b) => a.varianteId - b.varianteId),
    gastos: ingreso.gastosAdicionales.filter((gasto) => gasto.activo).map((gasto) => ({
      id: gasto.id, concepto: gasto.concepto, importe: gasto.importe.toFixed(2),
    })).sort((a, b) => a.id - b.id),
  };
  return createHash("sha256").update(JSON.stringify(contenido)).digest("hex");
}

const detalleIngreso = {
  proveedor: { select: { id: true, nombre: true, activo: true } },
  lineas: { include: { variante: { select: { id: true, productoId: true, estado: true } } } },
  gastosAdicionales: true,
  partidas: { select: { id: true, varianteId: true, cantidadOriginal: true, costoUnitario: true } },
  correcciones: { orderBy: [{ fecha: "asc" }, { id: "asc" }] },
  devolucionesProveedor: { orderBy: [{ fecha: "asc" }, { id: "asc" }] },
};

export async function obtenerIngreso(id, tx = prisma) {
  const ingreso = await tx.ingreso.findUnique({ where: { id }, include: detalleIngreso });
  if (!ingreso) return null;
  return {
    ...ingreso,
    gastosCompra: ingreso.gastosAdicionales,
    ...importesIngreso(ingreso),
    huellaResumen: huellaResumenIngreso(ingreso),
  };
}

export async function crearBorradorIngreso(entrada) {
  validarEntrada(entrada);
  return prisma.$transaction(async (tx) => {
    const proveedor = await tx.proveedor.findUnique({ where: { id: entrada.proveedorId }, select: { activo: true } });
    if (!proveedor?.activo) throw new ErrorCompra(409, "PROVEEDOR_INACTIVO", "Seleccioná un proveedor activo", ["proveedorId"]);
    const variantes = await tx.talleProducto.findMany({
      where: { id: { in: entrada.lineas.map((linea) => linea.varianteId) } },
      select: { id: true },
    });
    if (variantes.length !== entrada.lineas.length) throw new ErrorCompra(400, "VARIANTE_INVALIDA", "Una variante no existe", ["lineas"]);
    const ingreso = await tx.ingreso.create({
      data: {
        proveedorId: entrada.proveedorId,
        fechaCompra: new Date(`${entrada.fechaCompra}T00:00:00.000Z`),
        fechaRecepcion: new Date(`${entrada.fechaRecepcion}T00:00:00.000Z`),
        observaciones: entrada.observaciones?.trim() || null,
        comprobanteReferencia: entrada.comprobanteReferencia?.trim() || null,
        lineas: { create: entrada.lineas.map((linea) => ({
          varianteId: linea.varianteId, cantidad: linea.cantidad, costoUnitario: linea.costoUnitario,
        })) },
        gastosAdicionales: { create: (entrada.gastosAdicionales ?? []).map((gasto) => ({
          concepto: gasto.concepto.trim(), importe: gasto.importe,
        })) },
      },
    });
    return obtenerIngreso(ingreso.id, tx);
  });
}

export async function editarBorradorIngreso(id, entrada) {
  validarEntrada(entrada);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Ingreso" WHERE "id" = ${id} FOR UPDATE`;
    const actual = await tx.ingreso.findUnique({ where: { id }, include: { lineas: true } });
    if (!actual) throw new ErrorCompra(404, "INGRESO_NO_ENCONTRADO", "Ingreso no encontrado");
    if (actual.estado !== "borrador") throw new ErrorCompra(409, "INGRESO_NO_EDITABLE", "El ingreso ya no es un borrador");
    const proveedor = await tx.proveedor.findUnique({ where: { id: entrada.proveedorId }, select: { activo: true } });
    if (!proveedor?.activo) throw new ErrorCompra(409, "PROVEEDOR_INACTIVO", "Seleccioná un proveedor activo", ["proveedorId"]);
    const variantes = await tx.talleProducto.findMany({
      where: { id: { in: entrada.lineas.map((linea) => linea.varianteId) } }, select: { id: true },
    });
    if (variantes.length !== entrada.lineas.length) throw new ErrorCompra(400, "VARIANTE_INVALIDA", "Una variante no existe", ["lineas"]);
    await tx.ingreso.update({
      where: { id },
      data: {
        proveedorId: entrada.proveedorId,
        fechaCompra: new Date(`${entrada.fechaCompra}T00:00:00.000Z`),
        fechaRecepcion: new Date(`${entrada.fechaRecepcion}T00:00:00.000Z`),
        observaciones: entrada.observaciones?.trim() || null,
        comprobanteReferencia: entrada.comprobanteReferencia?.trim() || null,
      },
    });
    const porVariante = new Map(actual.lineas.map((linea) => [linea.varianteId, linea]));
    const presentes = new Set(entrada.lineas.map((linea) => linea.varianteId));
    for (const previa of actual.lineas) {
      if (!presentes.has(previa.varianteId) && previa.activo) {
        await tx.lineaIngreso.update({ where: { id: previa.id }, data: { activo: false } });
      }
    }
    for (const linea of entrada.lineas) {
      const previa = porVariante.get(linea.varianteId);
      if (previa) {
        await tx.lineaIngreso.update({
          where: { id: previa.id },
          data: { cantidad: linea.cantidad, costoUnitario: linea.costoUnitario, activo: true },
        });
      } else {
        await tx.lineaIngreso.create({ data: { ingresoId: id, ...linea } });
      }
    }
    await tx.gastoAdicionalCompra.updateMany({ where: { ingresoId: id, activo: true }, data: { activo: false } });
    for (const gasto of entrada.gastosAdicionales ?? []) {
      await tx.gastoAdicionalCompra.create({
        data: { ingresoId: id, concepto: gasto.concepto.trim(), importe: gasto.importe },
      });
    }
    return obtenerIngreso(id, tx);
  });
}

export async function listarIngresos({ proveedorId, estado, desde, hasta, productoId, varianteId, pagina = 1, limite = 20 }) {
  const where = {
    ...(proveedorId ? { proveedorId } : {}),
    ...(estado ? { estado } : {}),
    ...(desde || hasta ? { fechaRecepcion: {
      ...(desde ? { gte: new Date(`${desde}T00:00:00.000Z`) } : {}),
      ...(hasta ? { lte: new Date(`${hasta}T00:00:00.000Z`) } : {}),
    } } : {}),
    ...(productoId || varianteId ? { lineas: { some: {
      activo: true,
      ...(varianteId ? { varianteId } : {}),
      ...(productoId ? { variante: { productoId } } : {}),
    } } } : {}),
  };
  const [total, datos] = await prisma.$transaction([
    prisma.ingreso.count({ where }),
    prisma.ingreso.findMany({
      where,
      include: { proveedor: { select: { id: true, nombre: true } } },
      orderBy: [{ fechaRecepcion: "desc" }, { id: "desc" }],
      skip: (pagina - 1) * limite,
      take: limite,
    }),
  ]);
  return { datos, total, pagina, limite };
}

export async function resumenIngreso(id) {
  const ingreso = await obtenerIngreso(id);
  if (!ingreso) throw new ErrorCompra(404, "INGRESO_NO_ENCONTRADO", "Ingreso no encontrado");
  if (ingreso.estado !== "borrador") throw new ErrorCompra(409, "INGRESO_NO_EDITABLE", "El ingreso ya no es un borrador");
  const campos = [];
  if (!ingreso.proveedor.activo) campos.push("proveedorId");
  if (!ingreso.lineas.some((linea) => linea.activo)) campos.push("lineas");
  if (campos.length) throw new ErrorCompra(409, "INGRESO_BLOQUEADO", "Corregí el ingreso antes de confirmar", campos);
  return ingreso;
}

export async function confirmarIngreso(id, { claveOperacion, resumenAceptado }, actorUsuarioId) {
  if (typeof claveOperacion !== "string" || !claveOperacion.trim() || claveOperacion.length > 100
    || typeof resumenAceptado !== "string" || !/^[a-f0-9]{64}$/.test(resumenAceptado)) {
    throw new ErrorCompra(400, "ENTRADA_INVALIDA", "Indicá clave de operación y resumen válido");
  }
  const huellaSolicitud = createHash("sha256").update(JSON.stringify({ id, claveOperacion, resumenAceptado })).digest("hex");
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Ingreso" WHERE "id" = ${id} FOR UPDATE`;
      const ingreso = await obtenerIngreso(id, tx);
      if (!ingreso) throw new ErrorCompra(404, "INGRESO_NO_ENCONTRADO", "Ingreso no encontrado");
      if (ingreso.estado === "confirmado") {
        if (ingreso.claveOperacion === claveOperacion && ingreso.huellaSolicitud === huellaSolicitud) {
          return { ...ingreso, reiterada: true };
        }
        throw new ErrorCompra(409, "INGRESO_YA_CONFIRMADO", "El ingreso ya fue confirmado con otra intención");
      }
      if (ingreso.estado !== "borrador") throw new ErrorCompra(409, "INGRESO_NO_CONFIRMABLE", "El ingreso no admite confirmación");
      if (ingreso.huellaResumen !== resumenAceptado) {
        throw new ErrorCompra(409, "RESUMEN_CAMBIO", "El ingreso cambió; revisá el resumen vigente");
      }
      // La desactivación del proveedor toma FOR UPDATE sobre esta misma fila.
      // Mantener el bloqueo hasta el commit evita confirmar contra un estado obsoleto.
      const [proveedor] = await tx.$queryRaw`SELECT "activo" FROM "Proveedor" WHERE "id" = ${ingreso.proveedorId} FOR SHARE`;
      if (!proveedor?.activo) throw new ErrorCompra(409, "PROVEEDOR_INACTIVO", "El proveedor está inactivo");
      const lineas = ingreso.lineas.filter((linea) => linea.activo);
      if (!lineas.length) throw new ErrorCompra(409, "INGRESO_SIN_LINEAS", "El ingreso no tiene líneas activas");
      // La activación y la suspensión del corte bloquean esta fila en exclusiva.
      // Leerla antes de bloquear variantes mantiene el mismo orden de bloqueos.
      await tx.$executeRaw`INSERT INTO "EstadoCorteInventario" ("id", "actualizadoEn")
        VALUES (1, clock_timestamp()) ON CONFLICT ("id") DO NOTHING`;
      await tx.$queryRaw`SELECT "id" FROM "EstadoCorteInventario" WHERE "id" = 1 FOR SHARE`;
      const corte = await tx.estadoCorteInventario.findUnique({ where: { id: 1 }, select: { id: true, estado: true, suspendido: true } });
      if (corte?.suspendido) {
        throw new ErrorCompra(409, "INVENTARIO_SUSPENDIDO", "El inventario está suspendido durante el corte");
      }
      const ids = await bloquearVariantes(tx, lineas.map((linea) => linea.varianteId));
      const variantes = await tx.talleProducto.findMany({
        where: { id: { in: ids } }, select: { id: true, stock: true, inicioInventarioCero: true },
      });
      if (variantes.length !== ids.length) throw new ErrorCompra(409, "VARIANTE_INVALIDA", "Una variante dejó de existir");
      const estados = corte?.estado === "activo"
        ? await tx.estadoCorteVariante.findMany({
          where: { varianteId: { in: ids }, corteId: corte.id },
          select: { varianteId: true, estado: true },
        })
        : [];
      const incorporadas = new Set(estados.filter((estado) => estado.estado === "conciliado").map((estado) => estado.varianteId));
      for (const variante of variantes) {
        if (corte?.estado === "activo" ? !incorporadas.has(variante.id) : !variante.inicioInventarioCero) {
          throw new ErrorCompra(409, "VARIANTE_HEREDADA", "La variante necesita el corte inicial antes de recibir mercadería");
        }
        let saldos;
        try {
          saldos = await saldosPartidasBloqueadas(tx, variante.id, variante.stock);
        } catch (error) {
          if (error instanceof ErrorPartidas) {
            throw new ErrorCompra(409, error.codigo, error.message);
          }
          throw error;
        }
        const [reservasPrevias, movimientosPrevios] = saldos.length === 0
          ? await Promise.all([
            tx.reservaStock.count({ where: { talleProductoId: variante.id } }),
            tx.movimientoInventario.count({ where: { varianteId: variante.id } }),
          ])
          : [0, 0];
        if (saldos.length === 0 && (variante.stock !== 0 || reservasPrevias > 0 || movimientosPrevios > 0)) {
          throw new ErrorCompra(409, "VARIANTE_NO_INICIAL", "La variante tiene stock o reservas previas sin partida");
        }
      }
      const ahora = await horaBaseDatos(tx);
      for (const linea of lineas) {
        const partida = await tx.partidaInventario.create({
          data: {
            varianteId: linea.varianteId,
            ingresoId: id,
            origen: "ingreso",
            cantidadOriginal: linea.cantidad,
            costoUnitario: linea.costoUnitario,
            fechaRecepcion: ingreso.fechaRecepcion,
            confirmadaEn: ahora,
          },
        });
        await tx.movimientoInventario.create({
          data: {
            varianteId: linea.varianteId,
            partidaId: partida.id,
            ingresoId: id,
            tipo: "recepcion",
            cantidad: linea.cantidad,
            actorUsuarioId,
            fecha: ahora,
          },
        });
        await tx.talleProducto.update({
          where: { id: linea.varianteId }, data: { stock: { increment: linea.cantidad } },
        });
      }
      await tx.ingreso.update({
        where: { id },
        data: { estado: "confirmado", claveOperacion, huellaSolicitud, confirmadoEn: ahora, confirmadoPorId: actorUsuarioId },
      });
      return { ...await obtenerIngreso(id, tx), reiterada: false };
    });
  } catch (error) {
    if (error.code === "P2002") throw new ErrorCompra(409, "CLAVE_EN_CONFLICTO", "La clave de operación ya se usó en otro ingreso");
    throw error;
  }
}

function validarCorreccion(entrada, actorUsuarioId) {
  const campos = [];
  if (validarIdentificador(entrada?.partidaId, "partidaId")) campos.push("partidaId");
  if (!["cantidad", "costoUnitario"].includes(entrada?.campo)) campos.push("campo");
  if (entrada?.campo === "cantidad" && validarCantidad(entrada.valorNuevo)) campos.push("valorNuevo");
  if (entrada?.campo === "costoUnitario" && validarImporte(entrada.valorNuevo)) campos.push("valorNuevo");
  if (typeof entrada?.motivo !== "string" || !entrada.motivo.trim() || entrada.motivo.trim().length > 500) campos.push("motivo");
  if (typeof entrada?.claveOperacion !== "string" || !entrada.claveOperacion.trim()
    || entrada.claveOperacion.length > 100) campos.push("claveOperacion");
  if (validarIdentificador(actorUsuarioId, "actorUsuarioId")) campos.push("actorUsuarioId");
  if (campos.length) throw new ErrorCompra(400, "ENTRADA_INVALIDA", "Revisá los campos indicados", campos);
}

function esMismaCorreccion(correccion, ingresoId, entrada, motivo) {
  return correccion.ingresoId === ingresoId && correccion.partidaId === entrada.partidaId
    && correccion.campo === entrada.campo && correccion.motivo === motivo
    && correccion.valorNuevo === entrada.valorNuevo;
}

/** Conserva el valor anterior en un evento; la variante y sus partidas se bloquean antes de cambiar saldos. */
export async function corregirIngreso(ingresoId, entrada, actorUsuarioId) {
  if (validarIdentificador(ingresoId, "ingresoId")) {
    throw new ErrorCompra(400, "ENTRADA_INVALIDA", "Indicá un ingreso válido", ["ingresoId"]);
  }
  validarCorreccion(entrada, actorUsuarioId);
  entrada = { ...entrada, valorNuevo: entrada.campo === "costoUnitario"
    ? importeDecimal(centavos(entrada.valorNuevo)) : entrada.valorNuevo };
  const motivo = entrada.motivo.trim();
  const claveOperacion = entrada.claveOperacion.trim();
  const previa = await prisma.correccionIngreso.findUnique({ where: { claveOperacion } });
  if (previa) {
    if (!esMismaCorreccion(previa, ingresoId, entrada, motivo)) {
      throw new ErrorCompra(409, "CLAVE_EN_CONFLICTO", "La clave de operación ya corresponde a otra corrección");
    }
    return { ...previa, reiterada: true };
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Ingreso" WHERE "id" = ${ingresoId} FOR UPDATE`;
      const ingreso = await tx.ingreso.findUnique({ where: { id: ingresoId }, select: { estado: true } });
      if (!ingreso) throw new ErrorCompra(404, "INGRESO_NO_ENCONTRADO", "Ingreso no encontrado");
      if (ingreso.estado !== "confirmado") {
        throw new ErrorCompra(409, "INGRESO_NO_CORREGIBLE", "Solo se puede corregir un ingreso confirmado");
      }
      const partida = await tx.partidaInventario.findFirst({
        where: { id: entrada.partidaId, ingresoId },
        select: { id: true, varianteId: true, cantidadOriginal: true, costoUnitario: true },
      });
      if (!partida) throw new ErrorCompra(404, "PARTIDA_NO_ENCONTRADA", "La partida no pertenece al ingreso");
      try {
        await estadoInventarioParaEscritura(tx);
      } catch (error) {
        if (error instanceof ErrorInventario) throw new ErrorCompra(409, error.codigo, error.message);
        throw error;
      }
      await bloquearVariantes(tx, [partida.varianteId]);
      const variante = await tx.talleProducto.findUnique({ where: { id: partida.varianteId }, select: { stock: true } });
      let saldos;
      try {
        saldos = await saldosPartidasBloqueadas(tx, partida.varianteId, variante.stock);
      } catch (error) {
        if (error instanceof ErrorPartidas) throw new ErrorCompra(409, error.codigo, error.message);
        throw error;
      }
      const saldo = saldos.find((item) => item.partida.id === partida.id);
      if (!saldo) throw new ErrorCompra(409, "PARTIDA_INCONCILIABLE", "La partida no coincide con el inventario");
      const anterior = entrada.campo === "cantidad" ? partida.cantidadOriginal : partida.costoUnitario?.toFixed(2);
      if (anterior === null) throw new ErrorCompra(409, "COSTO_DESCONOCIDO", "La partida no tiene costo corregible");
      if (anterior === entrada.valorNuevo) throw new ErrorCompra(409, "SIN_CAMBIOS", "El valor nuevo coincide con el anterior");
      const diferencia = entrada.campo === "cantidad" ? entrada.valorNuevo - partida.cantidadOriginal : 0;
      if (diferencia < 0 && -diferencia > saldo.libre) {
        throw new ErrorCompra(409, "STOCK_COMPROMETIDO", "La corrección invade unidades reservadas o vendidas");
      }
      let diferenciaCosto = 0n;
      const ahora = await horaBaseDatos(tx);
      if (entrada.campo === "cantidad") {
        await tx.partidaInventario.update({ where: { id: partida.id }, data: { cantidadOriginal: entrada.valorNuevo } });
        await tx.movimientoInventario.create({ data: { varianteId: partida.varianteId, partidaId: partida.id,
          ingresoId, tipo: "correccion_ingreso", cantidad: diferencia, motivo,
          actorUsuarioId, fecha: ahora } });
        await tx.talleProducto.update({ where: { id: partida.varianteId }, data: { stock: { increment: diferencia } } });
      } else {
        const asignaciones = await tx.asignacionPartida.findMany({
          where: { partidaId: partida.id, estado: { in: ["vendida", "revertida"] } },
          select: { id: true, cantidad: true, devolucionesCliente: {
            select: { id: true, devolucionId: true, cantidad: true },
          } },
        });
        let unidadesVendidasNetas = 0;
        for (const asignacion of asignaciones) {
          const devueltas = asignacion.devolucionesCliente.reduce((total, item) => total + item.cantidad, 0);
          if (devueltas > asignacion.cantidad) {
            throw new ErrorCompra(409, "DEVOLUCION_INCONCILIABLE", "Una devolución supera su asignación de origen");
          }
          unidadesVendidasNetas += asignacion.cantidad - devueltas;
        }
        diferenciaCosto = (centavos(entrada.valorNuevo) - centavos(anterior))
          * BigInt(unidadesVendidasNetas);
        await tx.partidaInventario.update({ where: { id: partida.id }, data: { costoUnitario: entrada.valorNuevo } });
      }
      const correccion = await tx.correccionIngreso.create({ data: { ingresoId, partidaId: partida.id,
        campo: entrada.campo, valorAnterior: anterior, valorNuevo: entrada.valorNuevo,
        diferenciaCosto: importeDecimal(diferenciaCosto), motivo, claveOperacion,
        actorUsuarioId, fecha: ahora } });
      return { ...correccion, reiterada: false };
    });
  } catch (error) {
    if (error.code === "P2002") {
      const ganadora = await prisma.correccionIngreso.findUnique({ where: { claveOperacion } });
      if (ganadora && esMismaCorreccion(ganadora, ingresoId, entrada, motivo)) {
        return { ...ganadora, reiterada: true };
      }
      throw new ErrorCompra(409, "CLAVE_EN_CONFLICTO", "La clave de operación ya corresponde a otra corrección");
    }
    throw error;
  }
}

function validarAnulacion(ingresoId, entrada, actorUsuarioId) {
  const campos = [];
  if (validarIdentificador(ingresoId, "ingresoId")) campos.push("ingresoId");
  if (typeof entrada?.motivo !== "string" || !entrada.motivo.trim()
    || entrada.motivo.trim().length > 500) campos.push("motivo");
  if (typeof entrada?.claveOperacion !== "string" || !entrada.claveOperacion.trim()
    || entrada.claveOperacion.length > 100) campos.push("claveOperacion");
  if (validarIdentificador(actorUsuarioId, "actorUsuarioId")) campos.push("actorUsuarioId");
  if (campos.length) throw new ErrorCompra(400, "ENTRADA_INVALIDA", "Revisá los campos indicados", campos);
}

function claveEventoAnulacion(ingresoId, claveOperacion, partidaId) {
  const huella = createHash("sha256").update(claveOperacion).digest("hex");
  return `anulacion:${ingresoId}:${huella}:${partidaId}`;
}

/** Compensa una recepción completa solo si ninguna unidad de sus partidas fue comprometida o retirada. */
export async function anularIngreso(ingresoId, entrada, actorUsuarioId) {
  validarAnulacion(ingresoId, entrada, actorUsuarioId);
  const motivo = entrada.motivo.trim();
  const claveOperacion = entrada.claveOperacion.trim();
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Ingreso" WHERE "id" = ${ingresoId} FOR UPDATE`;
    const ingreso = await tx.ingreso.findUnique({ where: { id: ingresoId },
      include: { partidas: { orderBy: { id: "asc" } } } });
    if (!ingreso) throw new ErrorCompra(404, "INGRESO_NO_ENCONTRADO", "Ingreso no encontrado");
    const primera = ingreso.partidas[0];
    if (ingreso.estado === "anulado") {
      const evento = primera && await tx.correccionIngreso.findUnique({
        where: { claveOperacion: claveEventoAnulacion(ingresoId, claveOperacion, primera.id) },
      });
      if (evento?.campo === "estado" && evento.motivo === motivo
        && evento.valorAnterior === "confirmado" && evento.valorNuevo === "anulado") {
        return { ...await obtenerIngreso(ingresoId, tx), reiterada: true };
      }
      throw new ErrorCompra(409, "INGRESO_YA_ANULADO", "El ingreso fue anulado con otra intención");
    }
    if (ingreso.estado !== "confirmado" || !primera) {
      throw new ErrorCompra(409, "INGRESO_NO_ANULABLE", "Solo se puede anular un ingreso confirmado con partidas");
    }
    try {
      await estadoInventarioParaEscritura(tx);
    } catch (error) {
      if (error instanceof ErrorInventario) throw new ErrorCompra(409, error.codigo, error.message);
      throw error;
    }
    const ids = await bloquearVariantes(tx, ingreso.partidas.map((partida) => partida.varianteId));
    const variantes = await tx.talleProducto.findMany({ where: { id: { in: ids } },
      select: { id: true, stock: true } });
    const saldosPorVariante = new Map();
    for (const variante of variantes) {
      let saldos;
      try {
        saldos = await saldosPartidasBloqueadas(tx, variante.id, variante.stock);
      } catch (error) {
        if (error instanceof ErrorPartidas) throw new ErrorCompra(409, error.codigo, error.message);
        throw error;
      }
      saldosPorVariante.set(variante.id, new Map(saldos.map((saldo) => [saldo.partida.id, saldo])));
    }
    if (variantes.length !== ids.length) throw new ErrorCompra(409, "VARIANTE_INVALIDA", "Una variante dejó de existir");
    const asignaciones = await tx.asignacionPartida.count({ where: {
      partidaId: { in: ingreso.partidas.map((partida) => partida.id) },
      estado: { in: ["reservada", "vendida", "revertida"] },
    } });
    const devoluciones = await tx.devolucionProveedor.count({ where: { ingresoId } });
    if (asignaciones || devoluciones) {
      throw new ErrorCompra(409, "INGRESO_COMPROMETIDO", "El ingreso tiene unidades asignadas o devueltas");
    }
    for (const partida of ingreso.partidas) {
      const saldo = saldosPorVariante.get(partida.varianteId)?.get(partida.id);
      if (!saldo || saldo.fisico !== partida.cantidadOriginal || saldo.comprometido !== 0) {
        throw new ErrorCompra(409, "INGRESO_COMPROMETIDO", "El saldo de una partida impide anular el ingreso");
      }
    }
    const ahora = await horaBaseDatos(tx);
    for (const partida of ingreso.partidas) {
      await tx.movimientoInventario.create({ data: {
        varianteId: partida.varianteId, partidaId: partida.id, ingresoId,
        tipo: "anulacion_ingreso", cantidad: -partida.cantidadOriginal,
        motivo, actorUsuarioId, fecha: ahora,
      } });
      await tx.talleProducto.update({ where: { id: partida.varianteId },
        data: { stock: { decrement: partida.cantidadOriginal } } });
      await tx.correccionIngreso.create({ data: {
        ingresoId, partidaId: partida.id, campo: "estado",
        valorAnterior: "confirmado", valorNuevo: "anulado",
        diferenciaCosto: "0.00",
        motivo, claveOperacion: claveEventoAnulacion(ingresoId, claveOperacion, partida.id),
        actorUsuarioId, fecha: ahora,
      } });
    }
    await tx.ingreso.update({ where: { id: ingresoId }, data: { estado: "anulado" } });
    return { ...await obtenerIngreso(ingresoId, tx), reiterada: false };
  });
}
