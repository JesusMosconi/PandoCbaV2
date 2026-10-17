import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { bloquearVariantes, disponibilidadVariantes, horaBaseDatos } from "./inventario.js";

const incluirCarrito = {
  items: {
    orderBy: { id: "asc" },
    include: {
      talleProducto: { include: { producto: true, talle: true, color: true } },
      productoImprovisado: true,
    },
  },
};

const decimal = (valor) => new Prisma.Decimal(valor);
const dinero = (valor) => valor.toString();

export async function obtenerCarritoCheckout(tx, usuarioId) {
  return tx.carrito.findFirst({
    where: { usuarioId, estado: "activo" },
    include: incluirCarrito,
    orderBy: { id: "desc" },
  });
}

export function huellaSolicitud(usuarioId, entrada) {
  const entrega = normalizarEntrega(entrada);
  return createHash("sha256").update(JSON.stringify({
    usuarioId,
    tipoEntrega: entrega.tipoEntrega,
    datosEnvio: entrega.datosEnvio,
    huellaResumen: entrada.huellaResumen,
    aceptaPrecioVigente: entrada.aceptaPrecioVigente,
  })).digest("hex");
}

export class ErrorConfirmacionCheckout extends Error {
  constructor(status, codigo, message, detalles = {}) {
    super(message);
    this.name = "ErrorConfirmacionCheckout";
    this.status = status;
    this.codigo = codigo;
    Object.assign(this, detalles);
  }
}

const ordenConDetalle = {
  detalles: { orderBy: { posicion: "asc" } },
  datosEnvio: true,
};

async function buscarPorClave(tx, usuarioId, claveConfirmacion) {
  return tx.orden.findUnique({
    where: { usuarioId_claveConfirmacion: { usuarioId, claveConfirmacion } },
    include: ordenConDetalle,
  });
}

function comprobarReintento(orden, huella) {
  if (!orden) return null;
  if (orden.huellaSolicitud !== huella) {
    throw new ErrorConfirmacionCheckout(409, "INTENCION_EN_CONFLICTO",
      "Esta clave de confirmación ya se usó con otros datos");
  }
  return orden;
}

export async function confirmarCheckout(usuarioId, entrada) {
  if (typeof entrada?.claveConfirmacion !== "string" || !entrada.claveConfirmacion.trim()
    || entrada.claveConfirmacion.length > 128
    || typeof entrada.huellaResumen !== "string" || !/^[a-f0-9]{64}$/u.test(entrada.huellaResumen)) {
    throw new ErrorConfirmacionCheckout(400, "CONFIRMACION_INVALIDA",
      "Revisá la clave y el resumen de confirmación");
  }
  const clave = entrada.claveConfirmacion;
  const huella = huellaSolicitud(usuarioId, entrada);
  const anterior = await buscarPorClave(prisma, usuarioId, clave);
  if (anterior) return { orden: comprobarReintento(anterior, huella), creada: false };
  if (entrada.aceptaPrecioVigente !== true) {
    throw new ErrorConfirmacionCheckout(400, "PRECIO_NO_ACEPTADO",
      "Aceptá expresamente el precio vigente antes de confirmar");
  }

  for (let intento = 0; intento < 3; intento += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const yaCreada = await buscarPorClave(tx, usuarioId, clave);
        if (yaCreada) return { orden: comprobarReintento(yaCreada, huella), creada: false };

        const carrito = await obtenerCarritoCheckout(tx, usuarioId);
        if (!carrito || carrito.items.length === 0) {
          const ganadora = await buscarPorClave(tx, usuarioId, clave);
          if (ganadora) return { orden: comprobarReintento(ganadora, huella), creada: false };
          if (!carrito && await tx.orden.findFirst({ where: { usuarioId, creadaEn: { not: null } }, select: { id: true } })) {
            throw new ErrorConfirmacionCheckout(409, "INTENCION_EN_CONFLICTO",
              "El carrito ya se convirtió; iniciá una nueva compra");
          }
          throw new ErrorConfirmacionCheckout(400, "CARRITO_VACIO", "Tu carrito está vacío");
        }
        await tx.$queryRaw`SELECT "id" FROM "Carrito" WHERE "id" = ${carrito.id} FOR UPDATE`;
        const estadoCarrito = await tx.carrito.findUnique({ where: { id: carrito.id } });
        if (estadoCarrito.estado !== "activo") {
          const ganadora = await buscarPorClave(tx, usuarioId, clave);
          if (ganadora) return { orden: comprobarReintento(ganadora, huella), creada: false };
          throw new ErrorConfirmacionCheckout(409, "INTENCION_EN_CONFLICTO",
            "Este carrito ya se convirtió en otra orden");
        }

        await bloquearVariantes(tx, carrito.items.map((item) => item.talleProductoId).filter(Boolean));
        const carritoActual = await obtenerCarritoCheckout(tx, usuarioId);
        if (!carritoActual || carritoActual.id !== carrito.id) {
          throw new ErrorConfirmacionCheckout(409, "INTENCION_EN_CONFLICTO",
            "El carrito cambió durante la confirmación");
        }
        const resumen = await resumenCheckout(usuarioId, entrada, tx, carritoActual);
        const afectados = resumen.lineas.flatMap((linea) => linea.motivosBloqueo
          .map((motivo) => ({ itemCarritoId: linea.itemCarritoId, motivo })));
        if (afectados.length) {
          throw new ErrorConfirmacionCheckout(409, "ITEMS_NO_DISPONIBLES",
            "Corregí los ítems indicados antes de confirmar", { itemsAfectados: afectados, resumen });
        }
        if (resumen.huellaResumen !== entrada.huellaResumen) {
          throw new ErrorConfirmacionCheckout(409, "RESUMEN_CAMBIO",
            "El precio o el carrito cambiaron; revisá y aceptá el resumen vigente", { resumen });
        }

        const creadaEn = await horaBaseDatos(tx);
        const venceEn = new Date(creadaEn.getTime() + 24 * 60 * 60 * 1000);
        const subtotal = decimal(resumen.subtotalProductos);
        const entrega = resumen.entrega;
        const orden = await tx.orden.create({
          data: {
            usuarioId,
            carritoId: carrito.id,
            estado: "pendiente_pago",
            tipoEntrega: entrega.tipoEntrega,
            subtotal,
            costoEnvio: null,
            total: entrega.tipoEntrega === "retiro" ? subtotal : null,
            metodoPago: "manual",
            creadaEn,
            venceEn,
            claveConfirmacion: clave,
            huellaSolicitud: huella,
            ...(entrega.datosEnvio ? { datosEnvio: { create: entrega.datosEnvio } } : {}),
          },
        });
        let sumaLineas = decimal(0);
        for (const [indice, item] of carritoActual.items.entries()) {
          const variante = item.talleProducto;
          const precio = decimal(variante.producto.precio);
          const importe = precio.mul(item.cantidad);
          sumaLineas = sumaLineas.add(importe);
          await tx.detalleOrden.create({
            data: {
              ordenId: orden.id,
              posicion: indice + 1,
              productoId: variante.productoId,
              talleProductoId: variante.id,
              nombreProducto: variante.producto.nombre,
              talle: variante.talle.valor,
              color: variante.color.nombre,
              cantidad: item.cantidad,
              precioUnitario: precio,
              importeLinea: importe,
            },
          });
        }
        if (!sumaLineas.equals(subtotal)) throw new Error("El subtotal no coincide con sus líneas");
        const cantidades = new Map();
        for (const item of carritoActual.items) {
          cantidades.set(item.talleProductoId,
            (cantidades.get(item.talleProductoId) ?? 0) + item.cantidad);
        }
        for (const [talleProductoId, cantidad] of [...cantidades.entries()].sort((a, b) => a[0] - b[0])) {
          await tx.reservaStock.create({
            data: { ordenId: orden.id, talleProductoId, cantidad, estado: "activa", reservadaEn: creadaEn },
          });
        }
        await tx.eventoOrden.create({
          data: { ordenId: orden.id, fecha: creadaEn, origen: "cliente", actorUsuarioId: usuarioId,
            estadoNuevo: "pendiente_pago" },
        });
        await tx.carrito.update({ where: { id: carrito.id }, data: { estado: "convertido" } });
        return { orden: await tx.orden.findUnique({ where: { id: orden.id }, include: ordenConDetalle }), creada: true };
      });
    } catch (error) {
      if (error.code === "P2002" || error.code === "P2034") {
        const ganadora = await buscarPorClave(prisma, usuarioId, clave);
        if (ganadora) return { orden: comprobarReintento(ganadora, huella), creada: false };
        if (intento < 2) continue;
        throw new ErrorConfirmacionCheckout(503, "CONFIRMACION_REINTENTABLE",
          "No pudimos confirmar ahora; reintentá con la misma clave");
      }
      throw error;
    }
  }
  throw new ErrorConfirmacionCheckout(503, "CONFIRMACION_REINTENTABLE",
    "No pudimos confirmar ahora; reintentá con la misma clave");
}

export async function resumenCheckout(usuarioId, entrada, tx = prisma, carritoDado = null) {
  const entrega = normalizarEntrega(entrada);
  const carrito = carritoDado ?? await obtenerCarritoCheckout(tx, usuarioId);
  const items = carrito?.items ?? [];
  const variantes = items.map((item) => item.talleProducto).filter(Boolean);
  const disponibles = await disponibilidadVariantes(tx, variantes);
  const cantidades = new Map();
  for (const item of items) {
    if (!item.talleProductoId) continue;
    cantidades.set(item.talleProductoId,
      (cantidades.get(item.talleProductoId) ?? 0) + item.cantidad);
  }

  let subtotalCarrito = decimal(0);
  let subtotalProductos = decimal(0);
  const lineas = items.map((item) => {
    const variante = item.talleProducto;
    const producto = variante?.producto;
    const motivos = [];
    if (!Number.isInteger(item.cantidad) || item.cantidad <= 0) motivos.push("cantidad_invalida");
    if (item.productoImprovisadoId) motivos.push("producto_improvisado");
    if (!variante && !item.productoImprovisadoId) motivos.push("variante_inactiva");
    if (producto && !producto.activo) motivos.push("producto_retirado");
    if (producto && !producto.web) motivos.push("producto_no_publicado");
    if (variante?.estado === "inactivo") motivos.push("variante_inactiva");
    if (variante && (cantidades.get(variante.id) ?? 0) > (disponibles.get(variante.id) ?? 0)) {
      motivos.push("stock_insuficiente");
    }
    const precioVigente = producto?.precio ?? null;
    const cantidadValida = Number.isInteger(item.cantidad) && item.cantidad > 0;
    if (cantidadValida) {
      subtotalCarrito = subtotalCarrito.add(decimal(item.precioUnitario).mul(item.cantidad));
      if (precioVigente) subtotalProductos = subtotalProductos.add(decimal(precioVigente).mul(item.cantidad));
    }
    return {
      itemCarritoId: item.id,
      nombreProducto: producto?.nombre ?? item.productoImprovisado?.nombre ?? "Producto no disponible",
      talle: variante?.talle.valor ?? item.productoImprovisado?.talle ?? null,
      color: variante?.color.nombre ?? item.productoImprovisado?.color ?? null,
      cantidad: item.cantidad,
      precioCarrito: dinero(decimal(item.precioUnitario)),
      precioVigente: precioVigente ? dinero(decimal(precioVigente)) : null,
      importeLinea: precioVigente && cantidadValida ? dinero(decimal(precioVigente).mul(item.cantidad)) : null,
      cambioPrecio: precioVigente ? !decimal(item.precioUnitario).equals(precioVigente) : false,
      disponible: motivos.length === 0,
      motivoBloqueo: motivos[0] ?? null,
      motivosBloqueo: motivos,
    };
  });

  const huellaResumen = createHash("sha256").update(JSON.stringify({
    usuarioId,
    carritoId: carrito?.id ?? null,
    entrega,
    lineas: lineas.map((linea) => ({
      id: linea.itemCarritoId,
      cantidad: linea.cantidad,
      precioCarrito: linea.precioCarrito,
      precioVigente: linea.precioVigente,
      motivos: linea.motivosBloqueo,
    })),
  })).digest("hex");

  return {
    carritoId: carrito?.id ?? null,
    lineas,
    subtotalCarrito: dinero(subtotalCarrito),
    subtotalProductos: dinero(subtotalProductos),
    estadoCostoEnvio: entrega.tipoEntrega === "retiro" ? "no_aplica" : "sin_cotizar",
    costoEnvio: null,
    totalFinal: entrega.tipoEntrega === "retiro" ? dinero(subtotalProductos) : null,
    huellaResumen,
    puedeConfirmar: lineas.length > 0 && lineas.every((linea) => linea.disponible),
    entrega,
  };
}

export class ErrorDatosCheckout extends Error {
  constructor(camposInvalidos) {
    super("Revisá los datos de entrega indicados");
    this.name = "ErrorDatosCheckout";
    this.status = 400;
    this.codigo = "DATOS_ENVIO_INVALIDOS";
    this.camposInvalidos = camposInvalidos;
  }
}

const limpiarEspacios = (valor) => valor.trim().replace(/\s+/gu, " ");
const contieneControl = (valor) => /[\p{Cc}\p{Cf}]/u.test(valor);

export function normalizarEntrega(entrada) {
  const errores = [];
  if (!entrada || typeof entrada !== "object" || Array.isArray(entrada)
    || !["retiro", "envio"].includes(entrada.tipoEntrega)) {
    errores.push({ campo: "tipoEntrega", mensaje: "Elegí retiro o envío" });
    throw new ErrorDatosCheckout(errores);
  }
  if (entrada.tipoEntrega === "retiro") {
    return { tipoEntrega: "retiro", datosEnvio: null };
  }

  const datos = entrada.datosEnvio;
  const origen = datos && typeof datos === "object" && !Array.isArray(datos) ? datos : {};
  const texto = (campo, minimo, maximo) => {
    if (typeof origen[campo] !== "string") {
      errores.push({ campo, mensaje: "Este campo es obligatorio" });
      return "";
    }
    const valor = limpiarEspacios(origen[campo]);
    if (contieneControl(origen[campo]) || [...valor].length < minimo || [...valor].length > maximo) {
      errores.push({ campo, mensaje: `Debe tener entre ${minimo} y ${maximo} caracteres visibles y no contener controles` });
    }
    return valor;
  };

  const direccion = texto("direccion", 5, 160);
  const ciudad = texto("ciudad", 2, 80);
  let codPostal = "";
  if (typeof origen.codPostal !== "string") {
    errores.push({ campo: "codPostal", mensaje: "Este campo es obligatorio" });
  } else {
    codPostal = origen.codPostal.replace(/\s+/gu, "").toUpperCase();
    if (!/^(?=.{4,10}$)(?=.*[0-9])[A-Z0-9]+$/u.test(codPostal)) {
      errores.push({ campo: "codPostal", mensaje: "Usá entre 4 y 10 letras o números, con al menos un número" });
    }
  }

  let telefono = "";
  if (typeof origen.telefono !== "string") {
    errores.push({ campo: "telefono", mensaje: "Este campo es obligatorio" });
  } else {
    const recibido = origen.telefono.trim();
    if (!/^\+?[0-9\s()\-]+$/u.test(recibido)) {
      errores.push({ campo: "telefono", mensaje: "Usá solo números, espacios, guiones, paréntesis y + inicial" });
    }
    const digitos = recibido.replace(/\D/gu, "");
    if (digitos.length < 8 || digitos.length > 15) {
      errores.push({ campo: "telefono", mensaje: "Debe tener entre 8 y 15 dígitos" });
    }
    telefono = `${recibido.startsWith("+") ? "+" : ""}${digitos}`;
  }

  let email = "";
  if (typeof origen.email !== "string") {
    errores.push({ campo: "email", mensaje: "Este campo es obligatorio" });
  } else {
    email = origen.email.trim().toLowerCase();
    const partes = email.split("@");
    if (email.length > 254 || /\s/u.test(email) || partes.length !== 2
      || !partes[0] || !partes[1] || !partes[1].includes(".")
      || partes[1].startsWith(".") || partes[1].endsWith(".")) {
      errores.push({ campo: "email", mensaje: "Ingresá un correo electrónico válido" });
    }
  }

  if (errores.length) throw new ErrorDatosCheckout(errores);
  return { tipoEntrega: "envio", datosEnvio: { direccion, ciudad, codPostal, telefono, email } };
}
