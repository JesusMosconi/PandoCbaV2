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

const rolesValidos = ["cliente", "admin"];

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
    if (!usuario || !usuario.activo || !(await bcrypt.compare(password, usuario.password))) {
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
    const pagina = Math.max(Number(req.query.pagina) || 1, 1);
    const limite = Math.min(Math.max(Number(req.query.limite) || 20, 1), 100);
    const busqueda = String(req.query.busqueda || "").trim();
    const rol = req.query.rol ? String(req.query.rol) : undefined;
    const activo = req.query.activo === undefined ? undefined : req.query.activo === "true";
    const camposOrdenables = { id: "id", nombre: "nombre", email: "email", fechaCreado: "fechaCreado", rol: "rol" };
    const orden = camposOrdenables[String(req.query.orden)] || "fechaCreado";
    const direccion = req.query.direccion === "asc" ? "asc" : "desc";

    if (rol && !rolesValidos.includes(rol)) return res.status(400).json({ message: "Rol inválido" });

    const where = {
      ...(busqueda ? { OR: [
        { nombre: { contains: busqueda, mode: "insensitive" } },
        { apellido: { contains: busqueda, mode: "insensitive" } },
        { email: { contains: busqueda, mode: "insensitive" } },
      ] } : {}),
      ...(rol ? { rol } : {}),
      ...(activo !== undefined ? { activo } : {}),
    };
    const [usuarios, total] = await prisma.$transaction([
      prisma.usuario.findMany({
        where,
        select: { id: true, nombre: true, apellido: true, email: true, telefono: true, fechaCreado: true, rol: true, activo: true, _count: { select: { ordenes: true } } },
        orderBy: { [orden]: direccion },
        skip: (pagina - 1) * limite,
        take: limite,
      }),
      prisma.usuario.count({ where }),
    ]);
    return res.json({ usuarios, total, pagina, limite, paginas: Math.ceil(total / limite) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error al obtener usuarios" });
  }
});

router.get("/admin/usuarios/:id", verificarToken, esAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: "Id de usuario inválido" });
    const usuario = await prisma.usuario.findUnique({
      where: { id },
      select: { id: true, nombre: true, apellido: true, email: true, telefono: true, fechaCreado: true, rol: true, activo: true, _count: { select: { ordenes: true, favoritos: true } } },
    });
    if (!usuario) return res.status(404).json({ message: "Usuario no encontrado" });
    return res.json(usuario);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error al obtener usuario" });
  }
});

router.patch("/admin/usuarios/:id/estado", verificarToken, esAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: "Id de usuario inválido" });
    if (typeof req.body.activo !== "boolean") return res.status(400).json({ message: "El estado debe ser booleano" });
    if (id === req.usuario.id && !req.body.activo) return res.status(400).json({ message: "No podés desactivar tu propio usuario" });
    const usuario = await prisma.usuario.update({ where: { id }, data: { activo: req.body.activo }, select: { id: true, nombre: true, apellido: true, email: true, telefono: true, fechaCreado: true, rol: true, activo: true } });
    return res.json(usuario);
  } catch (error) {
    if (error.code === "P2025") return res.status(404).json({ message: "Usuario no encontrado" });
    console.error(error);
    return res.status(500).json({ message: "Error al actualizar estado" });
  }
});

router.put("/admin/usuarios/:id/rol", verificarToken, esAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rol } = req.body;
    if (!Number.isInteger(id)) return res.status(400).json({ message: "Id de usuario inválido" });
    if (!rolesValidos.includes(rol)) return res.status(400).json({ message: "Rol inválido" });
    if (id === req.usuario.id && rol !== "admin") return res.status(400).json({ message: "No podés quitarte el rol administrador" });
    const usuario = await prisma.usuario.update({ where: { id }, data: { rol } });
    return res.json(sanitizarUsuario(usuario));
  } catch (error) {
    if (error.code === "P2025") return res.status(404).json({ message: "Usuario no encontrado" });
    console.error(error);
    return res.status(500).json({ message: "Error al actualizar rol" });
  }
});

export default router;
