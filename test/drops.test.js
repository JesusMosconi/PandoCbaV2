import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import prisma from "../src/db.js";
import rutasAdmin from "../src/routes/admin-drops.routes.js";
import rutasPublicas from "../src/routes/drops.routes.js";
import rutasColecciones from "../src/routes/colecciones.routes.js";
import rutasCarrito from "../src/routes/carrito.routes.js";
import rutasImagenesProducto from "../src/routes/img-producto.routes.js";
import { estadoDrop, seleccionarDrops, dropPreparado, cantidadesDisponibles, decidirActivacion, activarDrops } from "../src/services/drops.js";
import { validarDatos, validarProgramacion, datosDrop } from "../src/routes/admin-drops.routes.js";
import { esProductoPublicado, whereProductoPublicado } from "../src/utils/visibilidad-producto.js";
import { resumenCheckout } from "../src/services/checkout.js";

const ahora = new Date("2026-10-24T12:00:00.000Z");
function drop(id, fechaLanzamiento, extras = {}) {
  return { id, nombre: `Drop ${id}`, activo: true, imagenUrl: "https://example.test/portada.jpg",
    tituloInicio: "Título", textoBotonInicio: "Ver colección", fechaLanzamiento: fechaLanzamiento ? new Date(fechaLanzamiento) : null,
    fechaFinalizacion: null, fechaActivacion: null, fechaCierre: null, motivoCierre: null, ...extras };
}

test("estado distingue borrador, futuro, pendiente, activo, agotado y cierre irreversible", () => {
  assert.equal(estadoDrop(drop(1, null), ahora).estado, "borrador");
  assert.equal(estadoDrop(drop(1, "2026-10-25T00:00:00Z"), ahora).estado, "futuro");
  assert.equal(estadoDrop(drop(1, "2026-10-23T00:00:00Z"), ahora).estado, "pendiente");
  assert.equal(estadoDrop(drop(1, "2026-10-23T00:00:00Z", { fechaActivacion: ahora }), ahora, 1).estado, "activo");
  assert.equal(estadoDrop(drop(1, "2026-10-23T00:00:00Z", { fechaActivacion: ahora }), ahora, 0).estado, "pendiente");
  assert.equal(estadoDrop(drop(1, "2026-10-23T00:00:00Z", { fechaCierre: ahora }), ahora, 1).estado, "finalizado");
  assert.equal(estadoDrop(drop(1, "2026-10-23T00:00:00Z", { fechaFinalizacion: ahora }), ahora, 1).estado, "finalizado");
  assert.equal(estadoDrop(drop(1, "2026-10-25T00:00:00Z", { activo: false }), ahora).estado, "retirado");
});

test("prioriza activo, futuro más cercano, y último lanzado disponible con empate por id", () => {
  const viejo = drop(1, "2026-10-20T00:00:00Z");
  const reciente = drop(2, "2026-10-23T00:00:00Z");
  const empatado = drop(3, "2026-10-23T00:00:00Z");
  const futuroLejano = drop(4, "2026-12-01T00:00:00Z");
  const futuroCercano = drop(5, "2026-11-01T00:00:00Z");
  const cantidades = new Map([[1, 1], [2, 0], [3, 1], [4, 0], [5, 0]]);
  let seleccion = seleccionarDrops([viejo, reciente, empatado, futuroLejano, futuroCercano], cantidades, ahora);
  assert.equal(seleccion.destacado.id, 3);
  assert.equal(seleccion.futuro.id, 5);
  assert.deepEqual(seleccion.lanzados.map((item) => item.id), [3, 2, 1]);
  seleccion = seleccionarDrops([viejo, { ...reciente, activo: false }, { ...empatado, fechaActivacion: ahora }, futuroCercano], cantidades, ahora);
  assert.equal(seleccion.activo.id, 3);
  assert.equal(seleccion.destacado.id, 3);
  assert.deepEqual(seleccion.lanzados.map((item) => item.id), [3, 1]);
  seleccion = seleccionarDrops([viejo, reciente, empatado], new Map([[1, 0], [2, 0], [3, 0]]), ahora);
  assert.equal(seleccion.destacado.id, 3);
  assert.equal(seleccion.agotado, true);
  seleccion = seleccionarDrops([viejo, reciente, empatado], new Map([[1, 1], [2, 0], [3, 1]]), ahora);
  assert.equal(seleccion.destacado.id, 3);
});

test("no anuncia registros heredados incompletos ni acepta programación inválida", () => {
  assert.equal(dropPreparado(drop(1, "2026-11-01T00:00:00Z", { tituloInicio: null })), false);
  assert.equal(seleccionarDrops([drop(1, "2026-11-01T00:00:00Z", { tituloInicio: null })], new Map(), ahora).futuro, null);
  assert.match(validarDatos({ nombre: "Drop", activo: true }, true), /no está permitido/);
  assert.match(validarDatos({ nombre: "Drop", fechaLanzamiento: "2026-10-24" }, true), /zona horaria/);
  assert.match(validarDatos({ nombre: "Drop", fechaLanzamiento: "2026-02-30T12:00:00-03:00" }, true), /zona horaria/);
  const data = datosDrop({ nombre: " Drop ", fechaLanzamiento: "2026-11-01T00:00:00Z" });
  assert.equal(data.nombre, "Drop");
  assert.match(validarProgramacion(data), /portada/);
  assert.match(validarProgramacion({ ...drop(1, "2026-11-01T00:00:00Z"), fechaFinalizacion: new Date("2026-10-30T00:00:00Z") }), /posterior/);
});

test("disponibilidad cuenta un producto una vez y descuenta reservas efectivas", async () => {
  let filtro;
  const tx = {
    producto: { findMany: async (opciones) => { filtro = opciones; return [
      { id: 10, coleccionId: 1, talles: [{ id: 100, stock: 2 }, { id: 101, stock: 1 }] },
      { id: 11, coleccionId: 1, talles: [{ id: 102, stock: 1 }] },
    ]; } },
    reservaStock: { findMany: async () => [
      { talleProductoId: 100, cantidad: 2 }, { talleProductoId: 102, cantidad: 1 },
    ] },
  };
  const resultado = await cantidadesDisponibles(tx, [1], ahora);
  assert.equal(resultado.get(1), 1);
  assert.deepEqual(filtro.select.talles.where, { estado: { not: "inactivo" } });
});

test("la publicación pública exige activación registrada y conserva históricos", () => {
  const base = { activo: true, web: true, coleccionId: 7 };
  assert.equal(esProductoPublicado({ ...base, coleccion: { fechaActivacion: null } }), false);
  assert.equal(esProductoPublicado({ ...base, coleccion: { fechaActivacion: ahora, fechaCierre: ahora } }), true);
  assert.equal(esProductoPublicado({ activo: true, web: true, coleccionId: null }), true);
  assert.equal(esProductoPublicado({ ...base, web: false, coleccion: { fechaActivacion: ahora } }), false);
  assert.deepEqual(whereProductoPublicado.OR, [
    { coleccionId: null }, { coleccion: { is: { fechaActivacion: { not: null } } } },
  ]);
});

test("checkout rechaza un producto de drop sin activación y lo acepta tras lanzarse", async () => {
  const producto = { id: 10, nombre: "Producto preparado", precio: 100, activo: true, web: true,
    coleccionId: 7, coleccion: { fechaActivacion: null } };
  const variante = { id: 100, stock: 2, estado: "activo", producto,
    talle: { valor: "M" }, color: { nombre: "Negro" } };
  const carrito = { id: 1, items: [{ id: 1, cantidad: 1, precioUnitario: 100,
    talleProductoId: 100, talleProducto: variante, productoImprovisadoId: null }] };
  const tx = { $queryRaw: async () => [{ ahora }], reservaStock: { findMany: async () => [] } };
  const pendiente = await resumenCheckout(7, { tipoEntrega: "retiro" }, tx, carrito);
  assert.deepEqual(pendiente.lineas[0].motivosBloqueo, ["drop_no_lanzado"]);
  assert.equal(pendiente.puedeConfirmar, false);
  producto.coleccion.fechaActivacion = ahora;
  const lanzado = await resumenCheckout(7, { tipoEntrega: "retiro" }, tx, carrito);
  assert.deepEqual(lanzado.lineas[0].motivosBloqueo, []);
  assert.equal(lanzado.puedeConfirmar, true);
});

test("carrito rechaza variante de drop no lanzado e imágenes preserva acceso administrativo", async () => {
  const original = { usuario: prisma.usuario.findUnique, carrito: prisma.carrito.findFirst,
    transaccion: prisma.$transaction, producto: prisma.producto.findFirst,
    imagenes: prisma.imgProducto.findMany };
  const secretoPrevio = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "secreto-publicacion-drops";
  let rol = "cliente";
  const producto = { id: 10, activo: true, web: true, coleccionId: 7,
    coleccion: { fechaActivacion: null } };
  const carrito = { id: 4, usuarioId: 1, estado: "activo", actualizado: new Date(), items: [] };
  prisma.usuario.findUnique = async ({ select }) => select.activo ? { activo: true } : { rol };
  prisma.carrito.findFirst = async () => carrito;
  prisma.producto.findFirst = async ({ where }) =>
    where.id === producto.id && (where.OR ? false : true) ? producto : null;
  prisma.imgProducto.findMany = async () => [{ id: 1, productoId: producto.id, url: "https://example.test/a.jpg" }];
  prisma.$transaction = async (callback) => callback({
    $queryRaw: async () => [],
    carrito: { findFirst: async () => carrito },
    talleProducto: { findUnique: async () => ({ id: 100, estado: "activo", producto }) },
  });
  const app = express(); app.use(express.json()); app.use("/api", rutasCarrito, rutasImagenesProducto);
  app.use((error, _req, res, _next) => res.status(500).json({ message: error.message }));
  const servidor = app.listen(0, "127.0.0.1");
  try {
    if (!servidor.listening) await new Promise((resolve) => servidor.once("listening", resolve));
    const base = `http://127.0.0.1:${servidor.address().port}/api`;
    const token = jwt.sign({ id: 1 }, process.env.JWT_SECRET);
    const respuesta = await fetch(`${base}/carrito/items`, { method: "POST", headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "application/json",
    }, body: JSON.stringify({ talleProductoId: 100, cantidad: 1 }) });
    assert.equal(respuesta.status, 400);
    assert.equal((await fetch(`${base}/img-producto/10`)).status, 404);
    assert.equal((await fetch(`${base}/img-producto/10?admin=true`)).status, 401);
    rol = "admin";
    assert.equal((await fetch(`${base}/img-producto/10?admin=true`, { headers: {
      Authorization: `Bearer ${token}`,
    } })).status, 200);
  } finally {
    await new Promise((resolve) => servidor.close(resolve));
    prisma.usuario.findUnique = original.usuario;
    prisma.carrito.findFirst = original.carrito;
    prisma.$transaction = original.transaccion;
    prisma.producto.findFirst = original.producto;
    prisma.imgProducto.findMany = original.imagenes;
    if (secretoPrevio === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = secretoPrevio;
  }
});

test("la activación elige el más reciente disponible, reemplaza y no revive al cerrado", () => {
  const anterior = drop(1, "2026-10-20T00:00:00Z", { fechaActivacion: new Date("2026-10-20T00:01:00Z") });
  const nuevo = drop(2, "2026-10-23T00:00:00Z");
  assert.equal(decidirActivacion([anterior, nuevo], new Map([[1, 1], [2, 0]]), ahora), null);
  const decision = decidirActivacion([anterior, nuevo], new Map([[1, 1], [2, 1]]), ahora);
  assert.equal(decision.candidato.id, 2);
  assert.deepEqual(decision.vigentes.map((item) => item.id), [1]);
  const cerrado = { ...nuevo, fechaActivacion: ahora, fechaCierre: ahora, motivoCierre: "manual" };
  assert.equal(decidirActivacion([anterior, cerrado], new Map([[1, 1], [2, 1]]), ahora), null);
  assert.equal(decidirActivacion([anterior, { ...nuevo, fechaFinalizacion: ahora }], new Map([[1, 1], [2, 1]]), ahora), null);
});

test("la activación respeta inicio, fin, empate y cierre manual tras recuperar stock", () => {
  const vigente = drop(1, "2026-10-20T00:00:00Z", { fechaActivacion: new Date("2026-10-20T00:01:00Z") });
  const empatadoMenor = drop(2, "2026-10-23T00:00:00Z");
  const empatadoMayor = drop(3, "2026-10-23T00:00:00Z");
  const futuro = drop(4, "2026-10-25T00:00:00Z");
  const vencido = drop(5, "2026-10-22T00:00:00Z", { fechaFinalizacion: ahora });
  const cantidades = new Map([[1, 1], [2, 1], [3, 1], [4, 1], [5, 1]]);
  assert.equal(decidirActivacion([vigente, empatadoMenor, empatadoMayor, futuro, vencido], cantidades, ahora).candidato.id, 3);
  cantidades.set(3, 0);
  assert.equal(decidirActivacion([vigente, empatadoMenor, empatadoMayor, futuro, vencido], cantidades, ahora).candidato.id, 2);
  cantidades.set(2, 0);
  assert.equal(decidirActivacion([vigente, empatadoMenor, empatadoMayor, futuro, vencido], cantidades, ahora), null);
  cantidades.set(3, 1);
  assert.equal(decidirActivacion([vigente, empatadoMenor, empatadoMayor, futuro, vencido], cantidades, ahora).candidato.id, 3);
  empatadoMayor.fechaCierre = ahora;
  empatadoMayor.motivoCierre = "manual";
  assert.equal(decidirActivacion([vigente, empatadoMenor, empatadoMayor, futuro, vencido], cantidades, ahora), null);
});

test("categorías limita tres lanzados y elige último disponible o agotado sin futuros ni retirados", () => {
  const lanzados = [
    drop(1, "2026-10-19T00:00:00Z"), drop(2, "2026-10-20T00:00:00Z"),
    drop(3, "2026-10-21T00:00:00Z"), drop(4, "2026-10-22T00:00:00Z"),
  ];
  const futuro = drop(5, "2026-10-25T00:00:00Z");
  const retirado = drop(6, "2026-10-23T00:00:00Z", { activo: false });
  const incompleto = drop(7, "2026-10-24T00:00:00Z", { imagenUrl: null });
  const drops = [...lanzados, futuro, retirado, incompleto];
  let seleccion = seleccionarDrops(drops, new Map([[1, 1], [2, 1], [3, 0], [4, 0]]), ahora);
  assert.equal(seleccion.destacado.id, 2);
  assert.deepEqual(seleccion.lanzados.slice(0, 3).map((item) => item.id), [4, 3, 2]);
  assert.equal(seleccion.futuro.id, 5);
  seleccion = seleccionarDrops(drops, new Map(), ahora);
  assert.equal(seleccion.destacado.id, 4);
  assert.equal(seleccion.agotado, true);
  seleccion = seleccionarDrops([futuro, retirado, incompleto], new Map(), ahora);
  assert.equal(seleccion.destacado, null);
  assert.deepEqual(seleccion.lanzados, []);
});

test("rutas administrativas exigen rol vigente y las lecturas públicas no escriben", async () => {
  const original = {
    usuario: prisma.usuario.findUnique, colecciones: prisma.coleccion.findMany,
    productos: prisma.producto.findMany, reservas: prisma.reservaStock.findMany,
    marca: prisma.configuracionPortadaInicio.findUnique,
  };
  const secretoPrevio = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "secreto-de-prueba-drops";
  let rol = "cliente";
  let colecciones = [drop(1, "2026-11-18T00:00:00Z")];
  let marca = null;
  let productos = [];
  prisma.usuario.findUnique = async ({ select }) => select.activo ? { activo: true } : { rol };
  prisma.coleccion.findMany = async () => colecciones;
  prisma.producto.findMany = async () => productos;
  prisma.reservaStock.findMany = async () => [];
  prisma.configuracionPortadaInicio.findUnique = async () => marca;
  const app = express();
  app.use(express.json()); app.use("/api", rutasAdmin, rutasPublicas);
  app.use((error, _req, res, _next) => res.status(500).json({ message: error.message }));
  const servidor = app.listen(0, "127.0.0.1");
  try {
    if (!servidor.listening) await new Promise((resolve) => servidor.once("listening", resolve));
    const base = `http://127.0.0.1:${servidor.address().port}/api`;
    const token = jwt.sign({ id: 1 }, process.env.JWT_SECRET);
    assert.equal((await fetch(`${base}/admin/drops`)).status, 401);
    assert.equal((await fetch(`${base}/admin/drops`, { headers: { Authorization: `Bearer ${token}` } })).status, 403);
    rol = "admin";
    assert.equal((await fetch(`${base}/admin/drops`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    let respuesta = await fetch(`${base}/drops/inicio`);
    assert.equal(respuesta.status, 200);
    const inicio = await respuesta.json();
    assert.equal(inicio.tipo, "futuro");
    assert.equal(Object.hasOwn(inicio, "urlColeccion"), false);
    colecciones = [];
    respuesta = await fetch(`${base}/drops/inicio`);
    assert.equal(respuesta.status, 503);
    assert.equal((await respuesta.json()).codigo, "CONFIGURACION_INCOMPLETA");
    respuesta = await fetch(`${base}/drops/categorias`);
    assert.deepEqual(await respuesta.json(), { destacado: null, colecciones: [] });
    marca = { titulo: null, imagenUrl: "https://example.test/marca.jpg" };
    respuesta = await fetch(`${base}/drops/inicio`);
    assert.deepEqual(await respuesta.json(), { tipo: "marca", marca: { imagenUrl: marca.imagenUrl } });
    colecciones = [drop(1, "2026-10-20T00:00:00Z"), drop(2, "2026-10-22T00:00:00Z"),
      drop(3, "2026-10-23T00:00:00Z"), drop(4, "2026-10-24T00:00:00Z")];
    productos = [{ id: 10, coleccionId: 2, talles: [{ id: 100, stock: 1 }] }];
    respuesta = await fetch(`${base}/drops/categorias`);
    const categorias = await respuesta.json();
    assert.equal(categorias.destacado.id, 2);
    assert.equal(categorias.destacado.agotado, false);
    assert.deepEqual(categorias.colecciones.map((item) => item.id), [4, 3, 2]);
    productos = [];
    respuesta = await fetch(`${base}/drops/categorias`);
    assert.deepEqual((await respuesta.json()).destacado, { id: 4, nombre: "Drop 4",
      imagenUrl: "https://example.test/portada.jpg", urlColeccion: "/colecciones/4", agotado: true });
    const [inicioConcurrente, categoriasConcurrente] = await Promise.all([
      fetch(`${base}/drops/inicio`), fetch(`${base}/drops/categorias`),
    ]);
    assert.equal(inicioConcurrente.status, 200);
    assert.equal(categoriasConcurrente.status, 200);
    assert.deepEqual((await categoriasConcurrente.json()).colecciones.map((item) => item.id), [4, 3, 2]);
  } finally {
    await new Promise((resolve) => servidor.close(resolve));
    prisma.usuario.findUnique = original.usuario;
    prisma.coleccion.findMany = original.colecciones;
    prisma.producto.findMany = original.productos;
    prisma.reservaStock.findMany = original.reservas;
    prisma.configuracionPortadaInicio.findUnique = original.marca;
    if (secretoPrevio === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = secretoPrevio;
  }
});

test("trabajo interno activa al liberar una reserva y reemplaza una sola vez", async () => {
  const original = prisma.$transaction;
  const anterior = drop(1, "2026-10-20T00:00:00Z", { fechaActivacion: new Date("2026-10-20T00:01:00Z") });
  const nuevo = drop(2, "2026-10-23T00:00:00Z");
  const filas = [anterior, nuevo];
  let reservaActiva = true;
  const cambios = [];
  const tx = {
    $queryRaw: async (partes) => {
      const sql = partes.join("");
      if (sql.includes("pg_advisory_xact_lock")) {
        assert.match(sql, /pg_advisory_xact_lock\(5005, 1\)::text/);
        return [{ bloqueo: "" }];
      }
      return [{ ahora }];
    },
    coleccion: {
      findMany: async () => filas,
      update: async ({ where, data }) => {
        const fila = filas.find((item) => item.id === where.id);
        Object.assign(fila, data);
        cambios.push({ id: fila.id, ...data });
        return fila;
      },
      updateMany: async ({ where, data }) => {
        for (const fila of filas.filter((item) => where.id.in.includes(item.id))) {
          Object.assign(fila, data);
          cambios.push({ id: fila.id, ...data });
        }
        return { count: where.id.in.length };
      },
    },
    producto: { findMany: async () => [
      { id: 10, coleccionId: 1, talles: [{ id: 100, stock: 1 }] },
      { id: 11, coleccionId: 2, talles: [{ id: 101, stock: 1 }] },
    ] },
    reservaStock: { findMany: async () => reservaActiva ? [{ talleProductoId: 101, cantidad: 1 }] : [] },
  };
  prisma.$transaction = async (callback) => callback(tx);
  try {
    assert.equal(await activarDrops(), null);
    reservaActiva = false;
    assert.equal(await activarDrops(), 2);
    assert.equal(anterior.motivoCierre, "reemplazo");
    assert.equal(nuevo.fechaActivacion?.getTime(), ahora.getTime());
    assert.equal(changesCount(), 2);
    assert.equal(await activarDrops(), null);
    assert.equal(changesCount(), 2);
  } finally { prisma.$transaction = original; }
  function changesCount() { return cambios.length; }
});

test("CRUD HTTP administra borrador, programación, cierre y retiro con validación", async () => {
  const original = {
    usuario: prisma.usuario.findUnique, find: prisma.coleccion.findUnique,
    many: prisma.coleccion.findMany, create: prisma.coleccion.create, update: prisma.coleccion.update,
    productos: prisma.producto.findMany, reservas: prisma.reservaStock.findMany,
    marca: prisma.configuracionPortadaInicio.findUnique, upsertMarca: prisma.configuracionPortadaInicio.upsert,
  };
  const secretoPrevio = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "secreto-crud-drops";
  const filas = [];
  prisma.usuario.findUnique = async ({ select }) => select.activo ? { activo: true } : { rol: "admin" };
  prisma.coleccion.findUnique = async ({ where }) => filas.find((fila) => fila.id === where.id) ?? null;
  prisma.coleccion.findMany = async () => filas;
  prisma.coleccion.create = async ({ data }) => { const fila = drop(filas.length + 1, null, { ...data, imagenUrl: null }); filas.push(fila); return fila; };
  prisma.coleccion.update = async ({ where, data }) => { const fila = filas.find((item) => item.id === where.id); Object.assign(fila, data); return fila; };
  prisma.producto.findMany = async () => [];
  prisma.reservaStock.findMany = async () => [];
  prisma.configuracionPortadaInicio.findUnique = async () => ({ id: 1, titulo: null, imagenUrl: "https://example.test/marca.jpg", fechaCompletada: ahora });
  prisma.configuracionPortadaInicio.upsert = async ({ update }) => ({ id: 1, titulo: update.titulo, imagenUrl: "https://example.test/marca.jpg", fechaCompletada: ahora });
  const app = express(); app.use(express.json()); app.use("/api", rutasAdmin, rutasPublicas, rutasColecciones);
  app.use((error, _req, res, _next) => res.status(500).json({ message: error.message }));
  const servidor = app.listen(0, "127.0.0.1");
  try {
    if (!servidor.listening) await new Promise((resolve) => servidor.once("listening", resolve));
    const base = `http://127.0.0.1:${servidor.address().port}/api/admin/drops`;
    const token = jwt.sign({ id: 1 }, process.env.JWT_SECRET);
    const enviar = (ruta, method, body) => fetch(`${base}${ruta}`, { method, headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await enviar("", "POST", { nombre: "Inválido", activo: true })).status, 400);
    let respuesta = await enviar("", "POST", { nombre: "Verano", tituloInicio: "Verano", textoBotonInicio: "Ver" });
    assert.equal(respuesta.status, 201);
    const creado = await respuesta.json();
    assert.equal(creado.id, 1);
    const futuro = new Date(Date.now() + 86_400_000).toISOString();
    assert.equal((await enviar("/1", "PUT", { fechaLanzamiento: futuro })).status, 400);
    filas[0].imagenUrl = "https://example.test/verano.jpg";
    respuesta = await enviar("/1", "PUT", { fechaLanzamiento: futuro });
    assert.equal(respuesta.status, 200);
    assert.equal((await (await fetch(`http://127.0.0.1:${servidor.address().port}/api/drops/inicio`)).json()).tipo, "futuro");
    assert.equal((await fetch(`http://127.0.0.1:${servidor.address().port}/api/colecciones/1`)).status, 404);
    assert.equal((await enviar("/1/finalizar", "POST")).status, 409);
    filas[0].fechaLanzamiento = new Date(Date.now() - 86_400_000);
    filas[0].fechaActivacion = new Date();
    assert.equal((await enviar("/1/finalizar", "POST")).status, 200);
    assert.equal((await enviar("/1/finalizar", "POST")).status, 200);
    assert.equal(filas[0].motivoCierre, "manual");
    assert.equal((await enviar("/1", "DELETE")).status, 200);
    assert.equal(filas[0].activo, false);
    assert.equal((await fetch(`http://127.0.0.1:${servidor.address().port}/api/colecciones/1`)).status, 200);
    assert.equal((await (await fetch(`http://127.0.0.1:${servidor.address().port}/api/colecciones`)).json()).length, 1);
    assert.equal((await enviar("/marca", "PUT", { titulo: "" })).status, 200);
    assert.equal((await (await enviar("/marca", "GET")).json()).completo, true);
    assert.equal((await enviar("/marca/imagen", "DELETE")).status, 409);
  } finally {
    await new Promise((resolve) => servidor.close(resolve));
    prisma.usuario.findUnique = original.usuario;
    prisma.coleccion.findUnique = original.find;
    prisma.coleccion.findMany = original.many;
    prisma.coleccion.create = original.create;
    prisma.coleccion.update = original.update;
    prisma.producto.findMany = original.productos;
    prisma.reservaStock.findMany = original.reservas;
    prisma.configuracionPortadaInicio.findUnique = original.marca;
    prisma.configuracionPortadaInicio.upsert = original.upsertMarca;
    if (secretoPrevio === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = secretoPrevio;
  }
});
