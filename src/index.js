import 'dotenv/config'
import express from "express";
import colorRoutes from "./routes/color.routes.js";
import talleRoutes from "./routes/talle.routes.js";
import categoriaRoutes from "./routes/categorias.routes.js";
import coleccionRoutes from "./routes/colecciones.routes.js";
import productosRoutes from "./routes/productos.routes.js";
import talleProductoRoutes from "./routes/talle-producto.routes.js";
import imgProductoRoutes from "./routes/img-producto.routes.js";

const app = express();

app.use(express.json());
app.use("/api", colorRoutes);
app.use("/api", talleRoutes);
app.use("/api", categoriaRoutes);
app.use("/api", coleccionRoutes);
app.use("/api", productosRoutes);
app.use("/api", talleProductoRoutes);
app.use("/api", imgProductoRoutes);

app.listen(3000);
console.log("Server running on port", 3000);
