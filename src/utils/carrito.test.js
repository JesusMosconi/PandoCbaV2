import assert from "node:assert/strict";
import test from "node:test";
import { DURACION_CARRITO_MS, marcarCarritoActualizado, obtenerOCrearCarrito } from "./carrito.js";

function crearPrismaFalso(carrito, ahora) {
  const estado = {
    carrito,
    itemsEliminados: 0,
    siguienteId: (carrito?.id ?? 0) + 1,
  };

  const prisma = {
    carrito: {
      findFirst: async () => (estado.carrito?.estado === "activo" ? estado.carrito : null),
      create: async ({ data }) => {
        estado.carrito = { id: estado.siguienteId++, ...data, actualizado: ahora, items: [] };
        return estado.carrito;
      },
      update: async ({ where, data }) => {
        assert.equal(estado.carrito.id, where.id);
        Object.assign(estado.carrito, data, { actualizado: ahora });
        return estado.carrito;
      },
    },
    itemCarrito: {
      deleteMany: async ({ where }) => {
        assert.equal(estado.carrito.id, where.carritoId);
        estado.itemsEliminados += estado.carrito.items.length;
        estado.carrito.items = [];
      },
    },
    $transaction: async (operacion) => operacion(prisma),
    estado,
  };

  return prisma;
}

test("conserva el carrito antes de cumplir 24 horas", async () => {
  const ahora = new Date("2026-10-17T12:00:00.000Z");
  const carrito = {
    id: 1,
    estado: "activo",
    actualizado: new Date(ahora.getTime() - DURACION_CARRITO_MS + 1),
    items: [{ id: 1 }],
  };
  const prisma = crearPrismaFalso(carrito, ahora);

  const resultado = await obtenerOCrearCarrito(prisma, 7, ahora);

  assert.equal(resultado, carrito);
  assert.equal(prisma.estado.itemsEliminados, 0);
});

test("elimina los productos y crea un carrito vacío al cumplir 24 horas", async () => {
  const ahora = new Date("2026-10-17T12:00:00.000Z");
  const carrito = {
    id: 1,
    estado: "activo",
    actualizado: new Date(ahora.getTime() - DURACION_CARRITO_MS),
    items: [{ id: 1 }, { id: 2 }],
  };
  const prisma = crearPrismaFalso(carrito, ahora);

  const resultado = await obtenerOCrearCarrito(prisma, 7, ahora);

  assert.equal(carrito.estado, "expirado");
  assert.equal(prisma.estado.itemsEliminados, 2);
  assert.equal(resultado.id, 2);
  assert.equal(resultado.estado, "activo");
  assert.deepEqual(resultado.items, []);
});

test("renueva el vencimiento cuando cambia el carrito", async () => {
  const ahora = new Date("2026-10-17T12:00:00.000Z");
  const carrito = { id: 1, actualizado: new Date(0) };
  const prisma = crearPrismaFalso(carrito, ahora);

  await marcarCarritoActualizado(prisma, carrito.id, ahora);

  assert.equal(carrito.actualizado, ahora);
});
