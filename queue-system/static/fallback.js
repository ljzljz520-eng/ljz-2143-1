/* 海报背景降级策略（纯函数，可被 Node 单测直接引用）。
 *
 * 双保险：
 * 1) CSS 多层背景：海报为第一层、渐变兜底为第二层——海报解码失败时
 *    浏览器自动只渲染下层，无需任何 JS；
 * 2) JS 探测：Image 解码失败时给 body 加 .poster-failed，进一步提高
 *    号码面板不透明度并提示运维。号码面板始终使用近实色底 + 高对比文字，
 *    背景如何降级都不影响号码可读。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PosterFallback = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  const FALLBACK_GRADIENT =
    "linear-gradient(135deg, #0f2027, #203a43, #2c5364)";
  return {
    FALLBACK_GRADIENT,
    // 多层背景：海报在上、渐变兜底
    backgroundLayers(posterUrl) {
      return `url("${posterUrl}"), ${FALLBACK_GRADIENT}`;
    },
    // 探测结果 → DOM class；返回是否已降级
    applyProbeResult(ok, classList) {
      if (ok) classList.remove("poster-failed");
      else classList.add("poster-failed");
      return !ok;
    },
  };
});
