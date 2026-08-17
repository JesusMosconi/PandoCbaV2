import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../db.js";
import { verificarToken } from "../middleware/auth.js";
import { esAdmin } from "../middleware/es-admin.js";

const router = Router();

const sanitizarUsuario = (usuario) => {
  const { password, ...resto } = usuario;
  return resto;
};

const generarToken = (usuario) =>
  jwt.sign(
    { id: usuario.id, rol: usuario.rol, email: usuario.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );

router.post("/usuarios/registro", async (req, res) => {
  try {
    const { nombre, apellido, email, password, telefono } = req.body;
    if (!nombre || !apellido || !email || !password) {
      return res.status(400).json({ message: "nombre, apellido, email y password son requeridos" });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "La contraseña debe tener al menos 6 caracteres" });
    }
    const existente = await prisma.usuario.findUnique({ where: { email } });
    if (existente) {
      return res.status(409).json({ message: "El email ya está registrado" });
    }
    const usuario = await prisma.usuario.create({
      data: { nombre, apellido, email, password: await bcrypt.hash(password, 10), telefono },
    });
    return res.status(201).json({ usuario: sanitizarUsuario(usuario), token: generarToken(usuario) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error al registrar usuario" });
  }
});

router.post("/usuarios/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "email y password son requeridos" });
    }
    const usuario = await prisma.usuario.findUnique({ where: { email } });
    if (!usuario || !(await bcrypt.compare(password, usuario.password))) {
      return res.status(401).json({ message: "Credenciales inválidas" });
    }
    return res.json({ usuario: sanitizarUsuario(usuario), token: generarToken(usuario) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error al iniciar sesión" });
  }
});

router.get("/usuarios/perfil", verificarToken, async (req, res) => {
  try {
    const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario.id } });
    if (!usuario) return res.status(404).json({ message: "Usuario no encontrado" });
    return res.json(sanitizarUsuario(usuario));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error al obtener perfil" });
  }
});

router.put("/usuarios/perfil", verificarToken, async (req, res) => {
  try {
    const { nombre, apellido, telefono } = req.body;
    const data = {};
    if (nombre !== undefined) data.nombre = nombre;
    if (apellido !== undefined) data.apellido = apellido;
    if (telefono !== undefined) data.telefono = telefono;
    const usuario = await prisma.usuario.update({ where: { id: req.usuario.id }, data });
    return res.json(sanitizarUsuario(usuario));
  } catch (error) {
    if (error.code === "P2025") return res.status(404).json({ message: "Usuario no encontrado" });
    console.error(error);
    return res.status(500).json({ message: "Error al actualizar perfil" });
  }
});

router.put("/usuarios/cambiar-password", verificarToken, async (req, res) => {
  try {
    const { passwordActual, passwordNuevo } = req.body;
    if (!passwordActual || !passwordNuevo) {
      return res.status(400).json({ message: "passwordActual y passwordNuevo son requeridos" });
    }
    if (passwordNuevo.length < 6) {
      return res.status(400).json({ message: "La nueva contraseña debe tener al menos 6 caracteres" });
    }
    const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario.id } });
    if (!usuario) return res.status(404).json({ message: "Usuario no encontrado" });
    if (!(await bcrypt.compare(passwordActual, usuario.password))) {
      return res.status(401).json({ message: "La contraseña actual es incorrecta" });
    }
    await prisma.usuario.update({ where: { id: req.usuario.id }, data: { password: await bcrypt.hash(passwordNuevo, 10) } });
    return res.json({ message: "Contraseña actualizada correctamente" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error al cambiar contraseña" });
  }
});

router.get("/admin/usuarios", verificarToken, esAdmin, async (req, res) => {
  try {
    const usuarios = await prisma.usuario.findMany({ orderBy: { id: "asc" } });
    return res.json(usuarios.map(sanitizarUsuario));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error al obtener usuarios" });
  }
});

router.put("/admin/usuarios/:id/rol", verificarToken, esAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rol } = req.body;
    if (!Number.isInteger(id)) return res.status(400).json({ message: "Id de usuario inválido" });
    if (!['cliente', 'admin'].includes(rol)) return res.status(400).json({ message: "Rol inválido" });
    const usuario = await prisma.usuario.update({ where: { id }, data: { rol } });
    return res.json(sanitizarUsuario(usuario));
  } catch (error) {
    if (error.code === "P2025") return res.status(404).json({ message: "Usuario no encontrado" });
    console.error(error);
    return res.status(500).json({ message: "Error al actualizar rol" });
  }
});

export default router;
