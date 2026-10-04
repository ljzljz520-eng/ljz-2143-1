'use strict';
/**
 * 业务时钟：决定“业务日期”(biz_date)。
 * 号码按 biz_date 每日重置；票据 UUID 跨日稳定。
 * 测试可通过 QUEUE_TEST_HOOKS=1 挂载 /api/_test/clock 覆盖日期，用于验收“午夜仍有人等待”。
 */
let overrideDate = null; // 'YYYY-MM-DD' 或 null

function pad(n) { return String(n).padStart(2, '0'); }

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

module.exports = {
  bizDate() { return overrideDate || today(); },
  nowIso() { return new Date().toISOString(); },
  // 仅测试钩子可调用
  _setBizDate(d) { overrideDate = d; },
  _getOverride() { return overrideDate; },
};
