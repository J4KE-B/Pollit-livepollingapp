const express = require('express');
const router = express.Router();
const { register, login, googleLogin, adminLogin } = require('../controllers/authController');

router.post('/register', register);
router.post('/login', login);
router.post('/google', googleLogin);
router.post('/admin-login', adminLogin);

module.exports = router;
