import jwt from "jsonwebtoken";

export const verificarToken = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "Token requerido" });
  }

  try {
    req.usuario = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: "Token inválido o expirado" });
  }
};
