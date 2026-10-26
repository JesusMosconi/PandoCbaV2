import prisma from "../db.js";

export class ErrorSuscripcionActiva extends Error {
  constructor() {
    super("Ya existe una suscripción con este email");
    this.name = "ErrorSuscripcionActiva";
  }
}

/**
 * Crea o reactiva la suscripción de un correo ya normalizado.
 * Lanza ErrorSuscripcionActiva si ya está activa o si otra solicitud ganó la carrera.
 */
export async function suscribir(email) {
  const existente = await prisma.suscripcion.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    orderBy: { id: "asc" },
  });

  if (existente?.activo) throw new ErrorSuscripcionActiva();

  if (existente) {
    const { count } = await prisma.suscripcion.updateMany({
      where: { id: existente.id, activo: false },
      data: { activo: true, fechaSuscripcion: new Date() },
    });
    if (count === 0) throw new ErrorSuscripcionActiva();
    const suscripcion = await prisma.suscripcion.findUnique({ where: { id: existente.id } });
    return { suscripcion, estado: "reactivada" };
  }

  try {
    const suscripcion = await prisma.suscripcion.create({ data: { email } });
    return { suscripcion, estado: "creada" };
  } catch (error) {
    if (error.code === "P2002") throw new ErrorSuscripcionActiva();
    throw error;
  }
}

/** Baja lógica e idempotente: no falla si la suscripción ya estaba inactiva o no existe. */
export async function darDeBaja(id) {
  await prisma.suscripcion.updateMany({ where: { id }, data: { activo: false } });
}
