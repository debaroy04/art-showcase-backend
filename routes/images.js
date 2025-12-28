const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Image = require('../models/Image');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer for disk storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    // Create unique filename with timestamp and original extension
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

// File filter for images only
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);
  
  if (mimetype && extname) {
    return cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'));
  }
};

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: fileFilter
});

// Get random images for landing page
router.get('/random', async (req, res) => {
  try {
    const count = parseInt(req.query.count) || 20;
    const images = await Image.aggregate([
      { $sample: { size: count } },
      { $lookup: {
          from: 'users',
          localField: 'artist',
          foreignField: '_id',
          as: 'artistInfo'
        }
      },
      { $unwind: '$artistInfo' },
      { $project: {
          title: 1,
          description: 1,
          imageUrl: 1,
          artistUsername: 1,
          artistProfileImage: '$artistInfo.profileImage',
          likesCount: 1,
          views: 1,
          createdAt: 1,
          category: 1
        }
      }
    ]);
    
    // Ensure full URL for images
    const imagesWithFullUrl = images.map(image => ({
      ...image,
      imageUrl: `${req.protocol}://${req.get('host')}${image.imageUrl}`
    }));
    
    res.json(imagesWithFullUrl);
  } catch (error) {
    console.error('Error fetching random images:', error);
    res.status(500).json({ error: 'Failed to fetch images' });
  }
});

// Upload image
router.post('/upload', auth, upload.single('image'), async (req, res) => {
  try {
    const { title, description, tags, category } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    // Create relative path for database storage
    const imageUrl = `/uploads/${req.file.filename}`;
    
    // Create image document
    const image = new Image({
      title,
      description,
      imageUrl: imageUrl,
      filename: req.file.filename,
      artist: req.userId,
      artistUsername: req.user.username,
      tags: tags ? tags.split(',').map(tag => tag.trim()) : [],
      category: category || 'other',
      fileSize: req.file.size,
      mimeType: req.file.mimetype
    });

    await image.save();

    // Return image with full URL
    const imageWithFullUrl = {
      ...image.toObject(),
      imageUrl: `${req.protocol}://${req.get('host')}${imageUrl}`
    };

    res.status(201).json(imageWithFullUrl);
  } catch (error) {
    console.error('Upload error:', error);
    
    // Clean up uploaded file if there was an error
    if (req.file && req.file.path) {
      fs.unlink(req.file.path, (err) => {
        if (err) console.error('Error deleting file:', err);
      });
    }
    
    res.status(500).json({ error: error.message });
  }
});

// Get user's images
router.get('/user/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const images = await Image.find({ artistUsername: username })
      .sort({ createdAt: -1 })
      .populate('artist', 'username profileImage');
    
    // Ensure full URLs for images
    const imagesWithFullUrl = images.map(image => ({
      ...image.toObject(),
      imageUrl: `${req.protocol}://${req.get('host')}${image.imageUrl}`
    }));
    
    res.json(imagesWithFullUrl);
  } catch (error) {
    console.error('Error fetching user images:', error);
    res.status(500).json({ error: 'Failed to fetch user images' });
  }
});

// Get single image by ID
router.get('/:id', async (req, res) => {
  try {
    const image = await Image.findById(req.params.id)
      .populate('artist', 'username profileImage bio');
    
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    // Increment view count
    image.views += 1;
    await image.save();
    
    // Ensure full URL
    const imageWithFullUrl = {
      ...image.toObject(),
      imageUrl: `${req.protocol}://${req.get('host')}${image.imageUrl}`
    };
    
    res.json(imageWithFullUrl);
  } catch (error) {
    console.error('Error fetching image:', error);
    res.status(500).json({ error: 'Failed to fetch image' });
  }
});

// Delete image
router.delete('/:id', auth, async (req, res) => {
  try {
    console.log('Delete request for image ID:', req.params.id);
    console.log('User ID making request:', req.userId);
    
    const image = await Image.findById(req.params.id);
    
    if (!image) {
      console.log('Image not found');
      return res.status(404).json({ error: 'Image not found' });
    }

    // Check if user owns the image
    console.log('Image artist ID:', image.artist.toString());
    console.log('Request user ID:', req.userId.toString());
    
    if (image.artist.toString() !== req.userId.toString()) {
      console.log('User not authorized to delete this image');
      return res.status(403).json({ error: 'Not authorized to delete this image' });
    }

    // Delete file from filesystem
    const filePath = path.join(__dirname, '..', image.imageUrl);
    console.log('Deleting file from:', filePath);
    
    fs.unlink(filePath, (err) => {
      if (err && err.code !== 'ENOENT') {
        console.error('Error deleting file:', err);
      } else {
        console.log('File deleted successfully');
      }
    });

    // Delete from database
    await image.deleteOne();
    console.log('Image deleted from database');

    res.json({ 
      success: true,
      message: 'Image deleted successfully' 
    });
    
  } catch (error) {
    console.error('Error deleting image:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Get all images with pagination
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
      Image.countDocuments()
    ]);
    
    // Ensure full URLs
    const imagesWithFullUrl = images.map(image => ({
      ...image.toObject(),
      imageUrl: `${req.protocol}://${req.get('host')}${image.imageUrl}`
    }));
    
    res.json({
      images: imagesWithFullUrl,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching images:', error);
    res.status(500).json({ error: 'Failed to fetch images' });
  }
});
// Like an image
router.post('/:id/like', auth, async (req, res) => {
  try {
    const image = await Image.findById(req.params.id);
    
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    // Check if user already liked the image
    const alreadyLiked = image.likes.some(like => 
      like.toString() === req.userId.toString()
    );

    if (alreadyLiked) {
      return res.status(400).json({ error: 'Already liked' });
    }

    // Add like
    image.likes.push(req.userId);
    image.likesCount = image.likes.length;
    
    await image.save();

    res.json({ 
      message: 'Image liked successfully',
      likesCount: image.likesCount 
    });
  } catch (error) {
    console.error('Error liking image:', error);
    res.status(500).json({ error: error.message });
  }
});

// Unlike an image
router.delete('/:id/like', auth, async (req, res) => {
  try {
    const image = await Image.findById(req.params.id);
    
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    // Remove like
    image.likes = image.likes.filter(like => 
      like.toString() !== req.userId.toString()
    );
    image.likesCount = image.likes.length;
    
    await image.save();

    res.json({ 
      message: 'Image unliked successfully',
      likesCount: image.likesCount 
    });
  } catch (error) {
    console.error('Error unliking image:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check if user liked an image
router.get('/:id/liked', auth, async (req, res) => {
  try {
    const image = await Image.findById(req.params.id);
    
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    const liked = image.likes.some(like => 
      like.toString() === req.userId.toString()
    );

    res.json({ liked });
  } catch (error) {
    console.error('Error checking like:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;