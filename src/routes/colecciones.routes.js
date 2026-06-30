import  {Router} from 'express';
import  prisma from "../db.js";

const router = Router();

// GET
router.get('/colecciones', async (req, res) => {
  const colecciones = await prisma.coleccion.findMany()
  res.json(colecciones)
})

export default router;