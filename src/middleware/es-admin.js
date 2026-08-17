import prisma from "../db.js";

export const esAdmin = async (req, res, next) => {
  try {
    const usuario = await prisma.usuario.findUnique({
      where: { id: req.usuario?.id },
      select: { rol: true },
    });

    if (usuario?.rol !== "admin") {
      return res.status(403).json({ message: "Sin permisos" });
    }

    next();
  } catch (error) {
    next(error);
  }
};
