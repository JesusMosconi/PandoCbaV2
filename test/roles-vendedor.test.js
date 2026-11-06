import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import prisma from "../src/db.js";
import rutasUsuarios from "../src/routes/usuarios.routes.js";
import rutasProductos from "../src/routes/productos.routes.js";
import rutasCheckout from "../src/routes/checkout.routes.js";
import rutasOrdenes from "../src/routes/ordenes.routes.js";
import rutasAdminOrdenes from "../src/routes/admin-ordenes.routes.js";
import rutasVendedor from "../src/routes/vendedor.routes.js";
import { esVendedor } from "../src/middleware/es-vendedor.js";
import { buscarProductosLocal } from "../src/services/venta-local.js";
import { crearEscenario, exigirBasePrueba } from "./soporte/escenario.js";
import { hayVendedorActivoAjeno } from "./soporte/venta-local.js";

const opciones = { skip: !process.env.PANDO_TEST_BRANCH_ID && "Base de prueba no configurada" };

/** Levanta las rutas reales en un puerto libre con un secreto JWT de prueba. */
async function conServidor(prueba) {
  const secretoPrevio = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secretoPrevio ?? "secreto-de-prueba-007";
  const app = express();
  app.use(express.json());
  app.use("/api", rutasUsuarios, rutasProductos, rutasCheckout, rutasOrdenes, rutasAdminOrdenes, rutasVendedor);
  app.use((error, _req, res, _next) => res.status(500).json({ message: error.message }));
  const servidor = app.listen(0, "127.0.0.1");
  try {
    if (!servidor.listening) await new Promise((resolve) => servidor.once("listening", resolve));
    const base = `http://127.0.0.1:${servidor.address().port}/api`;
    const pedir = (usuario, ruta, { method = "GET", body } = {}) => fetch(`${base}${ruta}`, {
      method,
      headers: {
        ...(usuario ? { Authorization: `Bearer ${jwt.sign({ id: usuario.id }, process.env.JWT_SECRET)}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    await prueba(pedir);
  } finally {
    await new Promise((resolve) => servidor.close(resolve));
    if (secretoPrevio === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = secretoPrevio;
  }
}

async function conUsuarios(t, prueba) {
  exigirBasePrueba();
  if (await hayVendedorActivoAjeno(prisma)) {
    t.skip("La base de prueba ya tiene un vendedor activo ajeno a la prueba");
    return;
  }
  const escenario = await crearEscenario({ clientes: 3 });
  const [admin, a, b] = escenario.usuarios;
  await prisma.usuario.update({ where: { id: admin.id }, data: { rol: "admin" } });
  try { await conServidor((pedir) => prueba({ escenario, admin, a, b, pedir })); }
  finally { await escenario.limpiar(); }
}

test("el admin asigna un vendedor y el segundo vendedor activo se rechaza", opciones, async (t) => {
  await conUsuarios(t, async ({ admin, a, b, pedir }) => {
    const asignado = await pedir(admin, `/admin/usuarios/${a.id}/rol`, { method: "PUT", body: { rol: "vendedor" } });
    assert.equal(asignado.status, 200);
    assert.equal((await asignado.json()).rol, "vendedor");

    const segundo = await pedir(admin, `/admin/usuarios/${b.id}/rol`, { method: "PUT", body: { rol: "vendedor" } });
    assert.equal(segundo.status, 409);
    assert.equal((await segundo.json()).codigo, "VENDEDOR_EXISTENTE");
    assert.equal((await prisma.usuario.findUnique({ where: { id: b.id } })).rol, "cliente");

    // Desactivado el primero, se puede asignar otro; reactivar al primero vuelve a chocar.
    assert.equal((await pedir(admin, `/admin/usuarios/${a.id}/estado`, { method: "PATCH", body: { activo: false } })).status, 200);
    assert.equal((await pedir(admin, `/admin/usuarios/${b.id}/rol`, { method: "PUT", body: { rol: "vendedor" } })).status, 200);
    const reactivado = await pedir(admin, `/admin/usuarios/${a.id}/estado`, { method: "PATCH", body: { activo: true } });
    assert.equal(reactivado.status, 409);
    assert.equal((await reactivado.json()).codigo, "VENDEDOR_EXISTENTE");
  });
});

test("dos reactivaciones simultáneas de vendedores dejan uno solo activo", opciones, async (t) => {
  await conUsuarios(t, async ({ admin, a, b, pedir }) => {
    await prisma.usuario.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { rol: "vendedor", activo: false } });
    const respuestas = await Promise.all([a, b].map((usuario) =>
      pedir(admin, `/admin/usuarios/${usuario.id}/estado`, { method: "PATCH", body: { activo: true } })));
    assert.deepEqual(respuestas.map(({ status }) => status).sort(), [200, 409]);
    assert.equal(await prisma.usuario.count({
      where: { id: { in: [a.id, b.id] }, rol: "vendedor", activo: true },
    }), 1);
  });
});

test("el vendedor entra al punto de venta y recibe 403 en admin, checkout y órdenes; inactivo, 401", opciones, async (t) => {
  await conUsuarios(t, async ({ a, b, pedir }) => {
    await prisma.usuario.update({ where: { id: a.id }, data: { rol: "vendedor" } });
    assert.equal((await pedir(a, "/vendedor/caja")).status, 200);
    assert.equal((await pedir(a, "/admin/ordenes")).status, 403);
    assert.equal((await pedir(a, "/admin/usuarios")).status, 403);
    assert.equal((await pedir(a, "/productos?admin=true")).status, 403);
    assert.equal((await pedir(a, "/checkout/resumen", { method: "POST", body: { tipoEntrega: "retiro" } })).status, 403);
    assert.equal((await pedir(a, "/ordenes")).status, 403);

    // Un cliente no entra al punto de venta; sin token, 401.
    const cliente = await pedir(b, "/vendedor/caja");
    assert.equal(cliente.status, 403);
    assert.equal((await cliente.json()).codigo, "ROL_NO_AUTORIZADO");
    assert.equal((await pedir(null, "/vendedor/caja")).status, 401);

    await prisma.usuario.update({ where: { id: a.id }, data: { activo: false } });
    assert.equal((await pedir(a, "/vendedor/caja")).status, 401);
  });
});

test("el middleware del local admite al admin activo y rechaza al inactivo", opciones, async () => {
  exigirBasePrueba();
  const escenario = await crearEscenario();
  try {
    const usuario = escenario.usuarios[0];
    await prisma.usuario.update({ where: { id: usuario.id }, data: { rol: "admin" } });
    let admitido = false;
    await esVendedor({ usuario: { id: usuario.id } }, {}, () => { admitido = true; });
    assert.equal(admitido, true);
    await prisma.usuario.update({ where: { id: usuario.id }, data: { activo: false } });
    let estado = null;
    await esVendedor({ usuario: { id: usuario.id } }, {
      status(valor) { estado = valor; return this; }, json() { return this; },
    }, () => { throw new Error("Un admin inactivo no debe vender"); });
    assert.equal(estado, 403);
  } finally { await escenario.limpiar(); }
});

test("un producto solo local no aparece en la tienda web pero sí en el punto de venta", opciones, async () => {
  exigirBasePrueba();
  const escenario = await crearEscenario();
  try {
    await prisma.producto.update({ where: { id: escenario.producto.id }, data: { web: false, local: true } });
    await conServidor(async (pedir) => {
      const publicos = await (await pedir(null, `/productos?categoriaId=${escenario.categoria.id}`)).json();
      assert.equal(publicos.some(({ id }) => id === escenario.producto.id), false);
      assert.equal((await pedir(null, `/productos/${escenario.producto.id}`)).status, 404);
    });
    const local = await buscarProductosLocal({ categoriaId: escenario.categoria.id });
    assert.deepEqual(local.productos.map(({ id }) => id), [escenario.producto.id]);
    assert.equal(local.productos[0].web, false);

    // Sin variantes vendibles sigue apareciendo, marcado como sin stock.
    await prisma.talleProducto.update({ where: { id: escenario.variante.id }, data: { estado: "inactivo" } });
    const sinStock = await buscarProductosLocal({ categoriaId: escenario.categoria.id });
    assert.deepEqual(sinStock.productos.map(({ id, sinStock: agotado, variantes }) => [id, agotado, variantes.length]),
      [[escenario.producto.id, true, 0]]);

    await prisma.producto.update({ where: { id: escenario.producto.id }, data: { web: true, local: false } });
    assert.equal((await buscarProductosLocal({ categoriaId: escenario.categoria.id })).total, 0);
  } finally { await escenario.limpiar(); }
});
