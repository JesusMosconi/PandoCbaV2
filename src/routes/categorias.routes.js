import  {Router} from 'express';
import  prisma from "../db.js";

const router = Router();

// GET
router.get('/categorias', async (req, res) => {
  const categorias = await prisma.categoria.findMany()
  res.json(categorias)
})

export default router;