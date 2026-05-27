const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const ctrl = require('../controllers/userController');

router.use(auth);

router.get('/all', ctrl.getAllUsers);

module.exports = router;
