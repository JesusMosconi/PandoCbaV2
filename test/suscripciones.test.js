import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import prisma from "../src/db.js";
import { darDeBaja, ErrorSuscripcionActiva, suscribir } from "../src/services/suscripciones.js";
import { exigirBasePrueba } from "./soporte/escenario.js";

// Requiere la base de prueba aislada; sin ella se omite en lugar de fallar.
const opciones = { skip: !process.env.PANDO_TEST_BRANCH_ID && "Base de prueba no configurada" };

function correoUnico() {
  return `suscripcion-${randomUUID().slice(0, 12)}@example.invalid`;
}

async function limpiar(correos) {
  await prisma.suscripcion.deleteMany({ where: { email: { in: correos, mode: "insensitive" } } });
}

test("crea, rechaza duplicados activos, da de baja y reactiva", opciones, async () => {
  exigirBasePrueba();
  const email = correoUnico();
  try {
    const creada = await suscribir(email);
    assert.equal(creada.estado, "creada");
    assert.equal(creada.suscripcion.activo, true);

    await assert.rejects(suscribir(email), ErrorSuscripcionActiva);

    await darDeBaja(creada.suscripcion.id);
    await darDeBaja(creada.suscripcion.id);
    const baja = await prisma.suscripcion.findUnique({ where: { id: creada.suscripcion.id } });
    assert.equal(baja.activo, false);

    const reactivada = await suscribir(email);
    assert.equal(reactivada.estado, "reactivada");
    assert.equal(reactivada.suscripcion.id, creada.suscripcion.id);
    assert.equal(reactivada.suscripcion.activo, true);
    assert.ok(reactivada.suscripcion.fechaSuscripcion > creada.suscripcion.fechaSuscripcion);
  } finally {
    await limpiar([email]);
  }
});

test("una fila anterior con mayúsculas cuenta como la misma suscripción", opciones, async () => {
  exigirBasePrueba();
  const email = correoUnico();
  const heredado = email.replace("suscripcion", "Suscripcion");
  try {
    const fila = await prisma.suscripcion.create({ data: { email: heredado, activo: false } });
    const resultado = await suscribir(email);
    assert.equal(resultado.estado, "reactivada");
    assert.equal(resultado.suscripcion.id, fila.id);
    assert.equal(await prisma.suscripcion.count({ where: { email: { equals: email, mode: "insensitive" } } }), 1);
  } finally {
    await limpiar([email]);
  }
});

test("dos reactivaciones simultáneas producen una sola", opciones, async () => {
  exigirBasePrueba();
  const email = correoUnico();
  try {
    await prisma.suscripcion.create({ data: { email, activo: false } });
    const resultados = await Promise.allSettled([suscribir(email), suscribir(email)]);
    const exitosas = resultados.filter(({ status }) => status === "fulfilled");
    const rechazadas = resultados.filter(({ status }) => status === "rejected");
    assert.equal(exitosas.length, 1);
    assert.equal(rechazadas.length, 1);
    assert.ok(rechazadas[0].reason instanceof ErrorSuscripcionActiva);
  } finally {
    await limpiar([email]);
  }
});

test("dar de baja un id inexistente no falla", opciones, async () => {
  exigirBasePrueba();
  await darDeBaja(2_000_000_000);
});
