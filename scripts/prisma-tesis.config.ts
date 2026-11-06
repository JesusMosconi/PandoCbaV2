import { defineConfig } from "prisma/config";

// El entorno llega del proceso temporal. No cargar archivos .env.
export default defineConfig({
  schema: "../prisma/schema.prisma",
  migrations: { path: "../prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "postgresql://invalid/invalid" },
});
