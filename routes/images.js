const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Image = require('../models/Image');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

/* =========================
   CLOUDINARY CONFIG
========================= */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/* =========================
   MULTER CONFIG (MEMORY)
========================= */
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const extname = allowedTypes.test(file.originalname.toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed'));
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter,
});

/* =========================
   CLOUDINARY UPLOAD HELPER
========================= */
const uploadToCloudinary = (buffer) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'art-showcase',
        resource_type: 'image',
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    stream.end(buffer);
  });
};

/* =========================
   GET RANDOM IMAGES
========================= */
router.get('/random', async (req, res) => {
  try {
    const count = parseInt(req.query.count) || 20;

    const images = await Image.aggregate([
      { $sample: { size: count } },
      {
        $lookup: {
          from: 'users',
          localField: 'artist',
          foreignField: '_id',
          as: 'artistInfo',
        },
      },
      { $unwind: '$artistInfo' },
      {
        $project: {
          title: 1,
          description: 1,
          imageUrl: 1,
          artistUsername: 1,
          artistProfileImage: '$artistInfo.profileImage',
          likesCount: 1,
          views: 1,
          createdAt: 1,
          category: 1,
        },
      },
    ]);

    res.json(images);
  } catch (error) {
    console.error('Error fetching random images:', error);
    res.status(500).json({ error: 'Failed to fetch images' });
  }
});

/* =========================
   UPLOAD IMAGE
========================= */
router.post('/upload', auth, upload.single('image'), async (req, res) => {
  try {
    const { title, description, tags, category } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const result = await uploadToCloudinary(req.file.buffer);

    const image = new Image({
      title,
      description,
      imageUrl: result.secure_url,
      cloudinaryId: result.public_id,
      artist: req.userId,
      artistUsername: req.user.username,
      tags: tags ? tags.split(',').map(tag => tag.trim()) : [],
      category: category || 'other',
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
    });

    await image.save();

    res.status(201).json(image);
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================
   GET USER IMAGES
========================= */
router.get('/user/:username', async (req, res) => {
  try {
    const images = await Image.find({ artistUsername: req.params.username })
      .sort({ createdAt: -1 })
      .populate('artist', 'username profileImage');

    res.json(images);
  } catch (error) {
    console.error('Error fetching user images:', error);
    res.status(500).json({ error: 'Failed to fetch user images' });
  }
});

/* =========================
   GET SINGLE IMAGE
========================= */
router.get('/:id', async (req, res) => {
  try {
    const image = await Image.findById(req.params.id)
      .populate('artist', 'username profileImage bio');

    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    image.views += 1;
    await image.save();

    res.json(image);
  } catch (error) {
    console.error('Error fetching image:', error);
    res.status(500).json({ error: 'Failed to fetch image' });
  }
});

/* =========================
   DELETE IMAGE
========================= */
router.delete('/:id', auth, async (req, res) => {
  try {
    const image = await Image.findById(req.params.id);

    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    if (image.artist.toString() !== req.userId.toString()) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await cloudinary.uploader.destroy(image.cloudinaryId);
    await image.deleteOne();

    res.json({ success: true, message: 'Image deleted successfully' });
  } catch (error) {
    console.error('Error deleting image:', error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================
   PAGINATED IMAGES
========================= */
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [images, total] = await Promise.all([
      Image.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('artist', 'username profileImage'),
      Image.countDocuments(),
    ]);

    res.json({
      images,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('Error fetching images:', error);
    res.status(500).json({ error: 'Failed to fetch images' });
  }
});

/* =========================
   LIKE IMAGE
========================= */
router.post('/:id/like', auth, async (req, res) => {
  try {
    const image = await Image.findById(req.params.id);

    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    if (image.likes.includes(req.userId)) {
      return res.status(400).json({ error: 'Already liked' });
    }

    image.likes.push(req.userId);
    image.likesCount = image.likes.length;
    await image.save();

    res.json({ message: 'Image liked', likesCount: image.likesCount });
  } catch (error) {
    console.error('Like error:', error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================
   UNLIKE IMAGE
========================= */
router.delete('/:id/like', auth, async (req, res) => {
  try {
    const image = await Image.findById(req.params.id);

    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    image.likes = image.likes.filter(
      like => like.toString() !== req.userId.toString()
    );
    image.likesCount = image.likes.length;

    await image.save();

    res.json({ message: 'Image unliked', likesCount: image.likesCount });
  } catch (error) {
    console.error('Unlike error:', error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================
   CHECK IF LIKED
========================= */
router.get('/:id/liked', auth, async (req, res) => {
  try {
    const image = await Image.findById(req.params.id);

    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    const liked = image.likes.includes(req.userId);
    res.json({ liked });
  } catch (error) {
    console.error('Check liked error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
