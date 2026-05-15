const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/pollController');

router.get('/:code', ctrl.joinByCode);
router.post('/:code/vote', ctrl.submitVote);

module.exports = router;
