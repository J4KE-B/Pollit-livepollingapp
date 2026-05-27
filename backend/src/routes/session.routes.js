const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const ctrl = require('../controllers/sessionController');
const pollCtrl = require('../controllers/pollController');

router.use(auth);

router.post('/', ctrl.createSession);
router.get('/all', ctrl.getAllSessions);
router.get('/', ctrl.getMySessions);
router.get('/:id', ctrl.getSessionById);
router.put('/:id', ctrl.updateSession);
router.delete('/:id', ctrl.deleteSession);
router.get('/:id/results', ctrl.getSessionResults);

// Lifecycle
router.post('/:id/start', pollCtrl.startSession);
router.post('/:id/next', pollCtrl.nextPoll);
router.post('/:id/end', pollCtrl.endSession);

module.exports = router;
