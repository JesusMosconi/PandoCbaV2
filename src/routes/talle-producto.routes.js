import  {Router} from 'express';
import  prisma from "../db.js";

const router = Router();

//GET
router.get('/talle-producto', async (req, res) => {
  const talleProducto = await prisma.talleProducto.findMany()
  res.json(talleProducto)
})

//POST

router.post('/talle-producto', async (req, res) => {
  const talleProducto = await prisma.talleProducto.create({
    data: req.body
  });
  res.json(talleProducto);
});

//PUT

router.put('/talle-producto/:id', async (req, res) => {
    const EditarTalleProducto = await prisma.talleProducto.update({
      where: {
        id: parseInt(req.params.id)
      },
      data: req.body
    });

    if (!EditarTalleProducto) {
      return res.status(404).json({ message: "TalleProducto no encontrado" });
    }

    res.json(EditarTalleProducto);
  });


  export default router;