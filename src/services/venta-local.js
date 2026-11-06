import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../db.js";
import {
  bloquearVariantes, disponibilidadVariantes, horaBaseDatos, presentarVariantesConDisponibilidad,
  transicionarReservas,
} from "./inventario.js";
import { ErrorPartidas, reconocerVentaFIFO } from "./partidas.js";
import { crearDetallesYReservas, leerCorteParaVenta, validarCorteParaVariantes } from "./reserva-fifo.js";
import { MEDIOS_PAGO_LOCAL, bloquearCajaAbierta, esDeJornadaAnterior } from "./caja.js";
import { esProductoLocal, whereProductoLocal } from "../utils/visibilidad-producto.js";

export class ErrorVentaLocal extends Error {
  constructor(status, codigo, message, detalles = {}) {
    super(message);
    this.name = "ErrorVentaLocal";
    this.status = status;
    this.codigo = codigo;
    Object.assign(this, detalles);
  }
}

const decimal = (valor) => new Prisma.Decimal(valor);
const dinero = (valor) => decimal(valor).toFixed(2);

const incluirCarritoLocal = {
  items: {
    orderBy: { id: "asc" },
    include: {
      talleProducto: {
        include: {
          producto: { include: { coleccion: true, imagenes: { orderBy: { orden: "asc" }, take: 1 } } },
          talle: true,
          color: true,
        },
      },
      productoImprovisado: true,
    },
  },
};

const incluirVenta = { detalles: { orderBy: { posicion: "asc" } } };

/** Serializa las escrituras de la venta en curso de un mismo operador. */
async function bloquearOperador(tx, usuarioId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7007, ${usuarioId}::int)`;
}

async function carritoLocalActivo(tx, usuarioId) {
  return tx.carrito.findFirst({
    where: { usuarioId, estado: "activo", canal: "local" },
    include: incluirCarritoLocal,
    orderBy: { id: "desc" },
  });
}

async function obtenerOCrearCarritoLocal(tx, usuarioId) {
  const carrito = await carritoLocalActivo(tx, usuarioId);
  if (carrito) return carrito;
  return tx.carrito.create({
    data: { usuarioId, estado: "activo", canal: "local" },
    include: incluirCarritoLocal,
  });
}

// ---------------------------------------------------------------------------
// Catálogo del punto de venta

export async function buscarProductosLocal({ buscar = "", categoriaId = null, pagina = 1, limite = 24 } = {}) {
  const texto = buscar.trim();
  const id = /^\d{1,9}$/.test(texto) ? Number(texto) : null;
  const filtros = [whereProductoLocal];
  if (categoriaId) filtros.push({ categoriaId });
  if (texto) {
    filtros.push({ OR: [
      { nombre: { contains: texto, mode: "insensitive" } },
      ...(id ? [{ id }] : []),
    ] });
  }
  const productos = await prisma.producto.findMany({
    where: { AND: filtros },
    orderBy: [{ nombre: "asc" }, { id: "asc" }],
    include: {
      categoria: true,
      imagenes: { orderBy: { orden: "asc" }, take: 1 },
      talles: { include: { talle: true, color: true }, orderBy: { id: "asc" } },
    },
  });
  const variantes = await presentarVariantesConDisponibilidad(prisma, productos.flatMap((producto) => producto.talles));
  const porId = new Map(variantes.map((variante) => [variante.id, variante]));
  // Los productos sin stock se muestran al final, marcados, para que el vendedor pueda informarlo.
  const presentados = productos.map((producto) => {
    const variantes = producto.talles.map((variante) => porId.get(variante.id))
      .filter((variante) => variante.estado !== "inactivo" && variante.stockDisponible > 0)
      .sort((a, b) => (a.talle.orden ?? 0) - (b.talle.orden ?? 0) || a.id - b.id)
      .map((variante) => ({
        id: variante.id,
        talle: variante.talle.valor,
        color: variante.color.nombre,
        hex: variante.color.hex,
        stockDisponible: variante.stockDisponible,
      }));
    return {
      id: producto.id,
      nombre: producto.nombre,
      precio: dinero(producto.precio),
      web: producto.web,
      imagen: producto.imagenes[0]?.url ?? null,
      categoria: producto.categoria?.nombre ?? null,
      sinStock: variantes.length === 0,
      variantes,
    };
  });
  const ordenados = [...presentados.filter((p) => !p.sinStock), ...presentados.filter((p) => p.sinStock)];
  const total = ordenados.length;
  return {
    productos: ordenados.slice((pagina - 1) * limite, pagina * limite),
    total,
    pagina,
    paginas: Math.max(1, Math.ceil(total / limite)),
  };
}

// ---------------------------------------------------------------------------
// Venta en curso

/** Calcula importes y bloqueos con el precio vigente; no modifica datos. */
export async function resumenVentaLocal(tx, usuarioId, carritoDado = null) {
  const carrito = carritoDado ?? await carritoLocalActivo(tx, usuarioId);
  const items = carrito?.items ?? [];
  const variantes = items.map((item) => item.talleProducto).filter(Boolean);
  const disponibles = await disponibilidadVariantes(tx, variantes);
  const cantidades = new Map();
  for (const item of items) {
    if (!item.talleProductoId) continue;
    cantidades.set(item.talleProductoId, (cantidades.get(item.talleProductoId) ?? 0) + item.cantidad);
  }

  let total = decimal(0);
  const lineas = items.map((item) => {
    const variante = item.talleProducto;
    const producto = variante?.producto;
    const ventaRapida = Boolean(item.concepto);
    const motivos = [];
    const cantidadValida = Number.isInteger(item.cantidad) && item.cantidad > 0;
    if (!cantidadValida) motivos.push("cantidad_invalida");
    if (item.productoImprovisadoId) motivos.push("producto_improvisado");
    if (!variante && !item.productoImprovisadoId && !ventaRapida) motivos.push("variante_inactiva");
    if (producto && !producto.activo) motivos.push("producto_retirado");
    if (producto && !producto.local) motivos.push("producto_no_local");
    if (producto && producto.activo && producto.local && !esProductoLocal(producto)) motivos.push("drop_no_lanzado");
    if (variante?.estado === "inactivo") motivos.push("variante_inactiva");
    const disponible = variante ? (disponibles.get(variante.id) ?? 0) : 0;
    if (variante && (cantidades.get(variante.id) ?? 0) > disponible) motivos.push("stock_insuficiente");
    // La venta rápida conserva el importe ingresado; el catálogo usa el precio vigente.
    const precioVigente = producto ? decimal(producto.precio) : ventaRapida ? decimal(item.precioUnitario) : null;
    const importe = precioVigente && cantidadValida ? precioVigente.mul(item.cantidad) : null;
    if (importe) total = total.add(importe);
    return {
      itemCarritoId: item.id,
      talleProductoId: item.talleProductoId,
      ventaRapida,
      nombreProducto: producto?.nombre ?? item.concepto ?? item.productoImprovisado?.nombre ?? "Producto no disponible",
      imagen: producto?.imagenes?.[0]?.url ?? null,
      talle: variante?.talle.valor ?? item.productoImprovisado?.talle ?? null,
      color: variante?.color.nombre ?? item.productoImprovisado?.color ?? null,
      cantidad: item.cantidad,
      stockDisponible: disponible,
      precioVigente: precioVigente ? precioVigente.toFixed(2) : null,
      importeLinea: importe ? importe.toFixed(2) : null,
      cambioPrecio: precioVigente ? !decimal(item.precioUnitario).equals(precioVigente) : false,
      disponible: motivos.length === 0,
      motivosBloqueo: motivos,
    };
  });

  const abierta = await tx.caja.findFirst({ where: { estado: "abierta" }, select: { id: true, estado: true, abiertaEn: true } });
  const caja = abierta
    ? { id: abierta.id, abiertaEn: abierta.abiertaEn, deJornadaAnterior: esDeJornadaAnterior(abierta) }
    : null;
  const huellaResumen = createHash("sha256").update(JSON.stringify({
    carritoId: carrito?.id ?? null,
    lineas: lineas.map((linea) => ({
      id: linea.itemCarritoId, cantidad: linea.cantidad,
      precioVigente: linea.precioVigente, motivos: linea.motivosBloqueo,
    })),
  })).digest("hex");

  return {
    carritoId: carrito?.id ?? null,
    lineas,
    total: total.toFixed(2),
    huellaResumen,
    caja,
    puedeConfirmar: Boolean(caja) && !caja.deJornadaAnterior && lineas.length > 0
      && lineas.every((linea) => linea.disponible),
  };
}

export async function obtenerVentaEnCurso(usuarioId) {
  return prisma.$transaction(async (tx) => {
    await bloquearOperador(tx, usuarioId);
    const carrito = await obtenerOCrearCarritoLocal(tx, usuarioId);
    return resumenVentaLocal(tx, usuarioId, carrito);
  });
}

async function cargarVarianteLocal(tx, talleProductoId) {
  return tx.talleProducto.findUnique({
    where: { id: talleProductoId },
    include: { producto: { include: { coleccion: true } } },
  });
}

export async function agregarItem(usuarioId, { talleProductoId, cantidad }) {
  return prisma.$transaction(async (tx) => {
    await bloquearOperador(tx, usuarioId);
    const carrito = await obtenerOCrearCarritoLocal(tx, usuarioId);
    await bloquearVariantes(tx, [talleProductoId]);
    const variante = await cargarVarianteLocal(tx, talleProductoId);
    if (!variante) throw new ErrorVentaLocal(404, "VARIANTE_INEXISTENTE", "La variante no existe");
    if (variante.estado === "inactivo") throw new ErrorVentaLocal(409, "variante_inactiva", "La variante está inactiva");
    if (!esProductoLocal(variante.producto)) {
      throw new ErrorVentaLocal(409, "producto_no_local", "El producto no se vende en el local");
    }
    const disponible = (await disponibilidadVariantes(tx, [variante])).get(variante.id) ?? 0;
    const actual = carrito.items.filter((item) => item.talleProductoId === variante.id)
      .reduce((suma, item) => suma + item.cantidad, 0);
    if (actual + cantidad > disponible) {
      throw new ErrorVentaLocal(409, "stock_insuficiente", `Solo hay ${disponible} unidades disponibles`,
        { disponible });
    }
    const existente = carrito.items.find((item) => item.talleProductoId === variante.id);
    if (existente) {
      await tx.itemCarrito.update({ where: { id: existente.id }, data: { cantidad: existente.cantidad + cantidad } });
    } else {
      await tx.itemCarrito.create({ data: {
        carritoId: carrito.id, talleProductoId: variante.id, cantidad, precioUnitario: variante.producto.precio,
      } });
    }
    await tx.carrito.update({ where: { id: carrito.id }, data: { actualizado: new Date() } });
    return resumenVentaLocal(tx, usuarioId);
  });
}

export const CONCEPTO_VENTA_RAPIDA = "Venta rápida";
const IMPORTE_DECIMAL = /^[1-9]\d{0,11}(\.\d{1,2})?$|^0\.(\d[1-9]|[1-9]\d?)$/;

/** Valida una línea de venta rápida: concepto opcional e importe unitario mayor que cero. */
export function normalizarVentaRapida({ concepto, importe, cantidad = 1 } = {}) {
  if (concepto !== undefined && concepto !== null && typeof concepto !== "string") {
    throw new ErrorVentaLocal(400, "VENTA_RAPIDA_INVALIDA", "El concepto debe ser texto", { campo: "concepto" });
  }
  const texto = (concepto ?? "").trim().replace(/\s+/g, " ");
  if (texto.length > 80) {
    throw new ErrorVentaLocal(400, "VENTA_RAPIDA_INVALIDA", "El concepto admite hasta 80 caracteres", { campo: "concepto" });
  }
  const valor = typeof importe === "number" && Number.isFinite(importe) ? String(importe)
    : typeof importe === "string" ? importe.trim().replace(",", ".") : "";
  if (!IMPORTE_DECIMAL.test(valor)) {
    throw new ErrorVentaLocal(400, "VENTA_RAPIDA_INVALIDA", "Ingresá un importe mayor que cero, con hasta dos decimales",
      { campo: "importe" });
  }
  if (!Number.isSafeInteger(cantidad) || cantidad <= 0) {
    throw new ErrorVentaLocal(400, "VENTA_RAPIDA_INVALIDA", "La cantidad debe ser un número entero positivo", { campo: "cantidad" });
  }
  return { concepto: texto || CONCEPTO_VENTA_RAPIDA, importe: decimal(valor), cantidad };
}

/** Agrega una línea sin producto ni stock, con el importe ingresado por el vendedor. */
export async function agregarVentaRapida(usuarioId, entrada) {
  const { concepto, importe, cantidad } = normalizarVentaRapida(entrada);
  return prisma.$transaction(async (tx) => {
    await bloquearOperador(tx, usuarioId);
    const carrito = await obtenerOCrearCarritoLocal(tx, usuarioId);
    await tx.itemCarrito.create({ data: { carritoId: carrito.id, concepto, precioUnitario: importe, cantidad } });
    await tx.carrito.update({ where: { id: carrito.id }, data: { actualizado: new Date() } });
    return resumenVentaLocal(tx, usuarioId);
  });
}

export async function actualizarItem(usuarioId, itemId, cantidad) {
  return prisma.$transaction(async (tx) => {
    await bloquearOperador(tx, usuarioId);
    const carrito = await obtenerOCrearCarritoLocal(tx, usuarioId);
    const item = carrito.items.find((linea) => linea.id === itemId);
    if (!item) throw new ErrorVentaLocal(404, "ITEM_INEXISTENTE", "La línea no está en la venta en curso");
    if (cantidad > item.cantidad && item.talleProductoId) {
      await bloquearVariantes(tx, [item.talleProductoId]);
      const variante = await cargarVarianteLocal(tx, item.talleProductoId);
      if (!variante || variante.estado === "inactivo" || !esProductoLocal(variante.producto)) {
        throw new ErrorVentaLocal(409, "producto_no_local", "El producto ya no se vende en el local");
      }
      const disponible = (await disponibilidadVariantes(tx, [variante])).get(variante.id) ?? 0;
      const otras = carrito.items.filter((linea) => linea.id !== item.id && linea.talleProductoId === variante.id)
        .reduce((suma, linea) => suma + linea.cantidad, 0);
      if (cantidad + otras > disponible) {
        throw new ErrorVentaLocal(409, "stock_insuficiente", `Solo hay ${disponible} unidades disponibles`,
          { disponible });
      }
    }
    await tx.itemCarrito.update({ where: { id: item.id }, data: { cantidad } });
    return resumenVentaLocal(tx, usuarioId);
  });
}

export async function quitarItem(usuarioId, itemId) {
  return prisma.$transaction(async (tx) => {
    await bloquearOperador(tx, usuarioId);
    const carrito = await obtenerOCrearCarritoLocal(tx, usuarioId);
    const item = carrito.items.find((linea) => linea.id === itemId);
    if (!item) throw new ErrorVentaLocal(404, "ITEM_INEXISTENTE", "La línea no está en la venta en curso");
    await tx.itemCarrito.delete({ where: { id: item.id } });
    return resumenVentaLocal(tx, usuarioId);
  });
}

export async function vaciarVenta(usuarioId) {
  return prisma.$transaction(async (tx) => {
    await bloquearOperador(tx, usuarioId);
    const carrito = await obtenerOCrearCarritoLocal(tx, usuarioId);
    await tx.itemCarrito.deleteMany({ where: { carritoId: carrito.id } });
    return resumenVentaLocal(tx, usuarioId);
  });
}

// ---------------------------------------------------------------------------
// Confirmación

/** Nombre y teléfono opcionales del cliente; vacíos quedan en null. */
export function normalizarCliente({ nombreCliente, telefonoCliente } = {}) {
  for (const [campo, valor] of [["nombreCliente", nombreCliente], ["telefonoCliente", telefonoCliente]]) {
    if (valor !== undefined && valor !== null && typeof valor !== "string") {
      throw new ErrorVentaLocal(400, "CLIENTE_INVALIDO", "Revisá los datos del cliente", { campo });
    }
  }
  const nombre = (nombreCliente ?? "").trim().replace(/\s+/g, " ");
  if (nombre.length > 100) {
    throw new ErrorVentaLocal(400, "CLIENTE_INVALIDO", "El nombre admite hasta 100 caracteres", { campo: "nombreCliente" });
  }
  const telefono = (telefonoCliente ?? "").replace(/[\s().-]/g, "");
  if (telefono && !/^\+?\d{6,20}$/.test(telefono)) {
    throw new ErrorVentaLocal(400, "CLIENTE_INVALIDO", "Ingresá un teléfono de 6 a 20 dígitos", { campo: "telefonoCliente" });
  }
  return { nombreCliente: nombre || null, telefonoCliente: telefono || null };
}

export function presentarVentaLocal(orden) {
  return {
    id: orden.id,
    numeroComprobante: orden.numeroComprobante,
    fecha: orden.pagoConfirmadoEn ?? orden.creadaEn,
    canal: orden.canal,
    nombreCliente: orden.nombreCliente,
    telefonoCliente: orden.telefonoCliente,
    metodoPago: orden.metodoPago,
    total: dinero(orden.subtotal),
    cajaId: orden.cajaId,
    estado: orden.estado,
    lineas: (orden.detalles ?? []).map((detalle) => ({
      nombreProducto: detalle.nombreProducto,
      // Las líneas de venta rápida no tienen variante: talle y color vacíos.
      ventaRapida: detalle.talleProductoId === null && detalle.productoId === null && !detalle.talle,
      talle: detalle.talle || null,
      color: detalle.color || null,
      cantidad: detalle.cantidad,
      precioUnitario: dinero(detalle.precioUnitario),
      importeLinea: dinero(detalle.importeLinea),
    })),
  };
}

function huellaConfirmacion(usuarioId, { huellaResumen, nombreCliente, telefonoCliente, metodoPago }) {
  return createHash("sha256").update(JSON.stringify({
    usuarioId, canal: "local", huellaResumen, nombreCliente, telefonoCliente, metodoPago,
  })).digest("hex");
}

async function buscarPorClave(tx, usuarioId, clave, huella) {
  const orden = await tx.orden.findUnique({
    where: { usuarioId_claveConfirmacion: { usuarioId, claveConfirmacion: clave } },
    include: incluirVenta,
  });
  if (!orden) return null;
  if (orden.canal !== "local" || orden.huellaSolicitud !== huella) {
    throw new ErrorVentaLocal(409, "INTENCION_EN_CONFLICTO", "Esta clave de confirmación ya se usó con otros datos");
  }
  return orden;
}

export async function confirmarVentaLocal(usuarioId, entrada) {
  const clave = typeof entrada?.claveConfirmacion === "string" ? entrada.claveConfirmacion.trim() : "";
  if (!clave || clave.length > 128
    || typeof entrada?.huellaResumen !== "string" || !/^[a-f0-9]{64}$/u.test(entrada.huellaResumen)) {
    throw new ErrorVentaLocal(400, "CONFIRMACION_INVALIDA", "Revisá la clave y el resumen de la venta");
  }
  const cliente = normalizarCliente(entrada);
  const metodoPago = entrada.metodoPago;
  if (!MEDIOS_PAGO_LOCAL.includes(metodoPago)) {
    throw new ErrorVentaLocal(400, "MEDIO_PAGO_INVALIDO", "Elegí un medio de pago", { campo: "metodoPago" });
  }
  const huella = huellaConfirmacion(usuarioId, { huellaResumen: entrada.huellaResumen, ...cliente, metodoPago });

  const anterior = await buscarPorClave(prisma, usuarioId, clave, huella);
  if (anterior) return { venta: presentarVentaLocal(anterior), creada: false };

  for (let intento = 0; intento < 3; intento += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const yaCreada = await buscarPorClave(tx, usuarioId, clave, huella);
        if (yaCreada) return { venta: presentarVentaLocal(yaCreada), creada: false };
        await bloquearOperador(tx, usuarioId);

        const carrito = await carritoLocalActivo(tx, usuarioId);
        if (!carrito || carrito.items.length === 0) {
          const ganadora = await buscarPorClave(tx, usuarioId, clave, huella);
          if (ganadora) return { venta: presentarVentaLocal(ganadora), creada: false };
          // Sin carrito activo y sin caja: el cierre de caja descartó la venta en curso.
          if (!carrito && !await tx.caja.findFirst({ where: { estado: "abierta" }, select: { id: true } })) {
            throw new ErrorVentaLocal(409, "CAJA_NO_ABIERTA", "La caja se cerró y la venta en curso se descartó");
          }
          throw new ErrorVentaLocal(400, "VENTA_VACIA", "La venta no tiene productos");
        }
        await tx.$queryRaw`SELECT "id" FROM "Carrito" WHERE "id" = ${carrito.id} FOR UPDATE`;

        // La caja se bloquea antes del inventario: venta y cierre quedan serializados.
        const caja = await bloquearCajaAbierta(tx);
        if (!caja) throw new ErrorVentaLocal(409, "CAJA_NO_ABIERTA", "Abrí la caja antes de vender");
        if (esDeJornadaAnterior(caja, await horaBaseDatos(tx))) {
          throw new ErrorVentaLocal(409, "CAJA_JORNADA_ANTERIOR",
            "La caja quedó abierta de un día anterior: cerrala y abrí una nueva para vender");
        }
        // Una venta solo de líneas rápidas no toca el inventario: no depende del corte.
        const conCatalogo = carrito.items.some((item) => !item.concepto);
        const corte = conCatalogo ? await leerCorteParaVenta(tx) : null;
        await bloquearVariantes(tx, carrito.items.map((item) => item.talleProductoId).filter(Boolean));

        const carritoActual = await carritoLocalActivo(tx, usuarioId);
        if (!carritoActual || carritoActual.id !== carrito.id) {
          throw new ErrorVentaLocal(409, "INTENCION_EN_CONFLICTO", "La venta cambió durante la confirmación");
        }
        const resumen = await resumenVentaLocal(tx, usuarioId, carritoActual);
        const afectados = resumen.lineas.flatMap((linea) => linea.motivosBloqueo
          .map((motivo) => ({ itemCarritoId: linea.itemCarritoId, motivo })));
        if (afectados.length) {
          throw new ErrorVentaLocal(409, "ITEMS_NO_DISPONIBLES", "Corregí los productos indicados antes de confirmar",
            { itemsAfectados: afectados, resumen });
        }
        if (resumen.huellaResumen !== entrada.huellaResumen) {
          throw new ErrorVentaLocal(409, "RESUMEN_CAMBIO", "El precio o la venta cambiaron; revisá el total y confirmá de nuevo",
            { resumen });
        }

        const itemsCatalogo = carritoActual.items.filter((item) => !item.concepto);
        const itemsRapidos = carritoActual.items.filter((item) => item.concepto);
        const { variantesPorId, variantesFIFO } = itemsCatalogo.length
          ? await validarCorteParaVariantes(tx, corte, itemsCatalogo)
          : { variantesPorId: new Map(), variantesFIFO: new Set() };
        const ahora = await horaBaseDatos(tx);
        const [{ siguiente }] = await tx.$queryRaw`
          SELECT (COALESCE(MAX("numeroComprobante"), 0) + 1)::int AS siguiente FROM "Orden"`;
        const total = decimal(resumen.total);
        const orden = await tx.orden.create({ data: {
          usuarioId,
          carritoId: carrito.id,
          canal: "local",
          estado: "pendiente_pago",
          tipoEntrega: "local",
          subtotal: total,
          costoEnvio: null,
          total,
          metodoPago,
          creadaEn: ahora,
          venceEn: ahora,
          claveConfirmacion: clave,
          huellaSolicitud: huella,
          ...cliente,
          cajaId: caja.id,
          numeroComprobante: Number(siguiente),
        } });
        let sumaLineas = await crearDetallesYReservas(tx, {
          ordenId: orden.id, items: itemsCatalogo, variantesPorId, variantesFIFO, ahora,
        });
        // Las líneas rápidas van después del catálogo, sin reserva ni asignación FIFO.
        for (const [indice, item] of itemsRapidos.entries()) {
          const importeLinea = decimal(item.precioUnitario).mul(item.cantidad);
          await tx.detalleOrden.create({ data: {
            ordenId: orden.id, posicion: itemsCatalogo.length + indice + 1,
            nombreProducto: item.concepto, talle: "", color: "", cantidad: item.cantidad,
            precioUnitario: item.precioUnitario, importeLinea,
          } });
          sumaLineas = sumaLineas.add(importeLinea);
        }
        if (!sumaLineas.equals(total)) throw new Error("El total no coincide con sus líneas");

        // Misma secuencia que la web (pendiente → pagada → entregada), en un solo instante.
        await tx.eventoOrden.create({ data: {
          ordenId: orden.id, fecha: ahora, origen: "local", actorUsuarioId: usuarioId, estadoNuevo: "pendiente_pago",
        } });
        await tx.orden.update({ where: { id: orden.id }, data: {
          estado: "pago_confirmado", pagoConfirmadoEn: ahora, pagoConfirmadoPorId: usuarioId,
        } });
        await reconocerVentaFIFO(tx, orden.id, ahora);
        await tx.eventoOrden.create({ data: {
          ordenId: orden.id, fecha: ahora, origen: "local", actorUsuarioId: usuarioId,
          estadoAnterior: "pendiente_pago", estadoNuevo: "pago_confirmado",
        } });
        await transicionarReservas(tx, orden.id, "consumida", ahora, usuarioId);
        await tx.orden.update({ where: { id: orden.id }, data: { estado: "entregada" } });
        await tx.eventoOrden.create({ data: {
          ordenId: orden.id, fecha: ahora, origen: "local", actorUsuarioId: usuarioId,
          estadoAnterior: "pago_confirmado", estadoNuevo: "entregada",
        } });
        await tx.carrito.update({ where: { id: carrito.id }, data: { estado: "convertido" } });
        const venta = await tx.orden.findUnique({ where: { id: orden.id }, include: incluirVenta });
        return { venta: presentarVentaLocal(venta), creada: true };
      }, { timeout: 15_000 });
    } catch (error) {
      if (error instanceof ErrorPartidas) throw new ErrorVentaLocal(409, error.codigo, error.message);
      if (error.code === "P2002" || error.code === "P2034") {
        const ganadora = await buscarPorClave(prisma, usuarioId, clave, huella);
        if (ganadora) return { venta: presentarVentaLocal(ganadora), creada: false };
        if (intento < 2) continue;
        throw new ErrorVentaLocal(503, "CONFIRMACION_REINTENTABLE", "No pudimos confirmar ahora; reintentá");
      }
      throw error;
    }
  }
  throw new ErrorVentaLocal(503, "CONFIRMACION_REINTENTABLE", "No pudimos confirmar ahora; reintentá");
}

// ---------------------------------------------------------------------------
// Historial y comprobante

/** Convierte un día de Buenos Aires (YYYY-MM-DD) en el instante de su inicio. */
function inicioDiaBuenosAires(dia) {
  return new Date(`${dia}T00:00:00-03:00`);
}

export async function listarVentasLocal({ desde, hasta, buscar = "", pagina = 1, limite = 20 } = {}) {
  const texto = buscar.trim();
  const digitos = texto.replace(/[\s().+-]/g, "");
  const filtrosBusqueda = [];
  if (/^\d{1,9}$/.test(digitos)) filtrosBusqueda.push({ numeroComprobante: Number(digitos) });
  if (/^\d{3,20}$/.test(digitos)) filtrosBusqueda.push({ telefonoCliente: { contains: digitos } });
  if (texto && !/^\d+$/.test(digitos)) filtrosBusqueda.push({ nombreCliente: { contains: texto, mode: "insensitive" } });
  const where = {
    canal: "local",
    ...(desde || hasta ? { pagoConfirmadoEn: {
      ...(desde ? { gte: inicioDiaBuenosAires(desde) } : {}),
      ...(hasta ? { lt: new Date(inicioDiaBuenosAires(hasta).getTime() + 24 * 60 * 60 * 1000) } : {}),
    } } : {}),
    ...(filtrosBusqueda.length ? { OR: filtrosBusqueda } : {}),
  };
  const [total, ordenes] = await Promise.all([
    prisma.orden.count({ where }),
    prisma.orden.findMany({
      where, include: incluirVenta,
      orderBy: [{ numeroComprobante: "desc" }],
      skip: (pagina - 1) * limite, take: limite,
    }),
  ]);
  return { ventas: ordenes.map(presentarVentaLocal), total, pagina, paginas: Math.max(1, Math.ceil(total / limite)) };
}

export async function obtenerVentaLocal(id) {
  const orden = await prisma.orden.findFirst({ where: { id, canal: "local" }, include: incluirVenta });
  return orden ? presentarVentaLocal(orden) : null;
}
