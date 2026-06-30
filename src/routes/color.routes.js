import  {Router} from 'express';
import  prisma from "../db.js";

const router = Router();

// GET
router.get('/colors', async (req, res) => {
  const colors = await prisma.color.findMany()
  res.json(colors)
})

//GET por ID
router.get('/colors/:id', async (req, res) => {
  const colorPorId = await prisma.color.findFirst({
    where: {
      id: parseInt(req.params.id),
    },
  });

  if (!colorPorId) {
    return res.status(404).json({ message: "Color no encontrado" });
  }

  res.json(colorPorId);
});

//Post
router.post("/colors", async (req, res) => {
  const NuevoColor = await prisma.color.create({
    data: req.body,
  });
  res.json({ message: "Color creado", color: NuevoColor });
});

//Delete
router.delete("/colors/:id", async (req, res) => {
  const EliminarColor = await prisma.color.delete({
    where: {
      id: parseInt(req.params.id),
    },
  });

  if (!EliminarColor) {
    return res.status(404).json({ message: "Color no encontrado" });
  }

  res.json(EliminarColor);
});

//Put
router.put("/colors/:id", async (req, res) => {
  const EditarColor = await prisma.color.update({
    where: {
      id: parseInt(req.params.id)},
      
          data: req.body,
    
  });
  if (!EditarColor) {
    return res.status(404).json({ message: "Color no encontrado" });
  }

  res.json(EditarColor);
});

export default router;