import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import prisma from "../src/db.js";
import rutas from "../src/routes/catalogo-inicio.routes.js";

test("selección administrativa, visibilidad y escrituras simultáneas", {
  skip: process.env.PANDO_TEST_CATALOGO !== "1",
}, async () => {
  const destino = new URL(process.env.DATABASE_URL);
  assert.equal(destino.hostname, "ep-floral-dust-acglee71.sa-east-1.aws.neon.tech");
  assert.equal(destino.pathname, "/neondb");
  assert.equal(process.env.PANDO_TEST_BRANCH_ID, "br-snowy-glitter-acxy36q0");
  assert.equal(await prisma.$queryRaw`SELECT current_schema() AS esquema`.then((r) => r[0].esquema), "public");

  const original = await prisma.catalogoInicio.findMany({
    where: { activo: true }, orderBy: [{ orden: "asc" }, { id: "asc" }],
  });
  const admin = await prisma.usuario.findFirst({ where: { rol: "admin", activo: true }, select: { id: true } });
  const cliente = await prisma.usuario.findFirst({ where: { rol: "cliente", activo: true }, select: { id: true } });
  const categoria = await prisma.categoria.findFirst({ select: { id: true } });
  const colecciones = await prisma.coleccion.findMany({ take: 2, select: { id: true } });
  assert.ok(admin && cliente && categoria && colecciones.length >= 1);

  const secretoPrevio = process.env.JWT_SECRET;
  process.env.JWT_SECRET = randomUUID();
  const tokenAdmin = jwt.sign({ id: admin.id }, process.env.JWT_SECRET);
  const tokenCliente = jwt.sign({ id: cliente.id }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json());
  app.use("/api", rutas);
  app.use((error, _req, res, _next) => res.status(500).json({ message: error.message }));
  const servidor = app.listen(0, "127.0.0.1");
  const creados = [];
  let coleccionTemporal;

  try {
    if (!servidor.listening) await new Promise((resolve) => servidor.once("listening", resolve));
    if (colecciones.length === 1) {
      coleccionTemporal = await prisma.coleccion.create({ data: { nombre: `Prueba catálogo ${randomUUID()}` } });
      colecciones.push({ id: coleccionTemporal.id });
    }
    const base = `http://127.0.0.1:${servidor.address().port}/api/catalogo-inicio`;
    const enviar = (ruta, method = "GET", datos, token = tokenAdmin) => fetch(`${base}${ruta}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      ...(datos === undefined ? {} : { body: JSON.stringify(datos) }),
    });
    for (let indice = 0; indice < 6; indice += 1) {
      const producto = await prisma.producto.create({ data: {
        nombre: `Prueba catálogo ${randomUUID()}`, precio: "100.00", categoriaId: categoria.id,
        coleccionId: colecciones[indice % 2].id, activo: true, web: true,
      } });
      creados.push(producto.id);
    }
    const ids = creados.slice(0, 5);
    assert.equal((await enviar("/seleccion", "GET", undefined, null)).status, 401);
    assert.equal((await enviar("/seleccion", "GET", undefined, tokenCliente)).status, 403);
    assert.equal((await enviar("/seleccion", "PUT", { productoIds: [] }, tokenCliente)).status, 403);

    let respuesta = await enviar("/seleccion", "PUT", { productoIds: [] });
    assert.equal(respuesta.status, 200);
    assert.deepEqual(await respuesta.json(), []);
    assert.deepEqual(await (await enviar("", "GET", undefined, null)).json(), []);

    respuesta = await enviar("/seleccion", "PUT", { productoIds: [ids[0]] });
    assert.equal(respuesta.status, 200);
    assert.deepEqual((await respuesta.json()).map((fila) => fila.orden), [1]);
    respuesta = await enviar("/seleccion", "PUT", { productoIds: ids });
    assert.equal(respuesta.status, 200);
    assert.deepEqual((await respuesta.json()).map((fila) => fila.productoId), ids);
    assert.deepEqual((await (await enviar("", "GET", undefined, null)).json()).map((fila) => fila.productoId), ids);
    assert.equal((await enviar("/seleccion", "PUT", { productoIds: [...ids, creados[5]] })).status, 400);
    assert.equal((await enviar("/seleccion", "PUT", { productoIds: [ids[0], ids[0]] })).status, 409);
    assert.equal((await enviar("/seleccion", "PUT", { productoIds: [0] })).status, 400);
    assert.equal((await enviar("/seleccion", "PUT", { productoIds: [999999999] })).status, 404);
    assert.deepEqual((await (await enviar("/seleccion")).json()).map((fila) => fila.productoId), ids);

    await prisma.producto.update({ where: { id: ids[0] }, data: { activo: false } });
    await prisma.producto.update({ where: { id: ids[1] }, data: { web: false } });
    await prisma.producto.update({ where: { id: ids[2] }, data: { activo: false, web: false } });
    const administracion = await (await enviar("/seleccion")).json();
    assert.deepEqual(administracion.map((fila) => fila.motivosOcultamiento), [
      ["inactivo"], ["no_publicado"], ["inactivo", "no_publicado"], [], [],
    ]);
    assert.deepEqual((await (await enviar("", "GET", undefined, null)).json()).map((fila) => fila.productoId), ids.slice(3));
    assert.equal((await enviar(`/${administracion[0].id}`, "GET", undefined, null)).status, 404);
    assert.equal((await enviar("/seleccion", "PUT", { productoIds: [] })).status, 200);
    assert.equal((await enviar("/seleccion", "PUT", { productoIds: [ids[2]] })).status, 200);
    assert.deepEqual((await (await enviar("/seleccion")).json())[0].motivosOcultamiento,
      ["inactivo", "no_publicado"]);
    assert.deepEqual(await (await enviar("", "GET", undefined, null)).json(), []);
    assert.equal((await enviar("/seleccion", "PUT", { productoIds: [...ids.slice(0, 4), creados[5]] })).status, 200);
    assert.deepEqual((await (await enviar("/seleccion")).json()).map((fila) => fila.productoId), [...ids.slice(0, 4), creados[5]]);

    await prisma.producto.update({ where: { id: ids[0] }, data: { activo: true } });
    await prisma.producto.update({ where: { id: ids[1] }, data: { web: true } });
    await prisma.producto.update({ where: { id: ids[2] }, data: { activo: true, web: true } });
    assert.deepEqual((await (await enviar("", "GET", undefined, null)).json()).map((fila) => fila.productoId), ids.slice(0, 4).concat(creados[5]));

    respuesta = await enviar(`/${administracion[0].id}`, "DELETE");
    assert.equal(respuesta.status, 200);
    assert.equal((await prisma.catalogoInicio.findUnique({ where: { id: administracion[0].id } })).activo, false);
    respuesta = await enviar("", "POST", { orden: 1, productoId: ids[0] });
    assert.equal(respuesta.status, 200);
    assert.equal((await respuesta.json()).id, administracion[0].id);
    assert.equal((await enviar("", "POST", { orden: 1, productoId: ids[0] })).status, 409);
    assert.equal((await enviar("", "POST", { orden: 6, productoId: ids[4] })).status, 400);
    assert.equal((await enviar(`/${administracion[0].id}`, "PUT", { orden: 2, productoId: ids[1] })).status, 409);
    assert.equal((await enviar(`/${administracion[0].id}`, "PUT", { orden: 3, productoId: ids[0] })).status, 200);
    assert.equal((await (await enviar("/seleccion")).json())[2].productoId, ids[0]);

    await enviar("/seleccion", "PUT", { productoIds: [] });
    const concurrentes = await Promise.all([
      enviar("/seleccion", "PUT", { productoIds: ids }),
      enviar("/seleccion", "PUT", { productoIds: [creados[5]] }),
    ]);
    assert.deepEqual(concurrentes.map((r) => r.status), [200, 200]);
    const final = await (await enviar("/seleccion")).json();
    assert.ok(final.length <= 5);
    assert.deepEqual(final.map((fila) => fila.orden), final.map((_, indice) => indice + 1));
  } finally {
    try {
      const { reemplazarSeleccion } = await import("../src/services/catalogo-inicio.js");
      await reemplazarSeleccion(original.map((fila) => fila.productoId));
    } finally {
      await prisma.catalogoInicio.deleteMany({ where: { productoId: { in: creados } } });
      await prisma.producto.deleteMany({ where: { id: { in: creados } } });
      if (coleccionTemporal) await prisma.coleccion.delete({ where: { id: coleccionTemporal.id } });
      await new Promise((resolve, reject) => servidor.close((error) => error ? reject(error) : resolve()));
      if (secretoPrevio === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = secretoPrevio;
    }
  }
});
