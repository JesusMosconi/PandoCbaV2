import { randomUUID } from "node:crypto";
import prisma from "../../src/db.js";
import { crearEscenario } from "./escenario.js";
import { crearProveedor } from "../../src/services/proveedores.js";
import { confirmarIngreso, crearBorradorIngreso } from "../../src/services/compras.js";
import { abrirCaja } from "../../src/services/caja.js";
import { agregarItem, confirmarVentaLocal, resumenVentaLocal } from "../../src/services/venta-local.js";

/**
 * Escenario del punto de venta sobre la base de prueba. El último usuario es el
 * operador con rol admin (el admin también vende), así no compite con el índice
 * de vendedor único. La limpieza borra órdenes, cajas e inventario creados.
 */
export async function crearEscenarioLocal({ clientes = 1, stock = 4, precio = "100.00", fifo = false } = {}) {
  // Con el corte activo toda variante vende por FIFO: el stock entra por compra.
  const corte = await prisma.estadoCorteInventario.findUnique({ where: { id: 1 }, select: { id: true, estado: true } });
  const corteActivo = corte?.estado === "activo";
  const conPartidas = fifo || corteActivo;
  const escenario = await crearEscenario({ clientes: clientes + 1, stock: conPartidas ? 0 : stock, precio });
  const operador = escenario.usuarios.at(-1);
  await escenario.prisma.usuario.update({ where: { id: operador.id }, data: { rol: "admin" } });
  const proveedorIds = [];
  const productosExtra = [];
  const variantesCorte = [];

  async function proveedorId() {
    if (!proveedorIds.length) {
      const proveedor = await crearProveedor({ nombre: `Proveedor local ${randomUUID()}` }, operador.id);
      proveedorIds.push(proveedor.id);
    }
    return proveedorIds[0];
  }

  /** Deja la variante lista para FIFO y le carga stock con una compra confirmada. */
  async function cargarPorCompra(varianteId, unidades) {
    await prisma.talleProducto.update({ where: { id: varianteId }, data: { inicioInventarioCero: true } });
    if (corteActivo) {
      // Igual que una variante creada desde admin con el corte activo.
      await prisma.estadoCorteVariante.create({ data: {
        varianteId, corteId: corte.id, estado: "conciliado", origen: "nueva",
        saldoCapturado: 0, comprometido: 0, diferencia: 0, conciliadoEn: new Date(), conciliadoPorId: operador.id,
      } });
      variantesCorte.push(varianteId);
    }
    if (unidades <= 0) return;
    const ingreso = await crearBorradorIngreso({
      proveedorId: await proveedorId(), fechaCompra: "2026-10-15", fechaRecepcion: "2026-10-16",
      lineas: [{ varianteId, cantidad: unidades, costoUnitario: "40.00" }],
    });
    await confirmarIngreso(ingreso.id, {
      claveOperacion: randomUUID(), resumenAceptado: ingreso.huellaResumen,
    }, operador.id);
  }

  if (conPartidas) await cargarPorCompra(escenario.variante.id, stock);

  /** Producto adicional en la misma categoría, con su variante. */
  async function crearProducto({ web = true, local = true, coleccionId = null, stock: unidades = 3, precio: importe = precio } = {}) {
    const creado = await escenario.prisma.producto.create({ data: {
      nombre: `Producto local ${randomUUID().slice(0, 8)}`, precio: importe,
      categoriaId: escenario.categoria.id, web, local, coleccionId,
    } });
    const variante = await escenario.prisma.talleProducto.create({ data: {
      productoId: creado.id, talleId: escenario.talle.id, colorId: escenario.color.id,
      stock: corteActivo ? 0 : unidades, estado: "activo",
    } });
    productosExtra.push({ producto: creado, variante });
    if (corteActivo) await cargarPorCompra(variante.id, unidades);
    return { producto: creado, variante: await prisma.talleProducto.findUnique({ where: { id: variante.id } }) };
  }

  async function abrir(efectivoInicial = "0") {
    return (await abrirCaja(operador.id, { claveApertura: randomUUID(), efectivoInicial })).caja;
  }

  /** Arma y confirma una venta con el resumen vigente. */
  async function vender(lineas = [{ talleProductoId: escenario.variante.id, cantidad: 1 }],
    { nombreCliente, telefonoCliente, metodoPago = "efectivo", claveConfirmacion = randomUUID() } = {}) {
    for (const linea of lineas) await agregarItem(operador.id, linea);
    const resumen = await resumenVentaLocal(escenario.prisma, operador.id);
    return confirmarVentaLocal(operador.id, {
      claveConfirmacion, huellaResumen: resumen.huellaResumen, nombreCliente, telefonoCliente, metodoPago,
    });
  }

  async function limpiar() {
    const db = escenario.prisma;
    const usuarioIds = escenario.ids.usuarios;
    const variantes = [escenario.variante.id, ...productosExtra.map(({ variante }) => variante.id)];
    const ordenes = await db.orden.findMany({
      where: { OR: [{ usuarioId: { in: usuarioIds } }, { carritoId: { in: escenario.ids.carritos } }] },
      select: { id: true },
    });
    const ordenIds = ordenes.map(({ id }) => id);
    const devolucion = { devolucion: { ordenId: { in: ordenIds } } };
    await db.devolucionClienteAsignacion.deleteMany({ where: devolucion });
    await db.pagoReintegro.deleteMany({ where: devolucion });
    await db.recepcionDevolucion.deleteMany({ where: devolucion });
    await db.devolucionCliente.deleteMany({ where: { ordenId: { in: ordenIds } } });
    await db.asignacionPartida.deleteMany({ where: { detalleOrden: { ordenId: { in: ordenIds } } } });
    await db.movimientoInventario.deleteMany({ where: { varianteId: { in: variantes } } });
    await db.partidaInventario.deleteMany({ where: { varianteId: { in: variantes } } });
    await db.eventoOrden.deleteMany({ where: { ordenId: { in: ordenIds } } });
    await db.reservaStock.deleteMany({ where: { ordenId: { in: ordenIds } } });
    await db.detalleOrden.deleteMany({ where: { ordenId: { in: ordenIds } } });
    await db.datosEnvio.deleteMany({ where: { ordenId: { in: ordenIds } } });
    await db.orden.deleteMany({ where: { id: { in: ordenIds } } });
    await db.caja.deleteMany({ where: { abiertaPorId: { in: usuarioIds } } });
    await db.itemCarrito.deleteMany({ where: { carrito: { usuarioId: { in: usuarioIds } } } });
    await db.carrito.deleteMany({ where: { usuarioId: { in: usuarioIds } } });
    const ingresos = await db.ingreso.findMany({ where: { proveedorId: { in: proveedorIds } }, select: { id: true } });
    const ingresoIds = ingresos.map(({ id }) => id);
    await db.lineaIngreso.deleteMany({ where: { ingresoId: { in: ingresoIds } } });
    await db.gastoAdicionalCompra.deleteMany({ where: { ingresoId: { in: ingresoIds } } });
    await db.ingreso.deleteMany({ where: { id: { in: ingresoIds } } });
    await db.eventoProveedor.deleteMany({ where: { proveedorId: { in: proveedorIds } } });
    await db.proveedor.deleteMany({ where: { id: { in: proveedorIds } } });
    await db.estadoCorteVariante.deleteMany({ where: { varianteId: { in: variantesCorte } } });
    for (const { producto: extra, variante } of productosExtra) {
      await db.talleProducto.delete({ where: { id: variante.id } });
      await db.vigenciaPrecio.deleteMany({ where: { productoId: extra.id } });
      await db.producto.delete({ where: { id: extra.id } });
    }
    await escenario.limpiar();
  }

  return {
    ...escenario, clientes: escenario.usuarios.slice(0, clientes), operador,
    crearProducto, abrir, vender, limpiar,
  };
}

/**
 * La caja y el vendedor son únicos en toda la base. Si la base de prueba ya
 * tiene una caja abierta ajena, la prueba se omite en vez de tocarla.
 */
export async function hayCajaAbiertaAjena(prisma) {
  return Boolean(await prisma.caja.findFirst({ where: { estado: "abierta" }, select: { id: true } }));
}

export async function hayVendedorActivoAjeno(prisma) {
  return Boolean(await prisma.usuario.findFirst({ where: { rol: "vendedor", activo: true }, select: { id: true } }));
}
