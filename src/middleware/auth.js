import jwt from "jsonwebtoken";
import prisma from "../db.js";

export const verificarToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "Token requerido" });
  }

  try {
    req.usuario = jwt.verify(token, process.env.JWT_SECRET);
    const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario.id }, select: { activo: true } });
    if (!usuario?.activo) return res.status(401).json({ message: "Usuario inactivo" });
    next();
  } catch {
    return res.status(401).json({ message: "Token inválido o expirado" });
  }
};
