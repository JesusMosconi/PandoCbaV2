import { Router } from 'express';
import prisma from "../db.js";

const router = Router();

// GET /productos
// Query params soportados:
//   categoriaId  -> filtra por categoría (número)
//   web          -> 'true' para traer solo visibles en storefront
//   talle        -> nombre de talle, ej "L" (filtra productos con stock > 0 en ese talle)
//   orden        -> 'recientes' | 'precio_asc' | 'precio_desc'
//   page         -> número de página (default 1)
//   pageSize     -> tamaño de página (default 6)
router.get('/productos', async (req, res) => {
  const {
    categoriaId,
    web,
    talle,
    orden = 'recientes',
    page = '1',
    pageSize = '6',
  } = req.query;

  const pageNum = Math.max(parseInt(page) || 1, 1);
  const pageSizeNum = Math.max(parseInt(pageSize) || 6, 1);

  const where = {
    activo: true,
    categoriaId: categoriaId ? parseInt(categoriaId) : undefined,
    web: web === 'true' ? true : undefined,
    talles: talle
      ? {
          some: {
            stock: { gt: 0 },
            talle: { nombre: talle },
          },
        }
      : undefined,
  };

  const orderBy =
    orden === 'precio_asc'
      ? { precio: 'asc' }
      : orden === 'precio_desc'
      ? { precio: 'desc' }
      : { id: 'desc' }; // "recientes" -> más nuevo primero

  const [productos, total] = await Promise.all([
    prisma.producto.findMany({
      where,
      include: {
        categoria: true,
        coleccion: true,
        imagenes: { orderBy: { id: 'asc' }, take: 1 },
        talles: {
          where: { stock: { gt: 0 } },
          include: { talle: true, color: true },
        },
      },
      orderBy,
      skip: (pageNum - 1) * pageSizeNum,
      take: pageSizeNum,
    }),
    prisma.producto.count({ where }),
  ]);

  res.json({
    data: productos,
    total,
    page: pageNum,
    pageSize: pageSizeNum,
    hasMore: pageNum * pageSizeNum < total,
  });
});

//get por ID
router.get('/productos/:id', async (req, res) => {
  const productoPorId = await prisma.producto.findFirst({
    where: { id: parseInt(req.params.id) },
    include: {
      categoria: true,
      coleccion: true,
      imagenes: { orderBy: { orden: 'asc' } },
      talles: { include: { talle: true, color: true } },
    },
  });

  if (!productoPorId) {
    return res.status(404).json({ message: "Producto no encontrado" });
  }
  res.json(productoPorId);
});

//post

router.post('/productos', async (req, res) => {
  const NuevoProducto = await prisma.producto.create({
    data: req.body,
  });
  res.json(NuevoProducto);
});

//put

router.put('/productos/:id', async (req, res) => {
  const EditarProducto = await prisma.producto.update({
    where: {
      id: parseInt(req.params.id),
    },
    data: req.body,
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
      id: parseInt(req.params.id),
    },
    data: { activo: false },
  });
  res.json({ message: "Producto desactivado" });
});

export default router;
