'use strict';
const path = require('path');
const express = require('express');
const dbModule = require('./db');
const clock = require('./clock');
const Q = require('./queue');

function createApp({ dbPath } = {}) {
  const db = dbModule.open(dbPath);
  dbModule.seedCounters(db);
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const wrap = fn => (req, res, next) => {
    try { res.json(fn(req)); } catch (e) { next(e); }
  };

  /* 页面入口 */
  app.get('/', (req, res) => res.redirect('/display.html'));

  /* 领号（集中分配，需在线） */
  app.post('/api/tickets', wrap(req => Q.issueTicket(db, { idemKey: req.body && req.body.idemKey })));
  app.get('/api/tickets', wrap(req => ({ tickets: Q.listTickets(db, { status: req.query.status }) })));

  /* 柜台 */
  app.get('/api/counters', wrap(() => ({ counters: Q.displayState(db).counters })));
  app.post('/api/counters/:id/call-next', wrap(req =>
    Q.callNext(db, { counterId: req.params.id, idemKey: req.body && req.body.idemKey })));
  app.post('/api/counters/:id/pause', wrap(req =>
    Q.setCounterStatus(db, { counterId: req.params.id, idemKey: req.body && req.body.idemKey, status: 'paused' })));
  app.post('/api/counters/:id/resume', wrap(req =>
    Q.setCounterStatus(db, { counterId: req.params.id, idemKey: req.body && req.body.idemKey, status: 'open' })));
  app.post('/api/counters/:id/complete', wrap(req =>
    Q.completeCurrent(db, { counterId: req.params.id, idemKey: req.body && req.body.idemKey })));
  app.post('/api/counters/:id/recall', wrap(req =>
    Q.recallCurrent(db, { counterId: req.params.id, idemKey: req.body && req.body.idemKey })));

  /* 展示窗 */
  app.get('/api/display/state', wrap(() => Q.displayState(db)));

  /* 指令生命周期 */
  app.post('/api/commands/:id/ack', wrap(req =>
    Q.ackCommand(db, { commandId: req.params.id, terminalId: req.body && req.body.terminalId })));
  app.post('/api/commands/:id/confirm', wrap(req =>
    Q.confirmCommand(db, { commandId: req.params.id, actor: req.body && req.body.actor })));
  app.post('/api/commands/:id/replay', wrap(req =>
    Q.replayCommand(db, { commandId: req.params.id, idemKey: req.body && req.body.idemKey, actor: req.body && req.body.actor })));

  /* 管理端 */
  app.get('/api/admin/overview', wrap(() => Q.displayState(db)));
  app.get('/api/admin/commands', wrap(req => ({
    commands: Q.adminCommands(db, { status: req.query.status, pending: req.query.pending }),
  })));

  /* 测试钩子：仅 QUEUE_TEST_HOOKS=1 时挂载（验收：午夜跨日、海报解码失败） */
  if (process.env.QUEUE_TEST_HOOKS === '1') {
    app.post('/api/_test/clock', (req, res) => {
      clock._setBizDate(req.body && req.body.date || null);
      res.json({ bizDate: clock.bizDate() });
    });
    app.get('/api/_test/corrupt-poster', (req, res) => {
      // 内容类型声称是图片，字节却是垃圾：模拟海报解码失败
      res.type('image/png').send(Buffer.from('corrupted-poster-bytes!!not-an-image'));
    });
  }

  /* 统一错误格式 */
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    res.status(status).json({ error: { code: err.code || 'INTERNAL', message: err.message } });
  });

  return { app, db };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const { app } = createApp();
  app.listen(port, () => {
    console.log(`叫号系统已启动: http://localhost:${port}`);
    console.log(`  展示窗  /display.html   柜台端 /counter.html   管理页 /admin.html`);
  });
}

module.exports = { createApp };
