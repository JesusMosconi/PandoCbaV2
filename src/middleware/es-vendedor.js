import prisma from "../db.js";

/** Punto de venta del local: admite al vendedor y al administrador, con rol y estado vigentes en la base. */
export async function esVendedor(req, res, next) {
  try {
    const usuario = await prisma.usuario.findUnique({
      where: { id: req.usuario?.id },
      select: { rol: true, activo: true },
    });
    if (!usuario?.activo || !["vendedor", "admin"].includes(usuario.rol)) {
      return res.status(403).json({ message: "Esta acción requiere una cuenta de vendedor", codigo: "ROL_NO_AUTORIZADO" });
    }
    next();
  } catch (error) {
    next(error);
  }
}
