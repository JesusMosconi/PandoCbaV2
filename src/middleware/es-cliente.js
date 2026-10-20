import prisma from "../db.js";

export async function esCliente(req, res, next) {
  try {
    const usuario = await prisma.usuario.findUnique({
      where: { id: req.usuario?.id },
      select: { rol: true, activo: true },
    });
    if (!usuario?.activo || usuario.rol !== "cliente") {
      return res.status(403).json({ message: "Esta acción requiere una cuenta de cliente", codigo: "ROL_NO_AUTORIZADO" });
    }
    next();
  } catch (error) {
    next(error);
  }
}
