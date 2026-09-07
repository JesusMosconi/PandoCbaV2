import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import colorRoutes from "./routes/color.routes.js";
import talleRoutes from "./routes/talle.routes.js";
import categoriaRoutes from "./routes/categorias.routes.js";
import coleccionRoutes from "./routes/colecciones.routes.js";
import productosRoutes from "./routes/productos.routes.js";
import talleProductoRoutes from "./routes/talle-producto.routes.js";
import imgProductoRoutes from "./routes/img-producto.routes.js";
import catalogoInicioRoutes from "./routes/catalogo-inicio.routes.js";
import contenidoInicioRoutes from "./routes/contenido-inicio.routes.js";
import imagenesNosotrosRoutes from "./routes/imagenes-nosotros.routes.js";
import suscripcionRoutes from "./routes/suscripcion.routes.js";
import usuariosRoutes from "./routes/usuarios.routes.js";
import carritoRoutes from "./routes/carrito.routes.js";

const app = express();

if (!process.env.JWT_SECRET) {
  console.error("Falta JWT_SECRET en el archivo .env");
  process.exit(1);
}

app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:3001" }));
app.use(express.json());
app.use("/api", colorRoutes);
app.use("/api", talleRoutes);
app.use("/api", categoriaRoutes);
app.use("/api", coleccionRoutes);
app.use("/api", productosRoutes);
app.use("/api", talleProductoRoutes);
app.use("/api", imgProductoRoutes);
app.use("/api", catalogoInicioRoutes);
app.use("/api", contenidoInicioRoutes);
app.use("/api", imagenesNosotrosRoutes);
app.use("/api", suscripcionRoutes);
app.use("/api", usuariosRoutes);
app.use("/api", carritoRoutes);

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError || error?.message?.includes("no permitido")) {
    return res.status(400).json({ message: error.message });
  }

  if (error.type === "entity.parse.failed" || error instanceof SyntaxError) {
    return res.status(400).json({ message: "Body inválido. Envía un JSON válido." });
  }

  console.error(error);
  return res.status(500).json({ message: "Error interno del servidor" });
});

const port = process.env.PORT || 3000;
app.listen(port);
console.log("Server running on port", port);
