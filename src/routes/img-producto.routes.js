import {Router} from 'express';
import prisma from "../db.js";

const router = Router();

//POST

router.post('/img-producto', async (req, res) => {
  const imgProducto = await prisma.imgProducto.create({
    data: req.body
  });
  res.json(imgProducto);
});

//DELETE

router.delete('/img-producto/:id', async (req, res) => {
    const EliminarImgProducto = await prisma.imgProducto.delete({
      where: {
        id: parseInt(req.params.id)
      }
    });

    if (!EliminarImgProducto) {
      return res.status(404).json({ message: "ImgProducto no encontrado" });
    }

    res.json({ message: "ImgProducto eliminado" });
  });



  export default router;