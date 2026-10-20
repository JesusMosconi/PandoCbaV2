import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import { crearEscenario } from "./soporte/escenario.js";
import productosRoutes from "../src/routes/productos.routes.js";
import { cambiarEstadoProveedor, crearProveedor } from "../src/services/proveedores.js";
import {
  confirmarIngreso, crearBorradorIngreso, editarBorradorIngreso, resumenIngreso,
} from "../src/services/compras.js";

const fechas = { fechaCompra: "2026-10-16", fechaRecepcion: "2026-10-17" };

async function conEscenario(prueba, { varianteNueva = true } = {}) {
  const escenario = await crearEscenario({ stock: 0 });
  const proveedorIds = [];
  const varianteIds = [escenario.variante.id];
  const talleIds = [];
  if (varianteNueva) {
    await escenario.prisma.talleProducto.update({
      where: { id: escenario.variante.id }, data: { inicioInventarioCero: true },
    });
  }
  const contexto = {
    ...escenario,
    actorId: escenario.usuarios[0].id,
    async proveedor() {
      const proveedor = await crearProveedor({ nombre: `Proveedor ${randomUUID()}` }, this.actorId);
      proveedorIds.push(proveedor.id);
      return proveedor;
    },
    async otraVariante() {
      const talle = await escenario.prisma.talle.create({ data: { valor: `T-${randomUUID().slice(0, 12)}` } });
      talleIds.push(talle.id);
      const variante = await escenario.prisma.talleProducto.create({ data: {
        productoId: escenario.producto.id, talleId: talle.id, colorId: escenario.color.id,
        stock: 0, estado: "activo", inicioInventarioCero: true,
      } });
      varianteIds.push(variante.id);
      return variante;
    },
  };
  try {
    await prueba(contexto);
  } finally {
    const ingresos = await escenario.prisma.ingreso.findMany({
      where: { proveedorId: { in: proveedorIds } }, select: { id: true },
    });
    const ingresoIds = ingresos.map(({ id }) => id);
    await escenario.prisma.movimientoInventario.deleteMany({ where: { varianteId: { in: varianteIds } } });
    await escenario.prisma.partidaInventario.deleteMany({ where: { varianteId: { in: varianteIds } } });
    await escenario.prisma.gastoAdicionalCompra.deleteMany({ where: { ingresoId: { in: ingresoIds } } });
    await escenario.prisma.lineaIngreso.deleteMany({ where: { ingresoId: { in: ingresoIds } } });
    await escenario.prisma.ingreso.deleteMany({ where: { id: { in: ingresoIds } } });
    await escenario.prisma.eventoProveedor.deleteMany({ where: { proveedorId: { in: proveedorIds } } });
    await escenario.prisma.proveedor.deleteMany({ where: { id: { in: proveedorIds } } });
    for (const id of varianteIds.slice(1)) await escenario.prisma.talleProducto.delete({ where: { id } });
    for (const id of talleIds) await escenario.prisma.talle.delete({ where: { id } });
    await escenario.limpiar();
  }
}

function entrada(proveedorId, varianteId, cambios = {}) {
  return {
    proveedorId, ...fechas,
    lineas: [{ varianteId, cantidad: 2, costoUnitario: "100.00" }],
    gastosAdicionales: [{ concepto: "Flete", importe: "12.50" }],
    ...cambios,
  };
}

test("un proveedor inactivo bloquea el borrador y puede reactivarse sin perder historia", async () => {
  await conEscenario(async (escenario) => {
    const proveedor = await escenario.proveedor();
    assert.equal((await cambiarEstadoProveedor(proveedor.id, false, "Pausa", escenario.actorId)).status, 200);
    await assert.rejects(crearBorradorIngreso(entrada(proveedor.id, escenario.variante.id)),
      (error) => error.codigo === "PROVEEDOR_INACTIVO");
    assert.equal((await cambiarEstadoProveedor(proveedor.id, true, "Reanudar", escenario.actorId)).status, 200);
    const ingreso = await crearBorradorIngreso(entrada(proveedor.id, escenario.variante.id));
    assert.equal(ingreso.estado, "borrador");
    assert.equal(await escenario.prisma.eventoProveedor.count({ where: { proveedorId: proveedor.id } }), 3);
  });
});

test("valida fechas, cantidades, costos y variantes repetidas antes de escribir", async () => {
  await conEscenario(async (escenario) => {
    const proveedor = await escenario.proveedor();
    const base = entrada(proveedor.id, escenario.variante.id);
    for (const cambios of [
      { fechaRecepcion: "2026-10-15" },
      { lineas: [{ ...base.lineas[0], cantidad: 0 }] },
      { lineas: [{ ...base.lineas[0], costoUnitario: "-1.00" }] },
      { lineas: [base.lineas[0], base.lineas[0]] },
      { gastosAdicionales: [{ concepto: "Flete", importe: "-0.01" }] },
    ]) {
      await assert.rejects(crearBorradorIngreso({ ...base, ...cambios }),
        (error) => error.codigo === "ENTRADA_INVALIDA");
    }
    assert.equal(await escenario.prisma.ingreso.count({ where: { proveedorId: proveedor.id } }), 0);
  });
});

test("dos variantes y un gasto se confirman una vez aun con reintentos simultáneos", async () => {
  await conEscenario(async (escenario) => {
    const proveedor = await escenario.proveedor();
    const segunda = await escenario.otraVariante();
    const ingreso = await crearBorradorIngreso(entrada(proveedor.id, escenario.variante.id, {
      lineas: [
        { varianteId: escenario.variante.id, cantidad: 2, costoUnitario: "100.00" },
        { varianteId: segunda.id, cantidad: 3, costoUnitario: "150.00" },
      ],
    }));
    assert.equal(ingreso.importeMercaderia, "650.00");
    assert.equal(ingreso.gastosAdicionales, "12.50");
    assert.equal(ingreso.totalDesembolso, "662.50");
    const resumen = await resumenIngreso(ingreso.id);
    const solicitud = { claveOperacion: randomUUID(), resumenAceptado: resumen.huellaResumen };
    const resultados = await Promise.all([
      confirmarIngreso(ingreso.id, solicitud, escenario.actorId),
      confirmarIngreso(ingreso.id, solicitud, escenario.actorId),
    ]);
    assert.equal(resultados.filter(({ reiterada }) => !reiterada).length, 1);
    assert.equal(resultados.filter(({ reiterada }) => reiterada).length, 1);
    assert.deepEqual((await escenario.prisma.talleProducto.findMany({
      where: { id: { in: [escenario.variante.id, segunda.id] } }, orderBy: { id: "asc" },
      select: { stock: true },
    })).map(({ stock }) => stock), [2, 3]);
    assert.equal(await escenario.prisma.partidaInventario.count({ where: { ingresoId: ingreso.id } }), 2);
    assert.equal(await escenario.prisma.movimientoInventario.count({ where: { ingresoId: ingreso.id } }), 2);
    await assert.rejects(confirmarIngreso(ingreso.id, {
      claveOperacion: randomUUID(), resumenAceptado: resumen.huellaResumen,
    }, escenario.actorId), (error) => error.codigo === "INGRESO_YA_CONFIRMADO");
  });
});

test("la edición invalida el resumen anterior y conserva las líneas desactivadas", async () => {
  await conEscenario(async (escenario) => {
    const proveedor = await escenario.proveedor();
    const ingreso = await crearBorradorIngreso(entrada(proveedor.id, escenario.variante.id));
    const vieja = (await resumenIngreso(ingreso.id)).huellaResumen;
    await editarBorradorIngreso(ingreso.id, entrada(proveedor.id, escenario.variante.id, {
      lineas: [{ varianteId: escenario.variante.id, cantidad: 3, costoUnitario: "100.00" }],
    }));
    await assert.rejects(confirmarIngreso(ingreso.id, {
      claveOperacion: randomUUID(), resumenAceptado: vieja,
    }, escenario.actorId), (error) => error.codigo === "RESUMEN_CAMBIO");
    assert.equal((await escenario.prisma.talleProducto.findUnique({ where: { id: escenario.variante.id } })).stock, 0);
  });
});

test("antes del corte una variante heredada se rechaza sin crear stock ni movimientos", async () => {
  await conEscenario(async (escenario) => {
    const proveedor = await escenario.proveedor();
    const ingreso = await crearBorradorIngreso(entrada(proveedor.id, escenario.variante.id));
    const resumen = await resumenIngreso(ingreso.id);
    await assert.rejects(confirmarIngreso(ingreso.id, {
      claveOperacion: randomUUID(), resumenAceptado: resumen.huellaResumen,
    }, escenario.actorId), (error) => error.codigo === "VARIANTE_HEREDADA");
    assert.equal((await escenario.prisma.ingreso.findUnique({ where: { id: ingreso.id } })).estado, "borrador");
    assert.equal(await escenario.prisma.movimientoInventario.count({ where: { ingresoId: ingreso.id } }), 0);
    assert.equal((await escenario.prisma.talleProducto.findUnique({ where: { id: escenario.variante.id } })).stock, 0);
  }, { varianteNueva: false });
});

test("una ficha marcada se publica solo tras recepción; una preexistente conserva su ruta", async () => {
  await conEscenario(async (escenario) => {
    await escenario.prisma.usuario.update({ where: { id: escenario.actorId }, data: { rol: "admin" } });
    await escenario.prisma.producto.update({
      where: { id: escenario.producto.id }, data: { creadoDesdeCompras: true, web: false },
    });
    const heredado = await escenario.prisma.producto.create({ data: {
      nombre: `Producto previo ${randomUUID()}`, precio: "200.00",
      categoriaId: escenario.categoria.id, web: false,
    } });
    const secretoPrevio = process.env.JWT_SECRET;
    if (!secretoPrevio) process.env.JWT_SECRET = randomUUID();
    const token = jwt.sign({ id: escenario.actorId, rol: "admin" }, process.env.JWT_SECRET);
    const app = express();
    app.use(express.json());
    app.use("/api", productosRoutes);
    app.use((error, req, res, next) => res.status(500).json({ message: error.message }));
    const servidor = app.listen(0, "127.0.0.1");
    try {
      if (!servidor.listening) await new Promise((resolve) => servidor.once("listening", resolve));
      const puerto = servidor.address().port;
      async function publicar(producto) {
        return fetch(`http://127.0.0.1:${puerto}/api/productos/${producto.id}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            nombre: producto.nombre, precio: 200, categoriaId: escenario.categoria.id,
            activo: true, web: true,
          }),
        });
      }
      assert.equal((await publicar(escenario.producto)).status, 409);
      assert.equal((await publicar(heredado)).status, 200);
      const proveedor = await escenario.proveedor();
      const ingreso = await crearBorradorIngreso(entrada(proveedor.id, escenario.variante.id));
      await confirmarIngreso(ingreso.id, {
        claveOperacion: randomUUID(), resumenAceptado: ingreso.huellaResumen,
      }, escenario.actorId);
      assert.equal((await publicar(escenario.producto)).status, 200);
      assert.equal((await escenario.prisma.producto.findUnique({ where: { id: escenario.producto.id } })).web, true);
    } finally {
      await new Promise((resolve, reject) => servidor.close((error) => error ? reject(error) : resolve()));
      await escenario.prisma.vigenciaPrecio.deleteMany({ where: { productoId: heredado.id } });
      await escenario.prisma.producto.delete({ where: { id: heredado.id } });
      if (!secretoPrevio) delete process.env.JWT_SECRET;
    }
  });
});
