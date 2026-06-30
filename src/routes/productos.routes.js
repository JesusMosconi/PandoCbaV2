import  {Router} from 'express';
import  prisma from "../db.js";

const router = Router();

// GET
router.get('/productos', async (req, res) => {
  const productos = await prisma.producto.findMany()
  res.json(productos)
})

//get por ID
router.get('/productos/:id', async (req, res) => {
  const productoPorId = await prisma.producto.findFirst({
    where: {
      id: parseInt(req.params.id)
    }
  })

  if (!productoPorId) {
    return res.status(404).json({ message: "Producto no encontrado" });
  }
  res.json(productoPorId)
})

export default router;