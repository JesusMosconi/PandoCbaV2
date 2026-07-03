import  {Router} from 'express';
import  prisma from "../db.js";

const router = Router();

// GET
router.get('/productos', async (req, res) => {
  const { categoriaId, web} = req.query;

  const productos = await prisma.producto.findMany({
    where: {
      activo: true,
      categoriaId: categoriaId ? parseInt(categoriaId) : undefined,
      web: web === 'true' ? true : undefined
    },
    include: {
      categoria: true,
      coleccion: true,
      imagenes: {orderBy: {id: 'asc'}, take: 1},
      talles: {
        where: {stock: {gt: 0}},
        include: { talle:true, color:true }
      }
    }
  })
  res.json(productos)
})

//get por ID
router.get('/productos/:id', async (req, res) => {
  const productoPorId = await prisma.producto.findFirst({
    where: {id: parseInt(req.params.id)},
    include: {
      categoria: true,
      coleccion: true,
      imagenes: {orderBy: {orden: 'asc'}},
      talles: { include: { talle:true, color:true } }
  }
})

  if (!productoPorId) {
    return res.status(404).json({ message: "Producto no encontrado" });
  }
  res.json(productoPorId)
})

//post

router.post('/productos', async (req, res) => {
  const NuevoProducto = await prisma.producto.create({
    data: req.body
  })
  res.json(NuevoProducto)
})

//put

router.put('/productos/:id', async (req, res) => {
  const EditarProducto = await prisma.producto.update({
    where: {
      id: parseInt(req.params.id)
    },
    data: req.body
  });
  if (!EditarProducto) {
    return res.status(404).json({ message: "Producto no encontrado" });
  }

  res.json(EditarProducto);
});


//SOFT Delete

router.delete('/productos/:id', async (req, res) => {
  //soft delete: cambiar el campo activo a false
  await prisma.producto.update({
    where: {
      id: parseInt(req.params.id)},
      data: { activo: false }
  }); 
  res.json({ message: "Producto desactivado" });
});

export default router;