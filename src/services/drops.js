import prisma from "../db.js";
import { disponibilidadVariantes } from "./inventario.js";
import { whereProductoVisible } from "../utils/visibilidad-producto.js";

export function ordenarLanzados(a, b) {
  return new Date(b.fechaLanzamiento).getTime() - new Date(a.fechaLanzamiento).getTime() || b.id - a.id;
}

export function dropPreparado(drop) {
  return Boolean(drop.imagenUrl && drop.tituloInicio && drop.textoBotonInicio);
}

export function estadoDrop(drop, ahora, disponibles = 0) {
  if (!drop.activo) return { estado: "retirado", motivoEstado: "Retirado" };
  if (drop.fechaCierre) return { estado: "finalizado", motivoEstado: drop.motivoCierre === "manual" ? "Cierre manual" : "Reemplazado" };
  if (drop.fechaFinalizacion && drop.fechaFinalizacion <= ahora) return { estado: "finalizado", motivoEstado: "Fecha de finalización alcanzada" };
  if (!drop.fechaLanzamiento) return { estado: "borrador", motivoEstado: "Sin fecha de lanzamiento" };
  if (drop.fechaLanzamiento > ahora) return { estado: "futuro", motivoEstado: disponibles ? null : "Sin productos disponibles todavía" };
  if (!disponibles) return { estado: "pendiente", motivoEstado: "Sin productos públicos disponibles" };
  if (!drop.fechaActivacion) return { estado: "pendiente", motivoEstado: "Esperando activación" };
  return { estado: "activo", motivoEstado: null };
}

export async function cantidadesDisponibles(tx, coleccionIds, ahora = new Date()) {
  if (!coleccionIds.length) return new Map();
  const productos = await tx.producto.findMany({
    where: { ...whereProductoVisible, coleccionId: { in: coleccionIds } },
    select: { id: true, coleccionId: true, talles: { where: { estado: { not: "inactivo" } }, select: { id: true, stock: true } } },
  });
  const variantes = productos.flatMap((producto) => producto.talles);
  const saldos = await disponibilidadVariantes(tx, variantes, ahora);
  const cantidades = new Map(coleccionIds.map((id) => [id, 0]));
  for (const producto of productos) {
    if (producto.talles.some((variante) => (saldos.get(variante.id) ?? 0) > 0)) {
      cantidades.set(producto.coleccionId, (cantidades.get(producto.coleccionId) ?? 0) + 1);
    }
  }
  return cantidades;
}

export function seleccionarDrops(drops, cantidades, ahora) {
  const lanzados = drops.filter((drop) => drop.activo && dropPreparado(drop) && drop.fechaLanzamiento && drop.fechaLanzamiento <= ahora)
    .sort(ordenarLanzados);
  const activos = lanzados.filter((drop) => estadoDrop(drop, ahora, cantidades.get(drop.id)).estado === "activo");
  const activo = activos[0] ?? null;
  const futuro = drops.filter((drop) => drop.activo && dropPreparado(drop) && drop.fechaLanzamiento && drop.fechaLanzamiento > ahora && !drop.fechaCierre)
    .sort((a, b) => new Date(a.fechaLanzamiento).getTime() - new Date(b.fechaLanzamiento).getTime() || b.id - a.id)[0] ?? null;
  const historicoDisponible = lanzados.find((drop) => (cantidades.get(drop.id) ?? 0) > 0);
  const destacado = activo ?? historicoDisponible ?? lanzados[0] ?? null;
  return { activo, futuro, destacado, agotado: destacado ? !(cantidades.get(destacado.id) ?? 0) : false, lanzados };
}

export async function contextoDrops(tx = prisma, ahora = new Date()) {
  const drops = await tx.coleccion.findMany();
  const cantidades = await cantidadesDisponibles(tx, drops.map((drop) => drop.id), ahora);
  return { drops, cantidades, ahora, ...seleccionarDrops(drops, cantidades, ahora) };
}

export function decidirActivacion(drops, cantidades, ahora) {
  const candidatos = drops.filter((drop) => drop.activo && dropPreparado(drop) && drop.fechaLanzamiento && drop.fechaLanzamiento <= ahora
    && (!drop.fechaFinalizacion || drop.fechaFinalizacion > ahora) && !drop.fechaCierre
    && (cantidades.get(drop.id) ?? 0) > 0).sort(ordenarLanzados);
  const ultimoActivado = drops.filter((drop) => drop.fechaActivacion).sort(ordenarLanzados)[0];
  const vigentes = drops.filter((drop) => drop.activo && drop.fechaActivacion && !drop.fechaCierre
    && (!drop.fechaFinalizacion || drop.fechaFinalizacion > ahora));
  const candidato = candidatos[0];
  if (!candidato || (ultimoActivado && ordenarLanzados(ultimoActivado, candidato) <= 0)) return null;
  return { candidato, vigentes: vigentes.filter((drop) => drop.id !== candidato.id) };
}

export async function activarDrops() {
  return prisma.$transaction(async (tx) => {
    // El bloqueo transaccional serializa el trabajo entre instancias de la API.
    // PrismaPg no puede decodificar columnas PostgreSQL de tipo void.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(5005, 1)::text AS bloqueo`;
    const [{ ahora }] = await tx.$queryRaw`SELECT clock_timestamp() AS ahora`;
    const { drops, cantidades } = await contextoDrops(tx, ahora);
    const decision = decidirActivacion(drops, cantidades, ahora);
    if (!decision) return null;
    const { candidato, vigentes } = decision;
    if (vigentes.length) await tx.coleccion.updateMany({ where: { id: { in: vigentes.map((drop) => drop.id) } },
      data: { fechaCierre: ahora, motivoCierre: "reemplazo" } });
    if (!candidato.fechaActivacion) await tx.coleccion.update({ where: { id: candidato.id }, data: { fechaActivacion: ahora } });
    return candidato.id;
  });
}
