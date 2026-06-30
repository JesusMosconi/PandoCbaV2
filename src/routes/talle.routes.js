import { Router } from "express";
import prisma from "../db.js";

const router = Router();
// GET
router.get("/talles", async (req, res) => {
  const talles = await prisma.talle.findMany();
  res.json(talles);
});
//GET por ID
router.get("/talles/:id", async (req, res) => {
    const tallePorId = await prisma.talle.findFirst({
      where: {
        id: parseInt(req.params.id),
      },
    });

    if (!tallePorId) {
      return res.status(404).json({ message: "Talle no encontrado" });
    }

    res.json(tallePorId);
  });

  //POST
router.post("/talles", async (req, res) => {
  const NuevoTalle = await prisma.talle.create({
    data: req.body,
  });
  res.json({ message: "Talle creado", talle: NuevoTalle });
});

//Delete
router.delete("/talles/:id", async (req, res) => {
    const EliminarTalle = await prisma.talle.delete({
      where: {
        id: parseInt(req.params.id),
      },
    });

    if (!EliminarTalle) {
      return res.status(404).json({ message: "Talle no encontrado" });
    }

    res.json(EliminarTalle);
  });


  //PUT
  router.put("/talles/:id", async (req, res) => {
    const EditarTalle = await prisma.talle.update({
      where: {
        id: parseInt(req.params.id)},
        
            data: req.body,
      
    });
    if (!EditarTalle) {
      return res.status(404).json({ message: "Talle no encontrado" });
    }

    res.json(EditarTalle);
  });

export default router;
