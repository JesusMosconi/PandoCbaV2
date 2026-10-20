import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import { crearEscenario } from "./soporte/escenario.js";
import variantesRoutes from "../src/routes/talle-producto.routes.js";
import { ajustarInventario } from "../src/services/inventario.js";

test("alta, edición y baja de variante solo admiten stock por ajuste trazable", {
  skip: process.env.PANDO_TEST_SPECIAL !== "1",
}, async () => {
  const escenario = await crearEscenario({ stock: 0 });
  const db = escenario.prisma;
  const corte = await db.estadoCorteInventario.findUnique({ where: { id: 1 } });
  assert.equal(corte.estado, "activo");
  const actor = escenario.usuarios[0].id;
  await db.usuario.update({ where: { id: actor }, data: { rol: "admin" } });
  const talle = await db.talle.create({ data: { valor: `T-${randomUUID()}` } });
  const secretoPrevio = process.env.JWT_SECRET;
  if (!secretoPrevio) process.env.JWT_SECRET = randomUUID();
  const token = jwt.sign({ id: actor, rol: "admin" }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json());
  app.use("/api", variantesRoutes);
  app.use((error, req, res, next) => res.status(500).json({ message: error.message }));
  const servidor = app.listen(0, "127.0.0.1");
  try {
    if (!servidor.listening) await new Promise((resolve) => servidor.once("listening", resolve));
    const base = `http://127.0.0.1:${servidor.address().port}/api/talle-producto`;
    const cuerpo = { stock: 0, estado: "activo", productoId: escenario.producto.id,
      talleId: talle.id, colorId: escenario.color.id };
    const enviar = (ruta, method, datos) => fetch(`${base}${ruta}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(datos ? { body: JSON.stringify(datos) } : {}),
    });
    assert.equal((await enviar("", "POST", { ...cuerpo, stock: 1 })).status, 400);
    const alta = await enviar("", "POST", cuerpo);
    assert.equal(alta.status, 200);
    const variante = await alta.json();
    assert.equal(variante.stock, 0);
    assert.equal((await db.estadoCorteVariante.findUnique({ where: {
      varianteId: variante.id,
    } })).estado, "conciliado");
    assert.equal((await enviar(`/${variante.id}`, "PUT", { ...cuerpo, stock: 1 })).status, 409);
    const positivo = await ajustarInventario({ varianteId: variante.id, tipo: "positivo",
      cantidad: 2, costoUnitario: "0.00", motivo: "Ingreso de prueba", actorUsuarioId: actor });
    assert.equal(positivo.fisico, 2);
    assert.equal((await enviar(`/${variante.id}`, "DELETE")).status, 409);
    await assert.rejects(ajustarInventario({ varianteId: variante.id, tipo: "negativo",
      cantidad: 3, motivo: "Exceso", actorUsuarioId: actor }),
    (error) => error.codigo === "STOCK_COMPROMETIDO");
    const negativo = await ajustarInventario({ varianteId: variante.id, tipo: "negativo",
      cantidad: 2, motivo: "Retiro de prueba", actorUsuarioId: actor });
    assert.equal(negativo.fisico, 0);
    assert.equal((await enviar(`/${variante.id}`, "DELETE")).status, 200);
    assert.equal(await db.movimientoInventario.count({ where: { varianteId: variante.id } }), 2);
  } finally {
    await new Promise((resolve, reject) => servidor.close((error) => error ? reject(error) : resolve()));
    if (!secretoPrevio) delete process.env.JWT_SECRET;
  }
});
