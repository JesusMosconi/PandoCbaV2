// Datos ficticios para revisar la UI local. Nunca ejecutarlo contra otra rama.
import bcrypt from "bcryptjs";
import prisma from "../src/db.js";
import { crearEscenario, exigirBasePrueba } from "../test/soporte/escenario.js";
exigirBasePrueba();
if (process.env.PANDO_TEST_BRANCH_ID !== "br-holy-flower-achmzkpy") throw new Error("Rama de tesis requerida");
try {
  const email = "cliente.pagos.tesis@example.invalid";
  if (await prisma.usuario.findUnique({ where: { email } })) {
    console.log("Las cuentas ficticias de revisión local ya existen.");
  } else {
    const escenario = await crearEscenario({ stock: 8, precio: "20000.01" });
    const password = await bcrypt.hash("Tesis-Pagos-006!", 10);
    await prisma.usuario.update({ where: { id: escenario.usuarios[0].id }, data: { email, password } });
    await prisma.usuario.create({ data: { nombre: "Admin", apellido: "Tesis", email: "admin.pagos.tesis@example.invalid",
      password, rol: "admin" } });
    await prisma.producto.update({ where: { id: escenario.producto.id }, data: { nombre: "Remera de demostración de pagos" } });
    await escenario.carrito(escenario.usuarios[0]);
    console.log(JSON.stringify({ cliente: email, administrador: "admin.pagos.tesis@example.invalid", productoId: escenario.producto.id,
      varianteId: escenario.variante.id, tipo: "datos ficticios exclusivos de tesis" }));
  }
} finally { await prisma.$disconnect(); }
